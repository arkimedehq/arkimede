/**
 * @file internal-token.ts
 *
 * Signed internal tokens (HMAC-SHA256, compact JWT format) to authenticate
 * service-to-service calls to the `/internal/*` endpoints.
 *
 * Replaces the old `INTERNAL_API_KEY` (shared bearer secret, injected into every
 * script → forgeable as an identity). Here the signing secret lives ONLY in the
 * backend: the executor and the scripts receive and forward an *opaque token* that
 * they cannot forge.
 *
 * A single secret signs all tokens; the `typ` claim discriminates the context:
 *   - run    → execution of a skill script, on behalf of `sub` (userId)
 *   - daemon → long-running process, tied to `did` (daemonId) + `sub`
 *   - system → internal job with no user identity (fail-closed on scoped resources)
 *
 * Future-proofing already provided for in the schema:
 *   - `kid`  → key id: secret rotation via keyring (current + previous)
 *   - `ver`  → format version
 *   - `cap`  → (reserved) specific capabilities/resources for future least-privilege
 */
import {
  createHmac, timingSafeEqual, randomUUID,
} from 'crypto';

export type InternalTokenType = 'run' | 'daemon' | 'system';

/** Current version of the payload format. */
const TOKEN_VER = 1;
/** kid of the current (signing) secret. The previous ones remain verifiable. */
const CURRENT_KID = 'v1';

export interface InternalTokenClaims {
  /** Context type. */
  typ: InternalTokenType;
  /** Identity (userId) the context runs for. Missing/'' = no scoped access. */
  sub?: string;
  /** daemonId (only typ='daemon'). */
  did?: string;
  /** unique token id (anti-replay / log correlation). */
  jti: string;
  /** issued-at (epoch seconds). */
  iat: number;
  /** expiry (epoch seconds). Missing = no expiry (e.g. daemon, revoked via alive state). */
  exp?: number;
  /** format version. */
  ver: number;
  /** (reserved) capabilities/resources — future least-privilege. */
  cap?: string[];
}

// ─── Keyring (rotation via kid) ─────────────────────────────────────────────────

/** Map kid → secret. The current one signs; the previous ones only verify. */
function keyring(): Map<string, string> {
  const m = new Map<string, string>();
  const cur = (process.env.RUN_TOKEN_SECRET || '').trim();
  const prev = (process.env.RUN_TOKEN_SECRET_PREV || '').trim();
  if (cur) m.set(CURRENT_KID, cur);
  if (prev) m.set('v0', prev);
  return m;
}

function secretFor(kid: string): string {
  const s = keyring().get(kid);
  if (!s) throw new Error(`internal-token: unknown kid or secret not configured (${kid})`);
  return s;
}

// ─── base64url ───────────────────────────────────────────────────────────────

function b64urlEncode(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function sign(headerB64: string, payloadB64: string, secret: string): string {
  return b64urlEncode(
    createHmac('sha256', secret).update(`${headerB64}.${payloadB64}`).digest(),
  );
}

// ─── Mint ──────────────────────────────────────────────────────────────────────

/** True if at least one signing secret is configured. */
export function internalTokenConfigured(): boolean {
  return keyring().size > 0;
}

function mint(
  partial: Omit<InternalTokenClaims, 'jti' | 'iat' | 'ver'>,
  ttlMs?: number,
): string {
  if (!internalTokenConfigured()) {
    throw new Error('internal-token: RUN_TOKEN_SECRET not configured');
  }
  const now = Math.floor(Date.now() / 1000);
  const claims: InternalTokenClaims = {
    ...partial,
    jti: randomUUID(),
    iat: now,
    ver: TOKEN_VER,
    ...(ttlMs && ttlMs > 0 ? { exp: now + Math.ceil(ttlMs / 1000) } : {}),
  };
  const header = { alg: 'HS256', typ: 'JWT', kid: CURRENT_KID };
  const headerB64 = b64urlEncode(JSON.stringify(header));
  const payloadB64 = b64urlEncode(JSON.stringify(claims));
  const sig = sign(headerB64, payloadB64, secretFor(CURRENT_KID));
  return `${headerB64}.${payloadB64}.${sig}`;
}

/** Token for a skill execution, on behalf of `userId`. Short TTL (= run timeout). */
export function mintRunToken(userId: string, ttlMs = 60_000): string {
  return mint({ typ: 'run', sub: userId || '' }, ttlMs);
}

/** Token for a daemon. No expiry: revocation happens via the daemon's alive state. */
export function mintDaemonToken(userId: string, daemonId: string): string {
  return mint({ typ: 'daemon', sub: userId || '', did: daemonId });
}

/** Token for internal jobs with no user identity. Fail-closed on scoped resources. */
export function mintSystemToken(ttlMs = 60_000): string {
  return mint({ typ: 'system' }, ttlMs);
}

// ─── Verify ──────────────────────────────────────────────────────────────────

export class InternalTokenError extends Error {}

/** Verifies signature, format and expiry. Returns the claims or throws InternalTokenError. */
export function verifyInternalToken(token: string): InternalTokenClaims {
  if (!token || typeof token !== 'string') {
    throw new InternalTokenError('token missing');
  }
  const parts = token.split('.');
  if (parts.length !== 3) throw new InternalTokenError('invalid token format');
  const [headerB64, payloadB64, sigB64] = parts;

  let header: { alg?: string; kid?: string };
  try {
    header = JSON.parse(b64urlDecode(headerB64).toString('utf8'));
  } catch {
    throw new InternalTokenError('header not decodable');
  }
  if (header.alg !== 'HS256' || !header.kid) {
    throw new InternalTokenError('unsupported header');
  }

  const expected = sign(headerB64, payloadB64, secretFor(header.kid));
  const a = b64urlDecode(sigB64);
  const b = b64urlDecode(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new InternalTokenError('invalid signature');
  }

  let claims: InternalTokenClaims;
  try {
    claims = JSON.parse(b64urlDecode(payloadB64).toString('utf8'));
  } catch {
    throw new InternalTokenError('payload not decodable');
  }
  if (claims.exp && Math.floor(Date.now() / 1000) >= claims.exp) {
    throw new InternalTokenError('token expired');
  }
  return claims;
}
