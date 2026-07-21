/**
 * T1 — Integration with a real DB: chat threads shared in multi-team projects
 * (project→chat→messages cascade). Migrates smoke-project-teams (chat part) +
 * smoke-phase3: authorization lives in the services (ChatsService/MessagesService),
 * so it is verified there against a real DB, without an HTTP server.
 *
 * Roles: project owner, collaborator (teamArch), viewer (teamComm), external.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestDb, type TestDb } from './_db';
import { ProjectsService } from '../../src/projects/projects.service';
import { ChatsService } from '../../src/chats/chats.service';
import { MessagesService } from '../../src/messages/messages.service';
import { Project } from '../../src/projects/projects.entity';
import { ProjectTeam } from '../../src/projects/project-team.entity';
import { Chat } from '../../src/chats/chats.entity';
import { Message } from '../../src/messages/messages.entity';
import { Team } from '../../src/teams/team.entity';
import { User } from '../../src/users/users.entity';

const memberships: Record<string, string[]> = {};
const teamsStub = {
  teamIdsForUser: async (u: string) => memberships[u] ?? [],
  getById: async (id: string) => ({ id }),
} as any;

let db: TestDb;
let projects: ProjectsService;
let chats: ChatsService;
let messages: MessagesService;
let owner: string, arch: string, arch2: string, comm: string, ext: string;
let pid: string;
let cid: string;

beforeAll(async () => {
  db = await startTestDb();
  const ds = db.dataSource;
  projects = new ProjectsService(ds.getRepository(Project), ds.getRepository(ProjectTeam), teamsStub);
  chats = new ChatsService(ds.getRepository(Chat), projects);
  messages = new MessagesService(ds.getRepository(Message));

  const teams = ds.getRepository(Team);
  const teamArch = (await teams.save(teams.create({ name: 'architetti' }))).id;
  const teamComm = (await teams.save(teams.create({ name: 'commerciale' }))).id;

  const users = ds.getRepository(User);
  const mk = async (email: string, name: string) => (await users.save(users.create({ email, name, password: 'x' }))).id;
  owner = await mk('owner@ch.local', 'Owner');
  arch = await mk('arch@ch.local', 'Architetto');
  arch2 = await mk('arch2@ch.local', 'Architetto2');
  comm = await mk('comm@ch.local', 'Commerciale');
  ext = await mk('ext@ch.local', 'Esterno');
  memberships[arch] = [teamArch];
  memberships[arch2] = [teamArch];
  memberships[comm] = [teamComm];

  const p = await projects.create(owner, { name: 'Commessa' });
  pid = p.id;
  await projects.addTeam(pid, owner, 'user', teamArch, 'collaborator');
  await projects.addTeam(pid, owner, 'user', teamComm, 'viewer');

  // the architect (collaborator) creates the shared thread
  const c = await chats.create(arch, { projectId: pid, title: 'Thread comune' });
  cid = c.id;
}, 180_000);

afterAll(async () => { await db?.stop(); });

describe('chat creation in the shared project (canWrite)', () => {
  it('viewer CANNOT create a chat', async () => {
    await expect(chats.create(comm, { projectId: pid, title: 'x' })).rejects.toThrow(/chats\.readonlyProject/);
  });
  it('outsider CANNOT create a chat', async () => {
    await expect(chats.create(ext, { projectId: pid, title: 'x' })).rejects.toThrow();
  });
});

describe('cross-member thread visibility', () => {
  it('the viewer sees the colleague\'s chat in the project, marked with its authorId', async () => {
    const list = await chats.findAllByUser(comm, pid);
    const seen = list.find((c: any) => c.id === cid);
    expect(seen).toBeTruthy();
    expect((seen as any).authorId).toBe(arch);
  });
});

describe('canWrite matrix (findOne)', () => {
  it('author → canWrite true', async () => {
    expect((await chats.findOne(cid, arch)).canWrite).toBe(true);
  });
  it('other collaborator → access + canWrite true', async () => {
    expect((await chats.findOne(cid, arch2)).canWrite).toBe(true);
  });
  it('project owner → canWrite true', async () => {
    expect((await chats.findOne(cid, owner)).canWrite).toBe(true);
  });
  it('viewer → access but canWrite false', async () => {
    expect((await chats.findOne(cid, comm)).canWrite).toBe(false);
  });
  it('outsider → 403 (no access)', async () => {
    await expect(chats.findOne(cid, ext)).rejects.toThrow();
  });
});

describe('management restricted to the author', () => {
  it('the viewer cannot rename another user\'s chat', async () => {
    await expect(chats.updateTitle(cid, comm, 'hack')).rejects.toThrow();
  });
});

describe('thread messages (authorId/authorName)', () => {
  it('multiple collaborators in the same thread, assistant without author', async () => {
    const repo = db.dataSource.getRepository(Message);
    await repo.save(repo.create({ chatId: cid, role: 'user', content: 'Domanda architetto', authorId: arch }));
    await repo.save(repo.create({ chatId: cid, role: 'assistant', content: 'Risposta AI', authorId: null }));
    await repo.save(repo.create({ chatId: cid, role: 'user', content: 'Aggiunta architetto2', authorId: arch2 }));

    const msgs = await messages.findByChat(cid);
    expect(msgs).toHaveLength(3);
    const m1 = msgs.find((m: any) => m.content === 'Domanda architetto');
    const m2 = msgs.find((m: any) => m.content === 'Aggiunta architetto2');
    const ai = msgs.find((m: any) => m.role === 'assistant');
    expect(m1).toMatchObject({ authorId: arch, authorName: 'Architetto' });
    expect(m2).toMatchObject({ authorId: arch2, authorName: 'Architetto2' });
    expect(ai?.authorId).toBeNull();
    expect((ai as any)?.authorName).toBeNull();
  });
});
