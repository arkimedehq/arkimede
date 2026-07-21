/**
 * Skill integrity from registry (E3) — `assertSkillIntegrity` in
 * `skills/registry.service.ts`.
 *
 * Invariant: declared checksum → mandatory SHA-256 comparison (mismatch =
 * block); absent → blocked in strict mode or for non-admins. Migrated from
 * `scripts/smoke-checksum.ts`.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { assertSkillIntegrity } from '../../src/skills/registry.service';

const buf = Buffer.from('contenuto-zip-skill');
const goodChecksum = createHash('sha256').update(buf).digest('hex');

describe('assertSkillIntegrity — declared checksum', () => {
  it('correct checksum → allowed', () => {
    expect(() => assertSkillIntegrity(buf, goodChecksum, { isAdmin: false, strict: false })).not.toThrow();
  });

  it('checksum with "sha256:" prefix and uppercase → normalized', () => {
    expect(() => assertSkillIntegrity(buf, 'sha256:' + goodChecksum.toUpperCase(), { isAdmin: false, strict: false })).not.toThrow();
  });

  it('wrong checksum → blocked with a tampering message', () => {
    expect(() => assertSkillIntegrity(buf, 'deadbeef'.repeat(8), { isAdmin: false, strict: false }))
      .toThrow(/Checksum mismatch/);
  });
});

describe('assertSkillIntegrity — missing checksum', () => {
  it('admin → allowed (admin confirmation)', () => {
    expect(() => assertSkillIntegrity(buf, undefined, { isAdmin: true, strict: false })).not.toThrow();
  });

  it('non-admin → blocked', () => {
    expect(() => assertSkillIntegrity(buf, undefined, { isAdmin: false, strict: false }))
      .toThrow(/skills\.checksumMissingAdminOnly/);
  });

  it('strict → blocked even for admin', () => {
    expect(() => assertSkillIntegrity(buf, undefined, { isAdmin: true, strict: true }))
      .toThrow(/skills\.checksumMissingStrict/);
  });
});
