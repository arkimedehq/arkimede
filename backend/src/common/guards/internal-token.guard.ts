import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';

import {
  verifyInternalToken, internalTokenConfigured, InternalTokenError, InternalTokenClaims,
} from '../internal-token/internal-token';

/**
 * Guard for the internal endpoints (`/internal/*`), based on signed tokens.
 *
 * Verifies the `x-internal-token` header (HMAC token minted by the backend) and
 * populates `request.internalAuth` with the claims. It does NOT perform scope/resource
 * checks: those are up to the controller/service (e.g. `resolveDataSource(id, userId)`
 * or verifying that the daemon is alive), which read `request.internalAuth`.
 *
 * Fail-closed: missing/invalid/expired token → 401; secret not configured → 401.
 */
@Injectable()
export class InternalTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (!internalTokenConfigured()) {
      throw new UnauthorizedException('guards.internalKeyNotConfigured');
    }
    const request = context.switchToHttp().getRequest();
    const token = request.headers['x-internal-token'];

    let claims: InternalTokenClaims;
    try {
      claims = verifyInternalToken(token);
    } catch (err) {
      if (err instanceof InternalTokenError) {
        throw new UnauthorizedException('guards.internalKeyInvalid');
      }
      throw err;
    }

    request.internalAuth = claims;
    return true;
  }
}

/** Helper to read the run's identity in the controllers (`request.internalAuth.sub`). */
export function internalUserId(request: { internalAuth?: { sub?: string } }): string {
  return request.internalAuth?.sub ?? '';
}
