/**
 * T1 — Integration with real DB: project shared files (collaborator/viewer
 * roles). Migrates smoke-phase2: upload (canWrite), listing by project (member
 * sees, outsider 403), download access, delete owner-only. Authorization in the
 * services → verified there against a real DB.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestDb, type TestDb } from './_db';
import { FilesService } from '../../src/files/files.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { File as FileEntity } from '../../src/files/files.entity';
import { Project } from '../../src/projects/projects.entity';
import { ProjectTeam } from '../../src/projects/project-team.entity';
import { Message } from '../../src/messages/messages.entity';
import { Team } from '../../src/teams/team.entity';
import { User } from '../../src/users/users.entity';

const memberships: Record<string, string[]> = {};
const teamsStub = {
  teamIdsForUser: async (u: string) => memberships[u] ?? [],
  getById: async (id: string) => ({ id }),
} as any;
const cfgStub = { get: (k: string, d?: any) => (k === 'UPLOAD_DIR' ? join(tmpdir(), 'pa-files-proj') : k === 'ANTHROPIC_API_KEY' ? 'test' : d) } as any;

const fakeFile = (name: string) => ({ originalname: name, path: join(tmpdir(), name), mimetype: 'text/plain', size: 5 } as any);

let db: TestDb;
let files: FilesService;
let projects: ProjectsService;
let owner: string, arch: string, comm: string, ext: string;
let pid: string;
let fileId: string;

beforeAll(async () => {
  db = await startTestDb();
  const ds = db.dataSource;
  projects = new ProjectsService(ds.getRepository(Project), ds.getRepository(ProjectTeam), teamsStub);
  files = new FilesService(ds.getRepository(FileEntity), ds.getRepository(Message), cfgStub, projects, teamsStub);

  const teams = ds.getRepository(Team);
  const teamArch = (await teams.save(teams.create({ name: 'architetti-f' }))).id;
  const teamComm = (await teams.save(teams.create({ name: 'commerciale-f' }))).id;

  const users = ds.getRepository(User);
  const mk = async (email: string) => (await users.save(users.create({ email, name: email, password: 'x' }))).id;
  owner = await mk('owner@fp.local');
  arch = await mk('arch@fp.local');
  comm = await mk('comm@fp.local');
  ext = await mk('ext@fp.local');
  memberships[arch] = [teamArch];
  memberships[comm] = [teamComm];

  const p = await projects.create(owner, { name: 'Commessa file' });
  pid = p.id;
  await projects.addTeam(pid, owner, 'user', teamArch, 'collaborator');
  await projects.addTeam(pid, owner, 'user', teamComm, 'viewer');
}, 180_000);

afterAll(async () => { await db?.stop(); });

describe('upload (canWrite)', () => {
  it('collaborator uploads a file to the project', async () => {
    const f = await files.saveFile(arch, pid, fakeFile('doc-arch.txt'));
    fileId = f.id;
    expect(f.projectId).toBe(pid);
  });
  it('viewer CANNOT upload → Forbidden', async () => {
    await expect(files.saveFile(comm, pid, fakeFile('hack.txt'))).rejects.toThrow(/files\.readonlyProject/);
  });
});

describe('listing by project', () => {
  it('collaborator sees the project file', async () => {
    expect((await files.findByProject(pid, arch)).map((f) => f.id)).toContain(fileId);
  });
  it('viewer sees the colleague\'s shared file', async () => {
    expect((await files.findByProject(pid, comm)).map((f) => f.id)).toContain(fileId);
  });
  it('outsider CANNOT list the project files → Forbidden', async () => {
    await expect(files.findByProject(pid, ext)).rejects.toThrow();
  });
});

describe('download access (canAccessFile) and delete', () => {
  it('project member accesses the file, outsider no', async () => {
    const file = await db.dataSource.getRepository(FileEntity).findOneByOrFail({ id: fileId });
    expect(await files.canAccessFile(file, comm)).toBe(true);   // viewer is still a project member
    expect(await files.canAccessFile(file, ext)).toBe(false);
  });
  it('a non-owner cannot delete the file', async () => {
    await expect(files.remove(fileId, comm)).rejects.toThrow();
  });
  it('the owner deletes their own file', async () => {
    await expect(files.remove(fileId, arch)).resolves.toMatchObject({ deleted: true });
  });
});
