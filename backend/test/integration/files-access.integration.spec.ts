/**
 * T1 — Integration with real DB: the core of C2, `canAccessFile` (graph
 * owner/org/team/project) + `searchReadable` access-scoped (closing the
 * cross-tenant leak of file-lookup) + `setScope` (owner/admin only).
 *
 * Uses a REAL ProjectsService so the "project member" branch is exercised
 * end-to-end against the DB, not stubbed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Repository } from 'typeorm';
import { startTestDb, type TestDb } from './_db';
import { FilesService } from '../../src/files/files.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { File as FileEntity } from '../../src/files/files.entity';
import { Project } from '../../src/projects/projects.entity';
import { ProjectTeam } from '../../src/projects/project-team.entity';
import { Message } from '../../src/messages/messages.entity';
import { Team } from '../../src/teams/team.entity';
import { User } from '../../src/users/users.entity';

let TEAM: string; // real FK to teams (via project_teams)
const memberships: Record<string, string[]> = {};
const teamsStub = {
  teamIdsForUser: async (u: string) => memberships[u] ?? [],
  isMember: async (t: string, u: string) => (memberships[u] ?? []).includes(t),
  getById: async (id: string) => ({ id }),
} as any;
const cfgStub = {
  get: (k: string, d?: any) => (k === 'UPLOAD_DIR' ? join(tmpdir(), 'pa-files-test') : k === 'ANTHROPIC_API_KEY' ? 'sk-test' : d),
} as any;

let db: TestDb;
let files: FilesService;
let fileRepo: Repository<FileEntity>;
let projects: ProjectsService;
let B: string, C: string, D: string;

const seedFile = (over: Partial<FileEntity>) =>
  fileRepo.save(fileRepo.create({
    originalName: over.originalName ?? 'f.txt', storagePath: '/tmp/x', mimeType: 'text/plain', size: 1,
    userId: over.userId!, scope: over.scope ?? 'personal', teamId: over.teamId ?? null, projectId: over.projectId ?? null,
  }));

beforeAll(async () => {
  db = await startTestDb();
  fileRepo = db.dataSource.getRepository(FileEntity);
  projects = new ProjectsService(db.dataSource.getRepository(Project), db.dataSource.getRepository(ProjectTeam), teamsStub);
  files = new FilesService(fileRepo, db.dataSource.getRepository(Message), cfgStub, projects, teamsStub);

  TEAM = (await db.dataSource.getRepository(Team).save({ name: 'Vendite-files' } as any)).id;

  const users = db.dataSource.getRepository(User);
  const mk = async (email: string) => (await users.save(users.create({ email, name: email, password: 'x' }))).id;
  B = await mk('b@fi.local');
  C = await mk('c@fi.local');
  D = await mk('d@fi.local');
  memberships[C] = [TEAM];
}, 180_000);

afterAll(async () => { await db?.stop(); });

describe('canAccessFile (C2 graph)', () => {
  it('owner: always', async () => {
    const f = await seedFile({ userId: B, scope: 'personal' });
    expect(await files.canAccessFile(f, B)).toBe(true);
  });

  it('org: anyone', async () => {
    const f = await seedFile({ userId: B, scope: 'org' });
    expect(await files.canAccessFile(f, C)).toBe(true);
  });

  it('team: member yes, outsider no', async () => {
    const f = await seedFile({ userId: B, scope: 'team', teamId: TEAM });
    expect(await files.canAccessFile(f, C)).toBe(true);
    expect(await files.canAccessFile(f, D)).toBe(false);
  });

  it('project: shared-project member yes, outsider no', async () => {
    const p = await projects.create(B, { name: 'P_files' });
    await projects.addTeam(p.id, B, 'user', TEAM, 'collaborator');
    const f = await seedFile({ userId: B, scope: 'personal', projectId: p.id });
    expect(await files.canAccessFile(f, C)).toBe(true);  // C is a member of the project's team
    expect(await files.canAccessFile(f, D)).toBe(false);
  });

  it('another user\'s personal: denied', async () => {
    const f = await seedFile({ userId: B, scope: 'personal' });
    expect(await files.canAccessFile(f, C)).toBe(false);
  });
});

describe('searchReadable (closes the cross-tenant leak)', () => {
  it('returns owner ∪ org ∪ team(member), never another user\'s personal', async () => {
    await seedFile({ userId: B, scope: 'personal', originalName: 'report_b' });   // B's personal
    await seedFile({ userId: C, scope: 'personal', originalName: 'report_c' });   // C's personal
    await seedFile({ userId: B, scope: 'org', originalName: 'report_org' });      // org
    await seedFile({ userId: B, scope: 'team', teamId: TEAM, originalName: 'report_team' });

    const names = (await files.searchReadable(C, 'report')).map((f) => f.originalName);
    expect(names).toContain('report_c');
    expect(names).toContain('report_org');
    expect(names).toContain('report_team');
    expect(names).not.toContain('report_b'); // B's personal: invisible to C
  });
});

describe('setScope (owner/admin only)', () => {
  it('a non-owner non-admin cannot change the scope', async () => {
    const f = await seedFile({ userId: B, scope: 'personal' });
    await expect(files.setScope(f.id, C, 'org', null, false)).rejects.toThrow(/files\.scopeOwnerOnly/);
  });

  it('owner can promote to org', async () => {
    const f = await seedFile({ userId: B, scope: 'personal' });
    const updated = await files.setScope(f.id, B, 'org', null, false);
    expect(updated.scope).toBe('org');
  });
});
