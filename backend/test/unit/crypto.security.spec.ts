/**
 * AES-256-GCM secret encryption (A1) — `custom-tools/crypto.utils.ts`.
 *
 * Invariant: confidentiality + integrity. A tampered ciphertext or one in the
 * old CBC format is REJECTED; a missing/weak key fails fast.
 * Migrated from `scripts/smoke-crypto.ts`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { encrypt, decrypt, assertEncryptionKey } from '../../src/custom-tools/crypto.utils';

const VALID_KEY = 'a'.repeat(64); // 64 hex = 32 bytes

describe('crypto AES-256-GCM', () => {
  let savedKey: string | undefined;

  beforeAll(() => {
    savedKey = process.env.TOOL_SECRETS_KEY;
    process.env.TOOL_SECRETS_KEY = VALID_KEY;
  });
  afterAll(() => {
    if (savedKey === undefined) delete process.env.TOOL_SECRETS_KEY;
    else process.env.TOOL_SECRETS_KEY = savedKey;
  });

  const secret = 'sk-ant-très-segreto-€uro-🔐';

  it('round-trip encrypt → decrypt returns the original text', () => {
    expect(decrypt(encrypt(secret))).toBe(secret);
  });

  it('produces the iv:authTag:ciphertext format (3 segments)', () => {
    expect(encrypt(secret).split(':')).toHaveLength(3);
  });

  it('uses a random IV: two encryptions of the same input differ', () => {
    expect(encrypt(secret)).not.toBe(encrypt(secret));
  });

  it('rejects a tampered ciphertext (auth tag)', () => {
    const [iv, tag, data] = encrypt(secret).split(':');
    const flipped = data.slice(-2) === 'ff' ? '00' : 'ff';
    const tampered = `${iv}:${tag}:${data.slice(0, -2)}${flipped}`;
    expect(() => decrypt(tampered)).toThrow();
  });

  it('rejects the old 2-segment CBC format', () => {
    expect(() => decrypt('deadbeef:cafebabe')).toThrow(/Invalid ciphertext format/);
  });

  it('assertEncryptionKey throws if the key is not hex-64 (fail-fast)', () => {
    const prev = process.env.TOOL_SECRETS_KEY;
    process.env.TOOL_SECRETS_KEY = 'troppo-corta';
    try {
      expect(() => assertEncryptionKey()).toThrow(/TOOL_SECRETS_KEY/);
    } finally {
      process.env.TOOL_SECRETS_KEY = prev;
    }
  });
});
