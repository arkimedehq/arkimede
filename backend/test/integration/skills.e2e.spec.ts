/**
 * T3 — e2e HTTP for skills: review governance is admin-only
 * (AdminGuard on pending-review/approve/reject) and publishing to the team
 * goes through the service (PATCH /:id). Also verifies the full review
 * loop: unapproved org invisible → admin approves → visible.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { startTestDb, type TestDb } from './_db';
import { SkillsController } from '../../src/skills/skills.controller';
import { SkillsService } from '../../src/skills/skills.service';
import { RegistryService } from '../../src/skills/registry.service';
import { AuditService } from '../../src/audit/audit.service';
import { Skill } from '../../src/skills/skill.entity';
import { User } from '../../src/users/users.entity';
import { TeamsService } from '../../src/teams/teams.service';
import { JwtAuthGuard } from '../../src/common/guards/jwt-auth.guard';

const TEAM = randomUUID();
const memberships: Record<string, string[]> = {};
const teamsStub = {
  teamIdsForUser: async (u: string) => memberships[u] ?? [],
  isMember: async (t: string, u: string) => (memberships[u] ?? []).includes(t),
  isOwner: async () => false,
} as any;
const configStub = { get: (_k: string, _d?: any) => join(tmpdir(), 'pa-skills-e2e') } as any;
// no-op stub for any method (registry/audit not relevant for these endpoints).
// NB: do NOT intercept `then`/symbol, otherwise the object looks like a thenable and
// Nest's await on the provider hangs forever.
const proxyNoop = new Proxy({}, {
  get: (_t, p) => (p === 'then' || typeof p === 'symbol') ? undefined : async () => undefined,
});

let db: TestDb;
let app: INestApplication;
let current: { id: string; role: string };
let skillRepo: ReturnType<TestDb['dataSource']['getRepository']>;
let BID: string, CID: string, DID: string;
let teamSkillId: string;
let orgPendingId: string;

const seed = (over: any) => skillRepo.save(skillRepo.create({
  ownerId: over.ownerId, name: over.name, description: 'd',
  status: over.status ?? 'ready', scope: over.scope ?? 'personal',
  teamId: over.teamId ?? null, isApproved: over.isApproved ?? false,
}));

beforeAll(async () => {
  db = await startTestDb();
  skillRepo = db.dataSource.getRepository(Skill);
  const service = new SkillsService(skillRepo as any, {} as any, {} as any, {} as any, {} as any, configStub, teamsStub, {} as any);

  const users = db.dataSource.getRepository(User);
  const mk = async (email: string) => (await users.save(users.create({ email, name: email, password: 'x' }))).id;
  BID = await mk('b@ske2e.local');
  CID = await mk('c@ske2e.local');
  DID = await mk('d@ske2e.local');
  memberships[CID] = [TEAM];

  teamSkillId = (await seed({ ownerId: BID, name: 'e2e_team_skill', scope: 'team', teamId: TEAM })).id;
  orgPendingId = (await seed({ ownerId: BID, name: 'e2e_org_pending', scope: 'org', isApproved: false })).id;

  const moduleRef = await Test.createTestingModule({
    controllers: [SkillsController],
    providers: [
      { provide: SkillsService, useValue: service },
      { provide: RegistryService, useValue: proxyNoop },
      { provide: AuditService, useValue: proxyNoop },
      { provide: TeamsService, useValue: teamsStub },
    ],
  })
    .overrideGuard(JwtAuthGuard)
    .useValue({ canActivate: (ctx: any) => { ctx.switchToHttp().getRequest().user = current; return true; } })
    .compile();

  app = moduleRef.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
}, 180_000);

afterAll(async () => { await app?.close(); await db?.stop(); });

describe('visibility via HTTP', () => {
  it('member sees the team skill (200), outside the team 404', async () => {
    current = { id: CID, role: 'user' };
    expect((await request(app.getHttpServer()).get(`/api/skills/${teamSkillId}`)).status).toBe(200);
    current = { id: DID, role: 'user' };
    expect((await request(app.getHttpServer()).get(`/api/skills/${teamSkillId}`)).status).toBe(404);
  });
});

describe('governance review admin-only', () => {
  it('a non-admin cannot see the review queue (403)', async () => {
    current = { id: CID, role: 'user' };
    expect((await request(app.getHttpServer()).get('/api/skills/pending-review')).status).toBe(403);
  });

  it('a non-admin cannot approve (403)', async () => {
    current = { id: CID, role: 'user' };
    expect((await request(app.getHttpServer()).post(`/api/skills/${orgPendingId}/approve`)).status).toBe(403);
  });

  it('a non-owner cannot publish to the team via PATCH (403)', async () => {
    // CID tries to republish a skill that isn't hers / for which she is not the team owner
    current = { id: CID, role: 'user' };
    const res = await request(app.getHttpServer())
      .patch(`/api/skills/${teamSkillId}`)
      .send({ scope: 'team', teamId: TEAM });
    expect(res.status).toBeGreaterThanOrEqual(400); // 403/404: not the skill owner
  });
});

describe('full loop: org review', () => {
  it('unapproved org invisible → admin approves → visible', async () => {
    // before approval: C does not see it
    current = { id: CID, role: 'user' };
    expect((await request(app.getHttpServer()).get(`/api/skills/${orgPendingId}`)).status).toBe(404);

    // admin approves
    current = { id: 'admin-id', role: 'admin' };
    const approve = await request(app.getHttpServer()).post(`/api/skills/${orgPendingId}/approve`);
    expect(approve.status).toBe(200);

    // now C sees it
    current = { id: CID, role: 'user' };
    expect((await request(app.getHttpServer()).get(`/api/skills/${orgPendingId}`)).status).toBe(200);
  });
});
