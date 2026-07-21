import { ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

/**
 * Guard for GET /api/files/stream (streaming/inline viewing of a file).
 *
 * Accepts TWO forms of authentication, as alternatives:
 *
 *  1. **Bearer JWT** (Authorization header) → delegates to JwtAuthGuard.
 *
 *  2. **Signed token in query** (`?token=...`) → allows DIRECT browser navigation
 *     to the URL (e.g. `<video src>` or a new tab), where the Authorization header
 *     is NOT available. Enables progressive native streaming (Range requests)
 *     without downloading the whole file.
 *
 * The token is a short-lived JWT signed with JWT_SECRET, with `scope:
 * 'file-stream'` and BOUND to the (`source`, `path`) pair: it is valid only for that
 * file and only until it expires. Issued by GET /api/files/stream-token (JWT authenticated).
 */
@Injectable()
export class FileStreamAccessGuard extends JwtAuthGuard {
  constructor(private readonly jwt: JwtService) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const token = req.query?.token;

    if (typeof token === 'string' && token.length > 0) {
      let payload: any;
      try {
        payload = this.jwt.verify(token);
      } catch {
        throw new UnauthorizedException('files.streamTokenInvalid');
      }
      // The token must have the right scope and have been issued for THIS resource.
      if (
        payload?.scope !== 'file-stream' ||
        payload?.source !== req.query?.source ||
        payload?.path !== req.query?.path
      ) {
        throw new UnauthorizedException('files.streamTokenInvalid');
      }
      // Identity derived from the token: the user who requested the stream.
      req.user = { id: payload.sub };
      return true;
    }

    // No token in query → standard Bearer JWT authentication.
    return (await super.canActivate(context)) as boolean;
  }
}
