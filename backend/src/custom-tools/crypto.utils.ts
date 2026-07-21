/**
 * @file crypto.utils.ts
 *
 * Utility for encrypting/decrypting secrets (tool, MCP, data source,
 * LLM/vector/embedding API keys).
 *
 * Algorithm: **AES-256-GCM** (Node.js built-in `node:crypto`) — confidentiality
 * + authenticity: decryption FAILS if the ciphertext has been tampered with
 * (auth tag verified).
 *
 * Required .env configuration (mandatory, no fallback):
 *   TOOL_SECRETS_KEY=<64 hex characters>   (openssl rand -hex 32)
 *
 * Format of the value stored in the DB:
 *   "<iv_hex>:<authTag_hex>:<ciphertext_hex>"
 *
 * NB: no backward compatibility with the old AES-256-CBC format
 * ("<iv>:<ct>", 2 segments) — secrets encrypted in CBC must be reset.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LEN    = 12; // 96-bit nonce recommended for GCM

/**
 * Derives the 32-byte key buffer. Accepts ONLY `TOOL_SECRETS_KEY`
 * in 64-character hex; otherwise throws (no development fallback).
 */
function resolveKey(): Buffer {
  const raw = process.env.TOOL_SECRETS_KEY ?? '';
  if (raw.length === 64 && /^[0-9a-fA-F]+$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  throw new Error(
    'TOOL_SECRETS_KEY missing or invalid: 64 hex characters expected. Generate with `openssl rand -hex 32`.',
  );
}

/**
 * Validates the encryption key at startup (fail-fast). To be called in the bootstrap
 * (`main.ts`) so the app does not start at all with a missing/weak key.
 */
export function assertEncryptionKey(): void {
  resolveKey();
}

/**
 * Encrypts a text with AES-256-GCM. Each call uses a random IV.
 * @returns "<iv_hex>:<authTag_hex>:<ciphertext_hex>"
 */
export function encrypt(plaintext: string): string {
  const key    = resolveKey();
  const iv     = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const enc    = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

/**
 * Decrypts a value produced by `encrypt()`.
 * @throws if the format is invalid, the key is wrong or the data is tampered with (auth tag).
 */
export function decrypt(ciphertext: string): string {
  const parts = ciphertext.split(':');
  if (parts.length !== 3) {
    throw new Error(
      'Invalid ciphertext format — expected "<iv>:<authTag>:<ciphertext>" (AES-256-GCM). ' +
      'Values encrypted with the old CBC format must be reset.',
    );
  }
  const [ivHex, tagHex, dataHex] = parts;
  const key       = resolveKey();
  const decipher  = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}
