/**
 * T1 — Integration with real DB: multi-team project sharing
 * (`ProjectsService`). Projects stay single-owner but can be shared with N teams
 * via `project_teams` with collaborator/viewer roles. Verifies findAllForUser,
 * accessLevel (owner/collaborator/viewer/null), canWrite and team assignment.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestDb, type TestDb } from './_db';
import { ProjectsService } from '../../src/projects/projects.service';
import { Project } from '../../src/projects/projects.entity';
import { ProjectTeam } from '../../src/projects/project-team.entity';
import { Team } from '../../src/teams/team.entity';
import { User } from '../../src/users/users.entity';

// project_teams.teamId has a real FK to teams → real Team rows are needed.
let TEAM: string;
let TEAM2: string;
const memberships: Record<string, string[]> = {};
const teamsStub = {
  teamIdsForUser: async (u: string) => memberships[u] ?? [],
  getById: async (id: string) => ({ id }),
} as any;

let db: TestDb;
let service: ProjectsService;
let B: string, C: string, D: string;

beforeAll(async () => {
  db = await startTestDb();
  service = new ProjectsService(
    db.dataSource.getRepository(Project),
    db.dataSource.getRepository(ProjectTeam),
    teamsStub,
  );
  const teams = db.dataSource.getRepository(Team);
  TEAM = (await teams.save(teams.create({ name: 'Vendite' }))).id;
  TEAM2 = (await teams.save(teams.create({ name: 'Marketing' }))).id;

  const users = db.dataSource.getRepository(User);
  const mk = async (email: string) => (await users.save(users.create({ email, name: email, password: 'x' }))).id;
  B = await mk('b@pr.local'); // owner
  C = await mk('c@pr.local'); // team member
  D = await mk('d@pr.local'); // outsider
  memberships[C] = [TEAM];
}, 180_000);

afterAll(async () => { await db?.stop(); });

describe('visibility', () => {
  it('owner sees their own project; shared with the team → visible to members', async () => {
    const p = await service.create(B, { name: 'P_shared' });
    await service.addTeam(p.id, B, 'user', TEAM, 'collaborator');

    expect((await service.findAllForUser(B)).map((x) => x.name)).toContain('P_shared');
    expect((await service.findAllForUser(C)).map((x) => x.name)).toContain('P_shared');
    expect((await service.findAllForUser(D)).map((x) => x.name)).not.toContain('P_shared');
  });
});

describe('accessLevel & canWrite', () => {
  it('owner → owner+write', async () => {
    const p = await service.create(B, { name: 'P_owner' });
    expect(await service.accessLevel(p.id, B)).toBe('owner');
    expect(await service.canWrite(p.id, B)).toBe(true);
  });

  it('collaborator → collaborator+write; outsider → null/no-write', async () => {
    const p = await service.create(B, { name: 'P_collab' });
    await service.addTeam(p.id, B, 'user', TEAM, 'collaborator');
    expect(await service.accessLevel(p.id, C)).toBe('collaborator');
    expect(await service.canWrite(p.id, C)).toBe(true);
    expect(await service.accessLevel(p.id, D)).toBeNull();
    expect(await service.canWrite(p.id, D)).toBe(false);
  });

  it('viewer → viewer but NO write', async () => {
    const p = await service.create(B, { name: 'P_viewer' });
    await service.addTeam(p.id, B, 'user', TEAM, 'viewer');
    expect(await service.accessLevel(p.id, C)).toBe('viewer');
    expect(await service.canWrite(p.id, C)).toBe(false);
  });
});

describe('team management', () => {
  it('same team twice → conflict', async () => {
    const p = await service.create(B, { name: 'P_dup' });
    await service.addTeam(p.id, B, 'user', TEAM, 'collaborator');
    await expect(service.addTeam(p.id, B, 'user', TEAM, 'collaborator')).rejects.toThrow(/projects\.teamAlreadyAssigned/);
  });

  it('a non-owner cannot assign teams (Forbidden)', async () => {
    const p = await service.create(B, { name: 'P_noowner' });
    await expect(service.addTeam(p.id, C, 'user', TEAM2, 'collaborator')).rejects.toThrow(/projects\.onlyOwner/);
  });
});
