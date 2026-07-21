/**
 * T3 — HTTP e2e for data sources: real authorization on the endpoints +
 * the security invariant that the connection string NEVER leaks in the API
 * responses (not even for the owner).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { startTestDb, type TestDb } from './_db';
import { DataSourcesController } from '../../src/datasources/datasources.controller';
import { DataSourcesService } from '../../src/datasources/datasources.service';
import { DataSourceEntity } from '../../src/datasources/datasource.entity';
import { User } from '../../src/users/users.entity';
import { TeamsService } from '../../src/teams/teams.service';
import { SchemaEnrichmentService } from '../../src/datasources/schema-enrichment.service';
import { JwtAuthGuard } from '../../src/common/guards/jwt-auth.guard';

const TEAM = randomUUID();
// 127.0.0.1: an IP (host-guard skips DNS), private → allowed under the permissive default.
// `db.internal` resolves in the Docker network at runtime but not under testcontainers.
const CONN = 'postgres://user:secretpass@127.0.0.1:5432/app';

const configStub = { get: (_k: string, d?: any) => d } as any;
const appConfigStub = { findOne: async () => null } as any;
const memberships: Record<string, string[]> = {};
const teamsStub = {
  teamIdsForUser: async (u: string) => memberships[u] ?? [],
  isMember: async (t: string, u: string) => (memberships[u] ?? []).includes(t),
  isOwner: async (t: string, u: string) => t === TEAM && u === BID,
} as any;

let db: TestDb;
let app: INestApplication;
let current: { id: string; role: string };
let BID: string, CID: string, DID: string;
let teamDsId: string;

beforeAll(async () => {
  process.env.TOOL_SECRETS_KEY ||= 'a'.repeat(64);
  db = await startTestDb();
  const service = new DataSourcesService(db.dataSource.getRepository(DataSourceEntity), teamsStub, configStub, appConfigStub);

  const users = db.dataSource.getRepository(User);
  const mk = async (email: string) => (await users.save(users.create({ email, name: email, password: 'x' }))).id;
  BID = await mk('b@dse2e.local');
  CID = await mk('c@dse2e.local');
  DID = await mk('d@dse2e.local');
  memberships[CID] = [TEAM];

  const teamDs = await service.create(BID, { name: 'e2e_team_ds', connectionString: CONN, scope: 'team', teamId: TEAM });
  teamDsId = teamDs.id;

  const moduleRef = await Test.createTestingModule({
    controllers: [DataSourcesController],
    providers: [
      { provide: DataSourcesService, useValue: service },
      { provide: TeamsService, useValue: teamsStub },
      { provide: SchemaEnrichmentService, useValue: {} },
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

describe('authorization', () => {
  it('member reads the team data source (200)', async () => {
    current = { id: CID, role: 'user' };
    const res = await request(app.getHttpServer()).get(`/api/data-sources/${teamDsId}`);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('e2e_team_ds');
  });

  it('outside the team: 404 by id', async () => {
    current = { id: DID, role: 'user' };
    expect((await request(app.getHttpServer()).get(`/api/data-sources/${teamDsId}`)).status).toBe(404);
  });

  it('non-owner member cannot manage (403)', async () => {
    current = { id: CID, role: 'user' };
    const res = await request(app.getHttpServer())
      .put(`/api/data-sources/${teamDsId}`)
      .send({ description: 'vietato' });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/datasources\.teamForbidden/);
  });

  it('non-admin cannot create an org data source (403)', async () => {
    current = { id: BID, role: 'user' };
    const res = await request(app.getHttpServer())
      .post('/api/data-sources')
      .send({ name: 'e2e_org_ds', connectionString: CONN, scope: 'org' });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/datasources\.orgForbidden/);
  });
});

describe('the connection string does not leak in API responses', () => {
  it('GET by id does not expose the connection string (not even to the owner)', async () => {
    current = { id: BID, role: 'user' };
    const res = await request(app.getHttpServer()).get(`/api/data-sources/${teamDsId}`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('secretpass');
    expect(res.body).not.toHaveProperty('connectionString');
    expect(res.body).not.toHaveProperty('encryptedConnectionString');
  });

  it('GET list does not expose the connection string', async () => {
    current = { id: BID, role: 'user' };
    const res = await request(app.getHttpServer()).get('/api/data-sources');
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('secretpass');
  });
});
