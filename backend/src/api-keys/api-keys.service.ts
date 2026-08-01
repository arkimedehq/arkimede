// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file api-keys.service.ts
 *
 * Lifecycle and validation of the opaque API keys (see api-key.entity.ts).
 * `validate()` is on the hot path of every Bearer request carrying an `ak_`
 * credential: one indexed lookup by hash + the owner reload (same guarantee as
 * the JWT strategy: a disabled account is cut off at the next request).
 */
import { ForbiddenException, Injectable, Logger, NotFoundException, Optional, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { User } from '../users/users.entity';
import { ApiKey } from './api-key.entity';
import { apiKeyPrefix, generateApiKey, hashApiKey, isApiKeyExpired } from './api-key.util';

/** Public row shape (never contains the hash). */
export interface ApiKeyView {
  id: string;
  userId: string;
  name: string;
  prefix: string;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

/** lastUsedAt is refreshed at most once per minute (avoids a write per request). */
const LAST_USED_THROTTLE_MS = 60_000;

@Injectable()
export class ApiKeysService {
  private readonly logger = new Logger(ApiKeysService.name);

  constructor(
    @InjectRepository(ApiKey)
    private readonly keyRepo: Repository<ApiKey>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @Optional() private readonly audit?: AuditService,
  ) {}

  private toView(k: ApiKey): ApiKeyView {
    const { keyHash: _hash, user: _user, ...view } = k;
    return view;
  }

  /** Keys of a user (no secrets). */
  async list(userId: string): Promise<ApiKeyView[]> {
    const rows = await this.keyRepo.find({ where: { userId }, order: { createdAt: 'DESC' } });
    return rows.map((k) => this.toView(k));
  }

  /**
   * Creates a key for `userId`. Returns the CLEAR key — the only moment it
   * exists outside the caller's hands. `expiresInDays` null/0 = never expires.
   */
  async create(
    userId: string,
    name: string,
    expiresInDays: number | null,
    actorId: string,
  ): Promise<{ key: string; row: ApiKeyView }> {
    const owner = await this.userRepo.findOne({ where: { id: userId }, select: { id: true } });
    if (!owner) throw new NotFoundException(`User "${userId}" not found`);

    const trimmed = (name ?? '').trim();
    if (!trimmed) throw new ForbiddenException('API key name is required');

    const key = generateApiKey();
    const days = Number(expiresInDays);
    const row = await this.keyRepo.save({
      userId,
      name: trimmed.slice(0, 120),
      keyHash: hashApiKey(key),
      prefix: apiKeyPrefix(key),
      expiresAt: Number.isFinite(days) && days > 0
        ? new Date(Date.now() + days * 86_400_000)
        : null,
    });
    this.logger.log(`API key created for user ${userId} (${row.prefix}…, expires: ${row.expiresAt?.toISOString() ?? 'never'})`);
    await this.audit?.record({
      actorId, action: 'apikey.create', resource: row.id,
      outcome: 'ok', ctx: { keyId: row.id, ownerId: userId, prefix: row.prefix, expiresAt: row.expiresAt },
    });
    return { key, row: this.toView(row) };
  }

  /** Revokes (deletes) a key. Owner or admin only — enforced by the caller. */
  async revoke(id: string, userId: string, isAdmin: boolean, actorId: string): Promise<void> {
    const row = await this.keyRepo.findOne({ where: { id } });
    if (!row || (!isAdmin && row.userId !== userId)) {
      throw new NotFoundException(`API key "${id}" not found`);
    }
    await this.keyRepo.delete(row.id);
    this.logger.log(`API key revoked: ${row.prefix}… (owner ${row.userId})`);
    await this.audit?.record({
      actorId, action: 'apikey.revoke', resource: row.id,
      outcome: 'ok', ctx: { keyId: row.id, ownerId: row.userId, prefix: row.prefix },
    });
  }

  /**
   * Validates a clear `ak_…` credential → the owner's request identity, or
   * throws UnauthorizedException (unknown/expired key, disabled owner).
   */
  async validate(clearKey: string): Promise<{ id: string; email: string; role: string }> {
    const row = await this.keyRepo.findOne({ where: { keyHash: hashApiKey(clearKey) } });
    if (!row) throw new UnauthorizedException('Invalid API key');
    if (isApiKeyExpired(row.expiresAt)) throw new UnauthorizedException('API key expired');

    const user = await this.userRepo.findOne({
      where: { id: row.userId },
      select: { id: true, email: true, role: true, status: true },
    });
    if (!user || user.status === 'disabled') throw new UnauthorizedException('Invalid API key');

    const now = Date.now();
    if (!row.lastUsedAt || now - new Date(row.lastUsedAt).getTime() > LAST_USED_THROTTLE_MS) {
      // Fire-and-forget: the request must not pay for the bookkeeping write.
      void this.keyRepo.update(row.id, { lastUsedAt: new Date(now) }).catch(() => undefined);
    }
    return { id: user.id, email: user.email, role: user.role };
  }
}
