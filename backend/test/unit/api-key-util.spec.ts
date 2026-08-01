// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Opaque API-key helpers: format, prefix routing (ak_ vs JWT), hashing
 * stability and expiry semantics. These invariants back the auth guard's
 * credential disambiguation — a regression here silently breaks either key
 * auth or JWT auth for everyone.
 */
import { describe, expect, it } from 'vitest';
import {
  API_KEY_PREFIX, apiKeyPrefix, generateApiKey, hashApiKey,
  isApiKeyExpired, looksLikeApiKey,
} from '../../src/api-keys/api-key.util';

describe('generateApiKey', () => {
  it('produces unique ak_-prefixed url-safe keys', () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a).toMatch(/^ak_[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });
});

describe('looksLikeApiKey — credential routing', () => {
  it('recognizes generated keys and rejects JWTs/null', () => {
    expect(looksLikeApiKey(generateApiKey())).toBe(true);
    // A JWT starts with the base64 of {"alg": … → "eyJ", never "ak_".
    expect(looksLikeApiKey('eyJhbGciOiJIUzI1NiJ9.x.y')).toBe(false);
    expect(looksLikeApiKey(undefined)).toBe(false);
    expect(looksLikeApiKey('')).toBe(false);
  });
});

describe('hashApiKey / apiKeyPrefix', () => {
  it('hash is deterministic, hex, and never contains the key', () => {
    const key = generateApiKey();
    const h = hashApiKey(key);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiKey(key)).toBe(h);
    expect(h).not.toContain(key.slice(3, 10));
  });

  it('prefix keeps the ak_ marker and stays short', () => {
    const key = generateApiKey();
    expect(apiKeyPrefix(key).startsWith(API_KEY_PREFIX)).toBe(true);
    expect(apiKeyPrefix(key).length).toBeLessThanOrEqual(16);
  });
});

describe('isApiKeyExpired', () => {
  it('null never expires; past expires; future does not', () => {
    const now = Date.now();
    expect(isApiKeyExpired(null, now)).toBe(false);
    expect(isApiKeyExpired(new Date(now - 1000), now)).toBe(true);
    expect(isApiKeyExpired(new Date(now + 1000), now)).toBe(false);
  });
});
