/**
 * T1 — Integration with real DB: scoping + skill REVIEW workflow.
 * Beyond personal|team|org, an `org` skill is visible to others ONLY after
 * admin approval (`isApproved`), and publishing to a team requires
 * status ready + team admin/owner. reject brings it back to personal.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestDb, type TestDb } from './_db';
import { SkillsService } from '../../src/skills/skills.service';
import { Skill } from '../../src/skills/skill.entity';
import { User } from '../../src/users/users.entity';

const TEAM = randomUUID();
const TEAM_ALTRO = randomUUID();
const memberships: Record<string, string[]> = {};
const teamOwners = new Set<string>(); // who is owner of TEAM (driven by the tests)
const teamsStub = {
  teamIdsForUser: async (u: string) => memberships[u] ?? [],
  isMember: async (t: string, u: string) => (memberships[u] ?? []).includes(t),
  isOwner: async (t: string, u: string) => t === TEAM && teamOwners.has(u),
} as any;
const configStub = { get: (_k: string, _d?: any) => join(tmpdir(), 'pa-skills-test') } as any;
const noop = {} as any;

let db: TestDb;
let service: SkillsService;
let skillRepo: ReturnType<TestDb['dataSource']['getRepository']>;
let B: string, C: string, D: string;

const seed = (over: Partial<{ ownerId: string; name: string; status: any; scope: any; teamId: string | null; isApproved: boolean }>) =>
  skillRepo.save(skillRepo.create({
    ownerId: over.ownerId!, name: over.name ?? 'skill', description: 'd',
    status: over.status ?? 'ready', scope: over.scope ?? 'personal',
    teamId: over.teamId ?? null, isApproved: over.isApproved ?? false,
  }));

beforeAll(async () => {
  db = await startTestDb();
  skillRepo = db.dataSource.getRepository(Skill);
  service = new SkillsService(
    skillRepo as any, noop, noop, noop, noop, configStub, teamsStub, noop,
  );

  const users = db.dataSource.getRepository(User);
  const mk = async (email: string) => (await users.save(users.create({ email, name: email, password: 'x' }))).id;
  B = await mk('b@sk.local');
  C = await mk('c@sk.local');
  D = await mk('d@sk.local');
  memberships[C] = [TEAM];
}, 180_000);

afterAll(async () => { await db?.stop(); });

describe('visibility', () => {
  it('personal: only the creator', async () => {
    await seed({ ownerId: B, name: 'sk_personal', scope: 'personal' });
    expect((await service.findAll(B)).map((s) => s.name)).toContain('sk_personal');
    expect((await service.findAll(C)).map((s) => s.name)).not.toContain('sk_personal');
  });

  it('approved org: visible to everyone; unapproved: hidden from others (review gate)', async () => {
    await seed({ ownerId: B, name: 'sk_org_ok', scope: 'org', isApproved: true });
    await seed({ ownerId: B, name: 'sk_org_pending', scope: 'org', isApproved: false });

    expect((await service.findAll(C)).map((s) => s.name)).toContain('sk_org_ok');
    expect((await service.findAll(C)).map((s) => s.name)).not.toContain('sk_org_pending');
    // the owner sees it anyway
    expect((await service.findAll(B)).map((s) => s.name)).toContain('sk_org_pending');
  });

  it('team: visible to members, not to those outside', async () => {
    await seed({ ownerId: B, name: 'sk_team', scope: 'team', teamId: TEAM });
    await seed({ ownerId: B, name: 'sk_team_altro', scope: 'team', teamId: TEAM_ALTRO });
    expect((await service.findAll(C)).map((s) => s.name)).toContain('sk_team');
    expect((await service.findAll(C)).map((s) => s.name)).not.toContain('sk_team_altro');
    expect((await service.findAll(D)).map((s) => s.name)).not.toContain('sk_team');
  });
});

describe('publishing to the team', () => {
  it('team owner + status ready → published', async () => {
    const sk = await seed({ ownerId: B, name: 'sk_pub_ok', status: 'ready', scope: 'personal' });
    teamOwners.add(B);
    const updated = await service.update(sk.id, B, { scope: 'team', teamId: TEAM }, false);
    expect(updated.scope).toBe('team');
    teamOwners.delete(B);
  });

  it('not the team owner → denied', async () => {
    const sk = await seed({ ownerId: B, name: 'sk_pub_noowner', status: 'ready', scope: 'personal' });
    await expect(service.update(sk.id, B, { scope: 'team', teamId: TEAM }, false))
      .rejects.toThrow(/skills\.onlyAdminOrTeamOwnerCanPublish/);
  });

  it('status not ready → denied', async () => {
    const sk = await seed({ ownerId: B, name: 'sk_pub_notready', status: 'pending', scope: 'personal' });
    teamOwners.add(B);
    await expect(service.update(sk.id, B, { scope: 'team', teamId: TEAM }, false))
      .rejects.toThrow(/status "ready"/);
    teamOwners.delete(B);
  });
});

describe('org publishing → review → approval', () => {
  it('org publish starts unapproved, hidden until an admin approves', async () => {
    const sk = await seed({ ownerId: B, name: 'sk_review', status: 'ready', scope: 'personal' });

    await service.update(sk.id, B, { scope: 'org' }, false);
    // not approved → C does not see it, neither by list nor by id
    expect((await service.findAll(C)).map((s) => s.name)).not.toContain('sk_review');
    await expect(service.findOne(sk.id, C)).rejects.toThrow(/not found/);

    await service.approve(sk.id);
    await expect(service.findOne(sk.id, C)).resolves.toMatchObject({ name: 'sk_review' });
  });

  it('reject brings the skill back to personal (teamId cleared)', async () => {
    const sk = await seed({ ownerId: B, name: 'sk_reject', status: 'ready', scope: 'org', isApproved: false });
    await service.reject(sk.id, 'contenuto non conforme');
    const row = await skillRepo.findOneByOrFail({ id: sk.id });
    expect(row.scope).toBe('personal');
    expect(row.teamId).toBeNull();
    expect(row.isApproved).toBe(false);
  });
});
