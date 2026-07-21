/**
 * M7 + M8 verification — boots ONLY the AuthController with the real ThrottlerModule
 * and helmet (AuthService mocked, no DB), then exercises the HTTP surface:
 *  - M7: the strict per-IP @Throttle on /api/auth/login returns 429 past the limit.
 *  - M8: helmet security headers are present on responses.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import type { INestApplication } from '@nestjs/common';
import helmet from 'helmet';
import request from 'supertest';
import { AuthController } from '../../src/auth/auth.controller';
import { AuthService } from '../../src/auth/auth.service';

let app: INestApplication;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }])],
    controllers: [AuthController],
    providers: [{ provide: AuthService, useValue: { login: async () => ({ token: 't' }), register: async () => ({ token: 't' }) } }],
  }).compile();

  app = moduleRef.createNestApplication();
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false, crossOriginEmbedderPolicy: false }));
  await app.init();
});

afterAll(async () => { await app?.close(); });

const login = () => request(app.getHttpServer()).post('/api/auth/login').send({ email: 'a@b.com', password: 'secret' });

describe('auth hardening (M7 rate limit, M8 headers)', () => {
  it('sets helmet security headers', async () => {
    const res = await login();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBeDefined();
  });

  it('rate-limits login past the per-IP limit (429)', async () => {
    // The route allows 10/min; the header check above already consumed 1.
    let sawThrottled = false;
    for (let i = 0; i < 15; i++) {
      const res = await login();
      if (res.status === 429) { sawThrottled = true; break; }
    }
    expect(sawThrottled).toBe(true);
  });
});
