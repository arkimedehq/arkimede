/**
 * H1 regression — the virtual `local` file-share source (used by GET /api/files/stream
 * and /stream-token) must be CONFINED to the caller's per-user subdir of
 * SKILLS_OUTPUT_DIR. Before the fix, `resolveFileShare('local', …)` pointed at the
 * shared root, so any authenticated user could stream another tenant's outputs with
 * `?path=<victimUserId>/<file>`.
 *
 * This drives the REAL `DataSourcesService.statFileShare` (which goes through the
 * private `resolveFileShare` + the local fileshare adapter) against a temp dir on
 * disk — no DB, only a mocked ConfigService.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSourcesService } from '../../src/datasources/datasources.service';

const USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const SECRET = 'top-secret contents of B';

let outDir: string;
let svc: DataSourcesService;

beforeAll(() => {
  outDir = mkdtempSync(join(tmpdir(), 'skills-output-'));
  mkdirSync(join(outDir, USER_A), { recursive: true });
  mkdirSync(join(outDir, USER_B), { recursive: true });
  writeFileSync(join(outDir, USER_B, 'secret.txt'), SECRET);

  const config = {
    get: (key: string, def?: string) =>
      key === 'SKILLS_OUTPUT_DIR' ? outDir : key === 'UPLOAD_DIR' ? './uploads' : def,
  };
  // Only `config` is exercised by the local branch of resolveFileShare/statFileShare.
  svc = new DataSourcesService(null as any, null as any, config as any, null as any);
});

afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe('local file-share is confined per-tenant (H1)', () => {
  it("A cannot stat B's file by supplying B's userId in the path", async () => {
    // Resolves under <out>/<A>/<B>/secret.txt → does not exist → 404 (not a raw 500).
    await expect(svc.statFileShare('local', USER_A, `${USER_B}/secret.txt`)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('A cannot escape its subdir with a traversal path', async () => {
    // Containment rejection surfaces as 403, never a raw 500.
    await expect(svc.statFileShare('local', USER_A, `../${USER_B}/secret.txt`)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('B can stat its OWN file (path relative to its per-user base)', async () => {
    const size = await svc.statFileShare('local', USER_B, 'secret.txt');
    expect(size).toBe(Buffer.byteLength(SECRET));
  });

  it('fails closed when the identity is missing', async () => {
    await expect(svc.statFileShare('local', '', 'secret.txt')).rejects.toBeInstanceOf(ForbiddenException);
  });
});
