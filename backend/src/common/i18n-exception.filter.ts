/**
 * @file i18n-exception.filter.ts
 *
 * Global filter that translates HttpException messages when they are expressed
 * as an **i18n key** (prefix `errors.`). Pattern:
 *
 *   throw new ConflictException('errors.emailTaken');
 *
 * → the filter resolves `errors.emailTaken` in the request's language (header
 *   `Accept-Language`, resolved by nestjs-i18n) and returns the translated message.
 *
 * NON-key messages (class-validator validation, free strings, errors already
 * translated at throw-time via I18nContext) pass through unchanged.
 *
 * For errors with interpolation, translate on the fly at throw-time:
 *   throw new NotFoundException(I18nContext.current()!.t('errors.toolNotFound', { args: { name } }));
 */
import {
  ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger,
} from '@nestjs/common';
import { I18nContext } from 'nestjs-i18n';

@Catch(HttpException)
export class I18nExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(I18nExceptionFilter.name);

  catch(exception: HttpException, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse();
    const status = exception.getStatus();
    const i18n = I18nContext.current(host);

    const raw = exception.getResponse() as any;

    // A message is an i18n key if it has the form `namespace.key` (no spaces,
    // at least one dot). Free messages (phrases with spaces) or non-existent keys
    // (i18n.t returns the key unchanged) pass through unchanged → safe.
    const KEY_SHAPE = /^[a-zA-Z][\w]*(\.[\w]+)+$/;
    const translate = (m: unknown): unknown => {
      if (typeof m === 'string' && i18n && KEY_SHAPE.test(m)) {
        const out = i18n.t(m);
        return out === m ? m : out;
      }
      return m;
    };

    let body: any;
    if (typeof raw === 'string') {
      body = { statusCode: status, message: translate(raw) };
    } else {
      const message = Array.isArray(raw.message) ? raw.message.map(translate) : translate(raw.message);
      body = { ...raw, message };
    }

    res.status(status).json(body);
  }
}
