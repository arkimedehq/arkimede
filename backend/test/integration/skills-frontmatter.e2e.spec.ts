/**
 * Runtime test of the agentskills.io format (S1): skills no longer have skill.yaml,
 * the manifest lives in the frontmatter of SKILL.md under `runtime`.
 *
 * Verifies the REAL path:
 *   - uploadAndCreate  → parseAndValidateZip → parseSkillMd (frontmatter)
 *   - reinstall        → refreshMetadataFromDisk (re-reading SKILL.md from the volume)
 *   - SKILL.md without frontmatter → BadRequest
 *
 * Uses an ephemeral Postgres (testcontainers) + the real SkillsService with
 * minimal stubs for executor/files/egress (no dependencies → install no-op).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import AdmZip from 'adm-zip';
import { startTestDb, type TestDb } from './_db';
import { SkillsService } from '../../src/skills/skills.service';
import { Skill } from '../../src/skills/skill.entity';
import { SkillScript } from '../../src/skills/skill-script.entity';
import { SkillProjectAssignment } from '../../src/skills/skill-project-assignment.entity';
import { SkillConfigVar } from '../../src/skills/skill-config-var.entity';
import { User } from '../../src/users/users.entity';

const SKILLS_BASE = join(tmpdir(), `pa-skills-fm-${randomUUID()}`);
const configStub = { get: (k: string, d?: any) => (k === 'SKILLS_BASE_PATH' ? SKILLS_BASE : d) } as any;
const executorStub = { install: async () => ({ ok: true, log: '', duration_ms: 0 }), listDaemons: async () => [], stopDaemon: async () => undefined } as any;
const egressStub = { sync: async () => undefined } as any;
const teamsStub = { teamIdsForUser: async () => [] } as any;

const FRONTMATTER_SKILL = `---
name: e2e-frontmatter
version: 1.2.3
description: Skill di test per il formato frontmatter
author: test@local
license: MIT
runtime:
  network:
    - api.example.com
  config:
    - key: API_KEY
      description: Chiave API
      required: true
      secret: true
  scripts:
    - filename: scripts/main.py
      language: python
      description: Script principale di test
      input_schema:
        type: object
        required: [name]
        properties:
          name:
            type: string
            description: Nome utente
---

# E2E Frontmatter

Istruzioni condivise.

<!-- @tool: main.py -->
## main.py
Esempio d'uso.
`;

const NO_FRONTMATTER_SKILL = `# Skill senza frontmatter\n\nSolo testo, nessun manifest.\n`;

function buildZip(skillMd: string, withScript = true): Buffer {
  const zip = new AdmZip();
  zip.addFile('SKILL.md', Buffer.from(skillMd, 'utf-8'));
  if (withScript) zip.addFile('scripts/main.py', Buffer.from('import sys, json\nprint(json.dumps({"ok": True}))\n', 'utf-8'));
  return zip.toBuffer();
}

let db: TestDb;
let service: SkillsService;
let USER: string;

beforeAll(async () => {
  db = await startTestDb();
  const users = db.dataSource.getRepository(User);
  USER = (await users.save(users.create({ email: 'fm@e2e.local', name: 'fm', password: 'x' }))).id;
  service = new SkillsService(
    db.dataSource.getRepository(Skill) as any,
    db.dataSource.getRepository(SkillScript) as any,
    db.dataSource.getRepository(SkillProjectAssignment) as any,
    db.dataSource.getRepository(SkillConfigVar) as any,
    executorStub,
    configStub,
    teamsStub,
    {} as any,   // filesService — not used in the upload path
    egressStub,
  );
}, 180_000);

afterAll(async () => {
  await db?.stop();
  try { rmSync(SKILLS_BASE, { recursive: true, force: true }); } catch { /* */ }
});

/** Waits for the skill to reach the expected status (install in background). */
async function waitStatus(id: string, target: string, timeoutMs = 5000): Promise<Skill> {
  const start = Date.now();
  for (;;) {
    const s = await service.findOne(id, USER);
    if (s.status === target) return s;
    if (Date.now() - start > timeoutMs) return s;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('S1 — manifest from the SKILL.md frontmatter', () => {
  let skillId: string;

  it('uploadAndCreate parses the frontmatter (name/description/network/config/scripts)', async () => {
    const created = await service.uploadAndCreate(USER, buildZip(FRONTMATTER_SKILL));
    skillId = created.id;

    expect(created.name).toBe('e2e-frontmatter');
    expect(created.version).toBe('1.2.3');
    expect(created.description).toContain('formato frontmatter');
    expect(created.author).toBe('test@local');
    expect(created.license).toBe('MIT');
    expect(created.networkDomains).toEqual(['api.example.com']);

    // configSpec
    expect(created.configSpec).toHaveLength(1);
    expect(created.configSpec![0]).toMatchObject({ key: 'API_KEY', required: true, secret: true });

    // script denormalized from runtime.scripts
    expect(created.scripts).toHaveLength(1);
    const sc = created.scripts![0];
    expect(sc.filename).toBe('scripts/main.py');
    expect(sc.language).toBe('python');
    expect((sc.inputSchema as any).required).toContain('name');

    // file extracted to the volume
    expect(existsSync(join(SKILLS_BASE, created.id, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(SKILLS_BASE, created.id, 'scripts', 'main.py'))).toBe(true);
  });

  it('the SKILL.md on disk is in agentskills.io format (frontmatter --- at the top)', () => {
    const md = readFileSync(join(SKILLS_BASE, skillId, 'SKILL.md'), 'utf-8');
    expect(md.startsWith('---\n')).toBe(true);
    expect(md).toContain('runtime:');
  });

  it('reinstall re-reads the metadata from the frontmatter on disk (refreshMetadataFromDisk)', async () => {
    await waitStatus(skillId, 'ready');
    const re = await service.reinstall(skillId, USER);
    // after reinstall the metadata stays consistent with the frontmatter on disk
    const reloaded = await waitStatus(re.id, 'ready');
    expect(reloaded.name).toBe('e2e-frontmatter');
    expect(reloaded.networkDomains).toEqual(['api.example.com']);
    expect(reloaded.scripts).toHaveLength(1);
    expect(reloaded.scripts![0].filename).toBe('scripts/main.py');
  });

  it('SKILL.md without frontmatter → BadRequest (upload rejected)', async () => {
    await expect(
      service.uploadAndCreate(randomUUID(), buildZip(NO_FRONTMATTER_SKILL, false)),
    ).rejects.toThrow();
  });
});
