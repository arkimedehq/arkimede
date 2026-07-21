/**
 * T3 — e2e HTTP for projects: access (canAccess) and sharing management
 * (owner/admin only) actually enforced on the endpoints.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { startTestDb, type TestDb } from './_db';
import { ProjectsController } from '../../src/projects/projects.controller';
import { ProjectsService } from '../../src/projects/projects.service';
import { Project } from '../../src/projects/projects.entity';
import { ProjectTeam } from '../../src/projects/project-team.entity';
import { Team } from '../../src/teams/team.entity';
import { User } from '../../src/users/users.entity';
import { JwtAuthGuard } from '../../src/common/guards/jwt-auth.guard';

let TEAM: string; // real FK to teams
const memberships: Record<string, string[]> = {};
const teamsStub = {
  teamIdsForUser: async (u: string) => memberships[u] ?? [],
  getById: async (id: string) => ({ id }),
} as any;

let db: TestDb;
let app: INestApplication;
let current: { id: string; role: string };
let BID: string, CID: string, DID: string;
let projId: string;

beforeAll(async () => {
  db = await startTestDb();
  const service = new ProjectsService(
    db.dataSource.getRepository(Project),
    db.dataSource.getRepository(ProjectTeam),
    teamsStub,
  );
  TEAM = (await db.dataSource.getRepository(Team).save({ name: 'Vendite-e2e' } as any)).id;

  const users = db.dataSource.getRepository(User);
  const mk = async (email: string) => (await users.save(users.create({ email, name: email, password: 'x' }))).id;
  BID = await mk('b@pre2e.local');
  CID = await mk('c@pre2e.local');
  DID = await mk('d@pre2e.local');
  memberships[CID] = [TEAM];

  const p = await service.create(BID, { name: 'e2e_proj' });
  projId = p.id;
  await service.addTeam(p.id, BID, 'user', TEAM, 'collaborator');

  const moduleRef = await Test.createTestingModule({
    controllers: [ProjectsController],
    providers: [{ provide: ProjectsService, useValue: service }],
  })
    .overrideGuard(JwtAuthGuard)
    .useValue({ canActivate: (ctx: any) => { ctx.switchToHttp().getRequest().user = current; return true; } })
    .compile();

  app = moduleRef.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
}, 180_000);

afterAll(async () => { await app?.close(); await db?.stop(); });

it('shared-team member accesses the project (200)', async () => {
  current = { id: CID, role: 'user' };
  expect((await request(app.getHttpServer()).get(`/api/projects/${projId}`)).status).toBe(200);
});

it('outsider does not access the project (403)', async () => {
  current = { id: DID, role: 'user' };
  expect((await request(app.getHttpServer()).get(`/api/projects/${projId}`)).status).toBe(403);
});

it('a non-owner cannot share the project with a team (403)', async () => {
  current = { id: CID, role: 'user' };
  const res = await request(app.getHttpServer())
    .post(`/api/projects/${projId}/teams`)
    .send({ teamId: randomUUID(), role: 'collaborator' });
  expect(res.status).toBe(403);
});

it('admin accesses any project (200)', async () => {
  current = { id: 'admin-id', role: 'admin' };
  expect((await request(app.getHttpServer()).get(`/api/projects/${projId}`)).status).toBe(200);
});
