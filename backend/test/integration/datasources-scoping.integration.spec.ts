/**
 * T1 — Integration with a real DB: `personal|team|org` scoping of
 * `DataSourcesService` + two security invariants specific to data sources:
 *   - the connection string is encrypted at rest (A1) and never exposed in DTOs;
 *   - `resolveDataSource` decrypts it correctly (round-trip).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startTestDb, type TestDb } from './_db';
import { DataSourcesService } from '../../src/datasources/datasources.service';
import { DataSourceEntity } from '../../src/datasources/datasource.entity';
import { User } from '../../src/users/users.entity';

const memberships: Record<string, string[]> = {};
const teamsStub = {
  teamIdsForUser: async (u: string) => memberships[u] ?? [],
  isMember: async (t: string, u: string) => (memberships[u] ?? []).includes(t),
  isOwner: async () => false,
} as any;

const TEAM_VENDITE = randomUUID();
const TEAM_ALTRO = randomUUID();
// 127.0.0.1: an IP (the host-guard skips DNS) that is private, so it passes under the
// permissive default policy. A DNS name like `db.internal` resolves in the Docker network
// at runtime but not under testcontainers, where the guard would reject it as unresolvable.
const CONN = 'postgres://user:pass@127.0.0.1:5432/app';

// The SSRF host-guard reads its policy from app_config; a repo returning null yields the
// permissive default (allow private hosts). ConfigService is only used for file-share paths.
const configStub = { get: (_k: string, d?: any) => d } as any;
const appConfigStub = { findOne: async () => null } as any;

let db: TestDb;
let service: DataSourcesService;
let B: string, C: string, D: string;

const mkDs = (over: Partial<{ name: string; scope: any; teamId: string | null }>) => ({
  name: over.name ?? 'ds',
  connectionString: CONN,
  scope: over.scope ?? 'personal',
  teamId: over.teamId ?? null,
});

beforeAll(async () => {
  process.env.TOOL_SECRETS_KEY ||= 'a'.repeat(64);
  db = await startTestDb();

  service = new DataSourcesService(db.dataSource.getRepository(DataSourceEntity), teamsStub, configStub, appConfigStub);

  const users = db.dataSource.getRepository(User);
  const mk = async (email: string) => (await users.save(users.create({ email, name: email, password: 'x' }))).id;
  B = await mk('b@ds.local');
  C = await mk('c@ds.local');
  D = await mk('d@ds.local');
  memberships[B] = [TEAM_VENDITE];
  memberships[C] = [TEAM_VENDITE];
  memberships[D] = [];
}, 180_000);

afterAll(async () => { await db?.stop(); });

describe('scoping', () => {
  it('personal: visible only to the creator', async () => {
    await service.create(B, mkDs({ name: 'ds_personal_b', scope: 'personal' }));
    expect((await service.findAll(B)).map((d) => d.name)).toContain('ds_personal_b');
    expect((await service.findAll(C)).map((d) => d.name)).not.toContain('ds_personal_b');
  });

  it('another user\'s personal: findOneAccessible denies', async () => {
    const ds = await service.create(B, mkDs({ name: 'ds_secret_b', scope: 'personal' }));
    await expect(service.findOneAccessible(ds.id, C)).rejects.toThrow(/not found/);
  });

  it('org: visible to everyone', async () => {
    await service.create(B, mkDs({ name: 'ds_org', scope: 'org' }));
    for (const u of [B, C, D]) {
      expect((await service.findAll(u)).map((d) => d.name)).toContain('ds_org');
    }
  });

  it('team: visible to members, not to outsiders nor to other teams', async () => {
    await service.create(B, mkDs({ name: 'ds_team', scope: 'team', teamId: TEAM_VENDITE }));
    await service.create(B, mkDs({ name: 'ds_team_altro', scope: 'team', teamId: TEAM_ALTRO }));

    expect((await service.findAll(C)).map((d) => d.name)).toContain('ds_team');
    expect((await service.findAll(C)).map((d) => d.name)).not.toContain('ds_team_altro');
    expect((await service.findAll(D)).map((d) => d.name)).not.toContain('ds_team');
  });

  it('findOneAccessible: member yes, outsider no', async () => {
    const ds = await service.create(B, mkDs({ name: 'ds_team_access', scope: 'team', teamId: TEAM_VENDITE }));
    await expect(service.findOneAccessible(ds.id, C)).resolves.toMatchObject({ name: 'ds_team_access' });
    await expect(service.findOneAccessible(ds.id, D)).rejects.toThrow(/not found/);
  });
});

describe('creation constraints', () => {
  it('duplicate org name → conflict', async () => {
    await service.create(B, mkDs({ name: 'ds_dup_org', scope: 'org' }));
    await expect(service.create(C, mkDs({ name: 'ds_dup_org', scope: 'org' }))).rejects.toThrow(/org data source already exists/);
  });

  it('scope=team without teamId → BadRequest', async () => {
    await expect(service.create(B, mkDs({ name: 'ds_noteam', scope: 'team', teamId: null }))).rejects.toThrow(/teamId/);
  });
});

describe('connection string: encrypted at rest and never exposed (A1)', () => {
  it('DTOs do not contain the connection string in any form', async () => {
    await service.create(B, mkDs({ name: 'ds_leak', scope: 'personal' }));

    const inList = (await service.findAll(B)).find((d) => d.name === 'ds_leak')!;
    expect(inList).not.toHaveProperty('connectionString');
    expect(inList).not.toHaveProperty('encryptedConnectionString');
    expect(JSON.stringify(inList)).not.toContain('db.internal');
  });

  it('at rest it is encrypted (iv:tag:ct), never in cleartext', async () => {
    const created = await service.create(B, mkDs({ name: 'ds_atrest', scope: 'personal' }));
    const row = await db.dataSource.getRepository(DataSourceEntity).findOneByOrFail({ id: created.id });
    expect(row.encryptedConnectionString).not.toBe(CONN);
    expect(row.encryptedConnectionString).not.toContain('127.0.0.1');
    expect(row.encryptedConnectionString).not.toContain('pass');
    expect(row.encryptedConnectionString.split(':')).toHaveLength(3);
  });

  it('resolveDataSource decrypts correctly (round-trip)', async () => {
    const created = await service.create(B, mkDs({ name: 'ds_resolve', scope: 'personal' }));
    const resolved = await service.resolveDataSource(created.id, B);
    expect(resolved.connectionString).toBe(CONN);
  });
});
