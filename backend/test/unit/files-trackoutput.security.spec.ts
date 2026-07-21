/**
 * C2 copy-out — `FilesService.trackOutput` records a skill/tool output as a
 * File entity (owner, personal scope, run's project) so the `?rel=` download
 * becomes access-aware; skips if already tracked or if the file does not exist.
 * Migrated from scripts/smoke-trackoutput.ts. Pure logic: mocked repo, no DB.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, rmSync } from 'node:fs';
import { FilesService } from '../../src/files/files.service';

function makeSvc(existing: any) {
  let saved: any = null;
  const repo: any = {
    // trackOutput looks for an already-existing File via createQueryBuilder().where().getOne()
    createQueryBuilder: () => ({ where: () => ({ getOne: async () => existing }) }),
    create: (x: any) => x,
    save: async (x: any) => { saved = x; return x; },
  };
  const cfg = { get: (k: string, d?: any) => (k === 'UPLOAD_DIR' ? '/tmp' : k === 'ANTHROPIC_API_KEY' ? 'test' : d) };
  const svc = new FilesService(repo as any, {} as any, cfg as any, {} as any, {} as any);
  return { svc, getSaved: () => saved };
}

const OUT = '/tmp/sko-out.pdf';
beforeAll(() => writeFileSync(OUT, 'PDF'));
afterAll(() => rmSync(OUT, { force: true }));

describe('trackOutput (output access-aware)', () => {
  it('output nuovo + file esistente → File creato (owner, scope personal, progetto)', async () => {
    const { svc, getSaved } = makeSvc(null);
    await svc.trackOutput('user-1', 'proj-1', OUT);
    const s = getSaved();
    expect(s).toMatchObject({
      userId: 'user-1', scope: 'personal', projectId: 'proj-1',
      storagePath: OUT, originalName: 'sko-out.pdf', mimeType: 'application/pdf',
    });
  });

  it('già tracciato → nessun doppione', async () => {
    const { svc, getSaved } = makeSvc({ id: 'exists' });
    await svc.trackOutput('user-1', null, OUT);
    expect(getSaved()).toBeNull();
  });

  it('file inesistente → non tracciato', async () => {
    const { svc, getSaved } = makeSvc(null);
    await svc.trackOutput('user-1', null, '/tmp/non-esiste-xyz.pdf');
    expect(getSaved()).toBeNull();
  });
});
