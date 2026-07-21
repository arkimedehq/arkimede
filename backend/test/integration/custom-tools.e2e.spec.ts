/**
 * T3 — HTTP e2e: the full round trip guard → controller → service → real DB.
 * Catches the bugs unit tests miss: authorization actually enforced on the
 * endpoints and the SSRF guard *wiring*, with the error REPORTED to the user
 * (§13.2 of the security plan) through `POST /:id/test`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { startTestDb, type TestDb } from './_db';
import { CustomToolsController } from '../../src/custom-tools/custom-tools.controller';
import { CustomToolsService } from '../../src/custom-tools/custom-tools.service';
import { CustomTool } from '../../src/custom-tools/custom-tool.entity';
import { ToolSecret } from '../../src/custom-tools/tool-secret.entity';
import { User } from '../../src/users/users.entity';
import { TeamsService } from '../../src/teams/teams.service';
import { JwtAuthGuard } from '../../src/common/guards/jwt-auth.guard';

const TEAM = randomUUID();
const memberships: Record<string, string[]> = {};
const teamsStub = {
  teamIdsForUser: async (u: string) => memberships[u] ?? [],
  isMember: async (t: string, u: string) => (memberships[u] ?? []).includes(t),
  isOwner: async (t: string, u: string) => t === TEAM && u === BID,
} as any;
const noop = {} as any;

let db: TestDb;
let app: INestApplication;
let current: { id: string; role: string }; // identity injected by the guard override
let BID: string; // team owner
let CID: string; // non-owner member
let DID: string; // outside the team
let teamToolId: string;
let ssrfToolId: string;

beforeAll(async () => {
  process.env.TOOL_SECRETS_KEY ||= 'a'.repeat(64);
  db = await startTestDb();
  const ds = db.dataSource;

  const service = new CustomToolsService(
    ds.getRepository(CustomTool),
    ds.getRepository(ToolSecret),
    noop, noop, noop, noop, noop, noop,
    teamsStub,
  );

  const users = ds.getRepository(User);
  const mk = async (email: string) => (await users.save(users.create({ email, name: email, password: 'x' }))).id;
  BID = await mk('b@e2e.local');
  CID = await mk('c@e2e.local');
  DID = await mk('d@e2e.local');
  memberships[CID] = [TEAM];

  // team tool (owner B) + http tool pointing to the metadata endpoint (owner B)
  const teamTool = await service.create(BID, {
    name: 'e2e_team', description: 'd', parameters: [],
    executorType: 'http', executorConfig: { url: 'https://example.com', method: 'GET' } as any,
    scope: 'team', teamId: TEAM,
  });
  teamToolId = teamTool.id;

  const ssrfTool = await service.create(BID, {
    name: 'e2e_ssrf', description: 'd', parameters: [],
    executorType: 'http',
    executorConfig: { url: 'http://169.254.169.254/latest/meta-data/', method: 'GET' } as any,
    scope: 'personal',
  });
  ssrfToolId = ssrfTool.id;

  const moduleRef = await Test.createTestingModule({
    controllers: [CustomToolsController],
    providers: [
      { provide: CustomToolsService, useValue: service },
      { provide: TeamsService, useValue: teamsStub },
    ],
  })
    .overrideGuard(JwtAuthGuard)
    .useValue({
      canActivate: (ctx: any) => { ctx.switchToHttp().getRequest().user = current; return true; },
    })
    .compile();

  app = moduleRef.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
}, 180_000);

afterAll(async () => { await app?.close(); await db?.stop(); });

describe('authorization on the endpoints', () => {
  it('a team member can READ the team tool (200)', async () => {
    current = { id: CID, role: 'user' };
    const res = await request(app.getHttpServer()).get(`/api/custom-tools/${teamToolId}`);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('e2e_team');
  });

  it('someone outside the team does NOT see the tool by id (404)', async () => {
    current = { id: DID, role: 'user' };
    const res = await request(app.getHttpServer()).get(`/api/custom-tools/${teamToolId}`);
    expect(res.status).toBe(404);
  });

  it('a NON-owner member cannot MANAGE the team tool (403)', async () => {
    current = { id: CID, role: 'user' };
    const res = await request(app.getHttpServer())
      .put(`/api/custom-tools/${teamToolId}`)
      .send({ description: 'modifica vietata' });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/tools\.teamForbidden/);
  });

  it('a non-admin cannot create an org tool (403)', async () => {
    current = { id: BID, role: 'user' };
    const res = await request(app.getHttpServer())
      .post('/api/custom-tools')
      .send({
        name: 'e2e_org_attempt', description: 'd',
        executorType: 'http', executorConfig: { url: 'https://example.com', method: 'GET' },
        scope: 'org',
      });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/tools\.orgForbidden/);
  });
});

describe('SSRF wiring + error reported to the user (§13.2)', () => {
  it('testing an http tool against the EC2 metadata is blocked and reported as a failure', async () => {
    current = { id: BID, role: 'user' };
    const res = await request(app.getHttpServer())
      .post(`/api/custom-tools/${ssrfToolId}/test`)
      .send({ args: {} });

    // §13.2: the SSRF block is communicated to the user as an explicit FAILURE
    // (throwOnError in the dry-run → success=false + message in `error`).
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/Internal destination not allowed/);
  });
});
