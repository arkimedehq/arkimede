// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file api-key.util.ts
 *
 * Pure helpers for opaque API keys. Kept side-effect free for unit testing.
 *
 * Format: `ak_<base64url(32 random bytes)>` — the `ak_` prefix lets the auth
 * guard route Bearer credentials cheaply (API-key lookup vs JWT verification)
 * without ambiguity: no JWT starts with `ak_`.
 *
 * Storage: only the SHA-256 hash of the full key is persisted. The clear key
 * is returned ONCE at creation; the stored `prefix` (first chars) exists only
 * so the UI can identify keys ("ak_3fk9…") without exposing them.
 */
import { createHash, randomBytes } from 'node:crypto';

export const API_KEY_PREFIX = 'ak_';
/** Chars of the key shown in listings to identify it (includes the prefix). */
export const API_KEY_DISPLAY_CHARS = 10;

/** Generates a new clear API key. */
export function generateApiKey(): string {
  return `${API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/** True when the Bearer credential is an API key (vs a JWT). */
export function looksLikeApiKey(token: string | undefined | null): boolean {
  return typeof token === 'string' && token.startsWith(API_KEY_PREFIX);
}

/** Deterministic hash persisted in place of the key. */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** Display prefix stored alongside the hash (identification only). */
export function apiKeyPrefix(key: string): string {
  return key.slice(0, API_KEY_DISPLAY_CHARS);
}

/** True when the key row is past its expiry (null = never expires). */
export function isApiKeyExpired(expiresAt: Date | null, nowMs = Date.now()): boolean {
  return expiresAt != null && new Date(expiresAt).getTime() <= nowMs;
}
