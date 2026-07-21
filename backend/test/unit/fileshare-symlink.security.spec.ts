/**
 * L7 regression — the virtual `local` file-share adapter guarded the path only
 * lexically, so a symlink planted inside the base pointing outside (e.g. -> /etc)
 * passed the check and was then followed by read/stat/stream. The guard now resolves
 * the real path (realpath) and re-checks containment.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileshareDriver } from '../../src/datasources/fileshare/fileshare.driver';

let base: string;
let outsideDir: string;
let conn: string;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'fs-base-'));
  outsideDir = mkdtempSync(join(tmpdir(), 'fs-outside-'));
  writeFileSync(join(outsideDir, 'secret.txt'), 'SECRET OUTSIDE BASE');
  writeFileSync(join(base, 'own.txt'), 'legit own file');
  // A symlink INSIDE base that escapes to a file outside base.
  symlinkSync(join(outsideDir, 'secret.txt'), join(base, 'escape.txt'));
  conn = `local://${base}`;
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
});

describe('local fileshare adapter — symlink escape blocked (L7)', () => {
  it('reads a legit file inside the base', async () => {
    const res = await fileshareDriver.execute('local', conn, { op: 'read', path: 'own.txt' } as any);
    const text = Buffer.from(String(res.content), 'base64').toString('utf8');
    expect(text).toContain('legit own file');
  });

  it('refuses to read through a symlink that escapes the base', async () => {
    await expect(
      fileshareDriver.execute('local', conn, { op: 'read', path: 'escape.txt' } as any),
    ).rejects.toThrow(/outside the base/);
  });

  it('refuses to stat through the escaping symlink', async () => {
    await expect(fileshareDriver.statFile('local', conn, 'escape.txt')).rejects.toThrow(/outside the base/);
  });
});
