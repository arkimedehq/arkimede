// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file plugin-trust.ts
 *
 * Who published a plugin package (specs/PLUGINS.md §11): an ed25519 signature over the SHA-256 of the ZIP, checked
 * against the trusted keys — `official` from the environment (`PLUGIN_TRUSTED_KEYS`, a JSON list), `verified` and
 * `community` added by the admin. The plugin's level is the level of the key that verifies it; with no valid signature
 * it is `unsigned`. A signature says who published the package, not that it is harmless.
 *
 * Also the two plugin credentials, each signed with its own key derived from RUN_TOKEN_SECRET — so neither is ever
 * accepted where an internal token is (InternalTokenGuard), nor one where the other is:
 *   - the plugin token (`PLUGIN_TOKEN`): the plugin and its token version; valid only on /internal/plugins/*;
 *   - the page token: a plugin page for one user, for an hour, in the path of the iframe's files.
 */
import { createHash, createHmac, createPublicKey, timingSafeEqual, verify as verifySignature, KeyObject } from 'crypto';

export type TrustLevel = 'official' | 'verified' | 'community' | 'unsigned';
export const TRUST_LEVELS: TrustLevel[] = ['official', 'verified', 'community', 'unsigned'];

export interface TrustedKey {
  id: string;
  level: Exclude<TrustLevel, 'unsigned'>;
  /** ed25519 public key: base64 of the 32 raw bytes, or PEM. */
  publicKey: string;
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function keyObject(publicKey: string): KeyObject {
  const k = publicKey.trim();
  if (k.includes('BEGIN PUBLIC KEY')) return createPublicKey(k);
  const raw = Buffer.from(k, 'base64');
  if (raw.length !== 32) throw new Error('an ed25519 public key is 32 bytes');
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

/** Whether a public key can be read (for the admin's form). */
export function validPublicKey(publicKey: string): boolean {
  try {
    return keyObject(publicKey).asymmetricKeyType === 'ed25519';
  } catch {
    return false;
  }
}

/** The official keys from the environment; malformed entries are left out. */
export function officialKeys(env = process.env.PLUGIN_TRUSTED_KEYS): TrustedKey[] {
  if (!env?.trim()) return [];
  try {
    const list = JSON.parse(env);
    return (Array.isArray(list) ? list : [])
      .filter((k) => k && typeof k.id === 'string' && typeof k.publicKey === 'string' && validPublicKey(k.publicKey))
      .map((k) => ({ id: k.id, level: 'official' as const, publicKey: k.publicKey }));
  } catch {
    return [];
  }
}

/**
 * The trust level of a package: the best level among the keys whose signature (base64) verifies its SHA-256 (hex).
 * With `keyId` only that key is tried.
 */
export function trustOf(sha256: string, signature: string | null | undefined, keys: TrustedKey[], keyId?: string | null): { level: TrustLevel; keyId: string | null } {
  if (!signature?.trim()) return { level: 'unsigned', keyId: null };
  let sig: Buffer;
  try {
    sig = Buffer.from(signature.trim(), 'base64');
  } catch {
    return { level: 'unsigned', keyId: null };
  }
  const data = Buffer.from(sha256, 'hex');
  const candidates = keys
    .filter((k) => !keyId || k.id === keyId)
    .sort((a, b) => TRUST_LEVELS.indexOf(a.level) - TRUST_LEVELS.indexOf(b.level));
  for (const k of candidates) {
    try {
      if (verifySignature(null, data, keyObject(k.publicKey), sig)) return { level: k.level, keyId: k.id };
    } catch {
      /* a malformed key or signature verifies nothing */
    }
  }
  return { level: 'unsigned', keyId: null };
}

// ─── Credentials ──────────────────────────────────────────────────────────────

function derivedKey(purpose: string): Buffer {
  const secret = (process.env.RUN_TOKEN_SECRET || '').trim();
  if (!secret) throw new Error('RUN_TOKEN_SECRET not configured');
  return createHmac('sha256', secret).update(`arkimede-plugin:${purpose}`).digest();
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

function signParts(purpose: string, payload: object): string {
  const body = b64url(JSON.stringify(payload));
  return `${body}.${b64url(createHmac('sha256', derivedKey(purpose)).update(body).digest())}`;
}

function readParts<T>(purpose: string, token: string | undefined | null): T | null {
  if (!token || typeof token !== 'string') return null;
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return null;
  let expected: Buffer;
  try {
    expected = createHmac('sha256', derivedKey(purpose)).update(body).digest();
  } catch {
    return null;
  }
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && Math.floor(Date.now() / 1000) >= payload.exp) return null;
    return payload as T;
  } catch {
    return null;
  }
}

export interface PluginTokenClaims {
  /** The plugin's id. */
  pid: string;
  /** Its token version: disabling or updating the plugin bumps it, and the old tokens stop working. */
  v: number;
  exp?: number;
}

/** The plugin's token for its scripts and daemons (no expiry: revoked by the token version). */
export function mintPluginToken(pluginId: string, version: number, ttlMs?: number): string {
  return signParts('token', { pid: pluginId, v: version, ...(ttlMs ? { exp: Math.floor((Date.now() + ttlMs) / 1000) } : {}) });
}

export function readPluginToken(token: string | undefined | null): PluginTokenClaims | null {
  const c = readParts<PluginTokenClaims>('token', token);
  return c && typeof c.pid === 'string' && typeof c.v === 'number' ? c : null;
}

export interface PageTokenClaims {
  pid: string;
  uid: string;
  exp: number;
}

export const PAGE_TOKEN_TTL_MS = 60 * 60_000;

/** A plugin's pages for one user, for an hour: it is in the path of the iframe's files. */
export function mintPageToken(pluginId: string, userId: string): string {
  return signParts('page', { pid: pluginId, uid: userId, exp: Math.floor((Date.now() + PAGE_TOKEN_TTL_MS) / 1000) });
}

export function readPageToken(token: string | undefined | null): PageTokenClaims | null {
  const c = readParts<PageTokenClaims>('page', token);
  return c && typeof c.pid === 'string' && typeof c.uid === 'string' && typeof c.exp === 'number' ? c : null;
}
