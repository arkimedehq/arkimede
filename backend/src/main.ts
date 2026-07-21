import {setMaxListeners} from 'events';
import {NestFactory} from '@nestjs/core';
import {ValidationPipe} from '@nestjs/common';
import {DocumentBuilder, SwaggerModule} from '@nestjs/swagger';
import * as bodyParser from 'body-parser';
import helmet from 'helmet';
import {IoAdapter} from '@nestjs/platform-socket.io';
import {AppModule} from './app.module';
import {APP_NAME} from './config/app.config';
import {assertEncryptionKey} from './custom-tools/crypto.utils';
import {assertJwtSecret} from './config/security.util';
import {I18nExceptionFilter} from './common/i18n-exception.filter';

// LangChain + Anthropic SDK add abort listeners for each step of the ReAct loop.
// With 6 tools the default of 10 is exceeded — we raise the global limit.
setMaxListeners(30);

/**
 * Socket.IO adapter with a raised frame-size limit (engine-wide, all namespaces).
 * The default maxHttpBufferSize (1 MB) makes the server DROP the connection on
 * the first oversized frame: MCP bridge tool results can carry multi-MB payloads
 * (e.g. base64 screenshots) and were killing the bridge socket. Oversized binary
 * content is then sanitized before reaching the LLM (McpServersService).
 */
class AppIoAdapter extends IoAdapter {
  createIOServer(port: number, options?: any): any {
    return super.createIOServer(port, { ...options, maxHttpBufferSize: 32 * 1024 * 1024 });
  }
}

async function bootstrap() {
  // Fail-fast: without a valid TOOL_SECRETS_KEY (hex-64) the secrets cannot be
  // encrypted/decrypted securely → the app must not even start.
  assertEncryptionKey();
  // Likewise for JWT_SECRET: without a strong secret (≥32 chars, not a placeholder) the
  // session tokens would be forgeable → fail-fast at startup.
  assertJwtSecret();

  // cors is NOT passed to NestFactory.create — configured below with enableCors().
  // Double configuration (cors:true + enableCors) causes duplicate headers → the browser rejects it.
  const app = await NestFactory.create(AppModule);

  // Security headers (HSTS, X-Content-Type-Options: nosniff, X-Frame-Options,
  // Referrer-Policy, …). CSP is left OFF here: this process serves a JSON API plus
  // the Swagger UI (whose inline assets a strict CSP would break) — the browser CSP
  // belongs on the frontend (nginx). CORP/COEP are relaxed so the SPA on another
  // origin can consume the API and stream/download files.
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: false,
    crossOriginEmbedderPolicy: false,
  }));

  // Increase the body limit for the internal endpoints that receive batches of vectors/items.
  // Express's default (100KB) is too low for batches of 200+ items with a JSON payload.
  app.use(bodyParser.json({ limit: '20mb' }));
  app.use(bodyParser.urlencoded({ extended: true, limit: '20mb' }));

  // Enable Socket.IO for the MCP bridge (raised frame-size limit, see AppIoAdapter)
  app.useWebSocketAdapter(new AppIoAdapter(app));

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  // Translates the error messages expressed as an i18n key (prefix 'errors.').
  app.useGlobalFilters(new I18nExceptionFilter());

  // FRONTEND_URL can be a comma-separated list for multiple environments:
  //   e.g. "http://localhost:5173,http://localhost:4173"
  // In production it is MANDATORY: `origin:'*'` with `credentials:true` would expose
  // the sessions to any origin → fail-fast if missing.
  const rawFrontend = (process.env.FRONTEND_URL || '').trim();
  if (!rawFrontend && process.env.NODE_ENV === 'production') {
    throw new Error(
      'FRONTEND_URL is required in production: CORS cannot use "*" together with credentials. Set the allowed origins (comma-separated).',
    );
  }
  const allowedOrigins = (rawFrontend || '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  app.enableCors({
    origin:         allowedOrigins.length === 1 ? allowedOrigins[0] : allowedOrigins,
    methods:        ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials:    true,
  });

  // Swagger UI (full API schema) is served only outside production, unless
  // explicitly enabled — avoids handing an attacker the API map in prod.
  const swaggerEnabled = process.env.NODE_ENV !== 'production' || process.env.ENABLE_SWAGGER === 'true';
  if (swaggerEnabled) {
    const config = new DocumentBuilder()
      .setTitle(`${APP_NAME} API`)
      .setDescription(`Backend per ${APP_NAME}`)
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);
  }

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`🚀 ${APP_NAME} backend running at http://localhost:${port}`);
  if (swaggerEnabled) console.log(`📖 Swagger at http://localhost:${port}/api/docs`);
}
bootstrap();
