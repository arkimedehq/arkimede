// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { ExecutionContext, Injectable, Optional } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiKeysService } from '../../api-keys/api-keys.service';
import { looksLikeApiKey } from '../../api-keys/api-key.util';

/**
 * Bearer authentication for the whole API. Two credential kinds share the
 * header, disambiguated by prefix (no JWT can start with `ak_`):
 *   - `ak_…`  → opaque API key: validated by ApiKeysService (hash lookup +
 *               owner reload — a revoked key or disabled owner is cut off at
 *               the next request);
 *   - anything else → JWT via the passport strategy (historical behavior).
 * Both paths attach the same `{ id, email, role }` request identity.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(@Optional() private readonly apiKeys?: ApiKeysService) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const header: string | undefined = request?.headers?.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;

    if (looksLikeApiKey(token) && this.apiKeys) {
      request.user = await this.apiKeys.validate(token!); // throws 401 when invalid
      return true;
    }
    return super.canActivate(context) as Promise<boolean>;
  }
}
