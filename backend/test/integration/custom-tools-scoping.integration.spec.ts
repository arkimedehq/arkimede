/**
 * T1 — Integration with a real DB (testcontainers): `personal|team|org`
 * scoping of `CustomToolsService`. Verifies `visibilityWhere` / `findAll` /
 * `findOneAccessible` / precedence dedup / uniqueness against the real DB — the
 * logic a repository mock would NOT capture.
 *
 * Collaborators unrelated to scoping (datasource/embed/vector/llm/...) are
 * stubs; team membership is a controllable stub (input to the SUT).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { startTestDb, type TestDb } from './_db';
import { CustomToolsService } from '../../src/custom-tools/custom-tools.service';
import { CustomTool } from '../../src/custom-tools/custom-tool.entity';
import { ToolSecret } from '../../src/custom-tools/tool-secret.entity';
import { User } from '../../src/users/users.entity';

/** Per-user membership, driven by the tests (TeamsService stub). */
const memberships: Record<string, string[]> = {};
const teamsStub = {
  teamIdsForUser: async (userId: string) => memberships[userId] ?? [],
  isMember: async (teamId: string, userId: string) => (memberships[userId] ?? []).includes(teamId),
  isOwner: async () => false,
} as any;
const noop = {} as any;

const TEAM_VENDITE = randomUUID();
const TEAM_ALTRO = randomUUID();

let db: TestDb;
let dataSource: DataSource;
let service: CustomToolsService;
let B: string; // team owner
let C: string; // team member
let D: string; // outside the team

const httpCfg = { url: 'https://example.com', method: 'GET' as const };
const mkTool = (over: Partial<{ name: string; scope: any; teamId: string | null }>) => ({
  name: over.name ?? 'tool',
  description: 'desc',
  parameters: [],
  executorType: 'http' as const,
  executorConfig: httpCfg as any,
  scope: over.scope ?? 'personal',
  teamId: over.teamId ?? null,
});

beforeAll(async () => {
  db = await startTestDb();
  dataSource = db.dataSource;

  service = new CustomToolsService(
    dataSource.getRepository(CustomTool),
    dataSource.getRepository(ToolSecret),
    noop, noop, noop, noop, noop, noop,
    teamsStub,
  );

  const users = dataSource.getRepository(User);
  const mk = async (email: string) => (await users.save(users.create({ email, name: email, password: 'x' }))).id;
  B = await mk('b@test.local');
  C = await mk('c@test.local');
  D = await mk('d@test.local');

  memberships[B] = [TEAM_VENDITE];
  memberships[C] = [TEAM_VENDITE];
  memberships[D] = [];
}, 180_000);

afterAll(async () => { await db?.stop(); });

describe('scope personal', () => {
  it('the personal tool is visible only to its creator', async () => {
    await service.create(B, mkTool({ name: 'p_personal_b', scope: 'personal' }));

    const seenByB = (await service.findAll(B)).map((t) => t.name);
    const seenByC = (await service.findAll(C)).map((t) => t.name);
    expect(seenByB).toContain('p_personal_b');
    expect(seenByC).not.toContain('p_personal_b');
  });

  it('findOneAccessible denies another user\'s personal tool', async () => {
    const tool = await service.create(B, mkTool({ name: 'p_secret_b', scope: 'personal' }));
    await expect(service.findOneAccessible(tool.id, C)).rejects.toThrow(/not found/);
  });
});

describe('scope org', () => {
  it('the org tool is visible to everyone', async () => {
    await service.create(B, mkTool({ name: 'p_org', scope: 'org' }));
    for (const u of [B, C, D]) {
      expect((await service.findAll(u)).map((t) => t.name)).toContain('p_org');
    }
  });
});

describe('scope team', () => {
  it('the team tool is visible to members, not to those outside', async () => {
    await service.create(B, mkTool({ name: 'p_team', scope: 'team', teamId: TEAM_VENDITE }));

    expect((await service.findAll(C)).map((t) => t.name)).toContain('p_team');   // member
    expect((await service.findAll(D)).map((t) => t.name)).not.toContain('p_team'); // outside
  });

  it('a tool from a different team is not visible', async () => {
    await service.create(B, mkTool({ name: 'p_team_altro', scope: 'team', teamId: TEAM_ALTRO }));
    // C is a member only of TEAM_VENDITE
    expect((await service.findAll(C)).map((t) => t.name)).not.toContain('p_team_altro');
  });

  it('findOneAccessible: member yes, outsider no', async () => {
    const tool = await service.create(B, mkTool({ name: 'p_team_access', scope: 'team', teamId: TEAM_VENDITE }));
    await expect(service.findOneAccessible(tool.id, C)).resolves.toMatchObject({ name: 'p_team_access' });
    await expect(service.findOneAccessible(tool.id, D)).rejects.toThrow(/not found/);
  });
});

describe('creation constraints', () => {
  it('duplicate name for the same user → conflict', async () => {
    await service.create(B, mkTool({ name: 'p_dup', scope: 'personal' }));
    await expect(service.create(B, mkTool({ name: 'p_dup', scope: 'personal' }))).rejects.toThrow(/already have a tool/);
  });

  it('scope=team without teamId → BadRequest', async () => {
    await expect(service.create(B, mkTool({ name: 'p_noteam', scope: 'team', teamId: null }))).rejects.toThrow(/teamId/);
  });
});

describe('precedence dedup personal > team > org (loadToolsForUser)', () => {
  it('on name tie, the user\'s personal tool wins', async () => {
    // org (of B) + personal (of C) with the SAME name → C must see its own
    await service.create(B, { ...mkTool({ name: 'p_clash', scope: 'org' }), description: 'da-org' });
    await service.create(C, { ...mkTool({ name: 'p_clash', scope: 'personal' }), description: 'da-personale' });

    const tools = await service.loadToolsForUser(C);
    const clash = tools.filter((t) => t.name === 'p_clash');
    expect(clash).toHaveLength(1);
    expect(clash[0].description).toBe('da-personale');
  });
});
