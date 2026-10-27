// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Recordare regression checklist (Recordare WORK_PLAN 6.4): with Recordare integrated, A-MEM, `search_memory` and
 * `search_conversations` behave as before it, on a real database.
 *   - Retrieval: the notes a user with automatic memory gets (pinned prefix, per-query FTS leg, vector-leg filters)
 *     equal what the pre-Recordare queries return — the baseline SQL is copied below from Arkimede before Recordare
 *     (`ba089fc^`, user-memory.service.ts) and run on the same rows.
 *   - Conversation search: own chats and chats of accessible projects only, external chats (voice / API) included
 *     like any chat; error turns stay searchable (they are kept out of Recordare only).
 *   - Tools: same names and arguments (one string `query`).
 *   - Private memories (Recordare 0.5.0, its API.md §1/§2/§4): a private chat reaches the ingest with its messages
 *     `private: true`, a later change goes out as the message's current flag, the Diary keeps the private marks and an
 *     empty private list stays empty — against a stub Recordare, on the real outbox rows.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { In } from 'typeorm';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { startTestDb, type TestDb } from './_db';
import { UserMemoryService } from '../../src/user-memory/user-memory.service';
import { UserMemory } from '../../src/user-memory/user-memory.entity';
import { Chat } from '../../src/chats/chats.entity';
import { Message } from '../../src/messages/messages.entity';
import { User } from '../../src/users/users.entity';
import { Team } from '../../src/teams/team.entity';
import { Project } from '../../src/projects/projects.entity';
import { ProjectTeam } from '../../src/projects/project-team.entity';
import { UserMemoryFts1785300000070 } from '../../src/database/migrations/1785300000070-UserMemoryFts';
import { MessagesFts1785600000073 } from '../../src/database/migrations/1785600000073-MessagesFts';
import { RecordareMemory1787200000090 } from '../../src/database/migrations/1787200000090-RecordareMemory';
import { RecordareMessageSubscriber } from '../../src/recordare/recordare-message.subscriber';
import { RecordareOutboxService } from '../../src/recordare/recordare-outbox.service';
import { RecordareDiaryController } from '../../src/recordare/recordare-diary.controller';
import { MessagesService } from '../../src/messages/messages.service';

/** Pre-Recordare retrieval (ba089fc^): FTS leg, then the accessible notes among its ids. */
const BASELINE_FTS = `SELECT "id" FROM "user_memory"
              WHERE "status" = 'confirmed' AND "pinned" = false
                AND (("scope" = 'personal' AND "userId" = $1)
                  OR ("scope" = 'team' AND "teamId" = ANY($3::uuid[]))
                  OR "scope" = 'org')
                AND "tsv" @@ to_tsquery('simple', $2)
              ORDER BY ts_rank("tsv", to_tsquery('simple', $2)) DESC
              LIMIT 12`;
const baselineTerms = (q: string) => [...new Set(q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2))].slice(0, 16).join(' | ');

const memberships: Record<string, string[]> = {};
let db: TestDb;
let svc: UserMemoryService;
const vectorFilters: Array<Record<string, unknown>> = [];
let ana: string, bruno: string, team: string;

beforeAll(async () => {
  db = await startTestDb();
  const ds = db.dataSource;
  await new UserMemoryFts1785300000070().up(ds.createQueryRunner());
  await new MessagesFts1785600000073().up(ds.createQueryRunner());

  const embedding = { embed: async () => [0.1, 0.2], getVectorSize: async () => 2 };
  const vectorStore = { search: async (_c: string, _v: number[], _k: number, filter: Record<string, unknown>) => { vectorFilters.push(filter); return []; } };
  const teams = { teamIdsForUser: async (u: string) => memberships[u] ?? [] };
  svc = new UserMemoryService(
    ds.getRepository(UserMemory), ds.getRepository(Chat), ds.getRepository(Message), ds.getRepository(User),
    {} as any, {} as any, embedding as any, vectorStore as any, teams as any, {} as any,
  );

  const users = ds.getRepository(User);
  const mk = async (email: string) => (await users.save(users.create({ email, name: email, password: 'x', autoMemoryEnabled: true, sharedMemoryEnabled: true }))).id;
  ana = await mk('ana@mem.local');
  bruno = await mk('bruno@mem.local');
  team = (await ds.getRepository(Team).save({ name: 'cantiere' })).id;
  memberships[ana] = [team];

  const notes = ds.getRepository(UserMemory);
  const note = (userId: string, content: string, extra: Partial<UserMemory> = {}) =>
    notes.save(notes.create({ userId, content, status: 'confirmed', scope: 'personal', pinned: false, ...extra }));
  await note(ana, 'Ana prefers PostgreSQL for every new database');
  await note(ana, 'Ana backs up the NAS database every Sunday night');
  await note(ana, 'Ana answers in Italian', { pinned: true });
  await note(ana, 'Ana wonders whether to drop the database', { status: 'pending' });
  await note(bruno, 'Bruno prefers MySQL as database');
  await note(bruno, 'Bruno shares the database naming rule', { scope: 'team', teamId: team });
  await note(bruno, 'Company database servers live in Milan', { scope: 'org' });
  await note(bruno, 'Company style guide is pinned for everyone', { scope: 'org', pinned: true });

  const chats = ds.getRepository(Chat);
  const messages = ds.getRepository(Message);
  const project = await ds.getRepository(Project).save({ name: 'Cantiere', userId: bruno });
  await ds.getRepository(ProjectTeam).save({ projectId: project.id, teamId: team });
  const say = async (chat: Partial<Chat>, role: string, content: string) => {
    const c = await chats.save(chats.create(chat));
    await messages.save(messages.create({ chatId: c.id, role, content } as Partial<Message>));
  };
  await say({ title: 'Backup', userId: ana }, 'user', 'the backup schedule of the NAS moves to Sunday');
  await say({ title: 'Kitchen', userId: ana, externalSource: 'wyoming', externalKey: 'kitchen' }, 'user', 'remind me the NAS backup by voice');
  await say({ title: 'Broken', userId: ana }, 'assistant', '⚠️ the model failed while reading the NAS backup');
  await say({ title: 'Project chat', userId: bruno, projectId: project.id }, 'user', 'NAS backup for the project files');
  await say({ title: 'Private', userId: bruno }, 'user', 'my own NAS backup secret');
}, 120_000);

afterAll(async () => { await db?.stop(); });

describe('A-MEM retrieval as before Recordare (6.4)', () => {
  it('the per-query notes equal the pre-Recordare query, for the default and for both toggles on', async () => {
    for (const q of ['which database do we use?', 'NAS backup on Sunday', 'naming rule for servers']) {
      const ftsIds: Array<{ id: string }> = await db.dataSource.query(BASELINE_FTS, [ana, baselineTerms(q), memberships[ana]]);
      const expected = ftsIds.map((r) => r.id).slice(0, 8);
      expect(expected.length).toBeGreaterThan(0);
      expect((await svc.retrieve(ana, q)).map((n) => n.id)).toEqual(expected);
      expect((await svc.retrieve(ana, q, { personal: true, shared: true })).map((n) => n.id)).toEqual(expected);
    }
    const seen = (await svc.retrieve(ana, 'database')).map((n) => n.content);
    expect(seen).not.toContain('Bruno prefers MySQL as database');                // someone else's personal note
    expect(seen).not.toContain('Ana wonders whether to drop the database');      // pending
  });

  it('the vector leg searches the same scopes: own notes, org, each team', async () => {
    vectorFilters.length = 0;
    await svc.retrieve(ana, 'database');
    expect(vectorFilters).toEqual([{ userId: ana }, { scope: 'org' }, { scope: 'team', teamId: team }]);
  });

  it('pinned notes: own, team and org, oldest first', async () => {
    const pinned = await db.dataSource.getRepository(UserMemory).find({
      where: [
        { status: 'confirmed', pinned: true, scope: 'personal', userId: ana },
        { status: 'confirmed', pinned: true, scope: 'team', teamId: In([team]) },
        { status: 'confirmed', pinned: true, scope: 'org' },
      ],
      order: { createdAt: 'ASC' },
    });
    expect(await svc.getPinnedContents(ana)).toEqual(pinned.map((n) => n.content));
    expect(await svc.getPinnedContents(ana)).toEqual(['Ana answers in Italian', 'Company style guide is pinned for everyone']);
  });
});

describe('search_conversations as before Recordare (6.4)', () => {
  it('own chats and the chats of accessible projects, external and error turns included; never another user\'s', async () => {
    const titles = (await svc.searchConversations(ana, 'NAS backup')).map((h) => h.chatTitle).sort();
    expect(titles).toEqual(['Backup', 'Broken', 'Kitchen', 'Project chat']);
    expect((await svc.searchConversations(bruno, 'NAS backup')).map((h) => h.chatTitle).sort()).toEqual(['Private', 'Project chat']);
  });
});

describe('memory tools as before Recordare (6.4)', () => {
  it('same names and arguments', () => {
    const tools = svc.buildMemoryTools(ana, undefined, { personal: true, shared: true });
    expect(tools.map((t) => t.name)).toEqual(['save_memory', 'search_memory', 'search_conversations']);
    for (const t of tools) {
      const schema = zodToJsonSchema(t.schema as any) as { properties: Record<string, { type: string }>; required: string[] };
      expect(Object.keys(schema.properties)).toHaveLength(1);
      expect(schema.required).toHaveLength(1);
      expect(schema.properties[schema.required[0]!]!.type).toBe('string');
    }
    expect(svc.buildMemoryTools(ana).map((t) => t.name)).toEqual(tools.map((t) => t.name));
  });
});

describe('private memories reach Recordare (0.5.0)', () => {
  /** Stub Recordare: records the requests, answers the Diary reads from `diary`. */
  const requests: Array<{ method: string; path: string; body: any }> = [];
  const diary: Record<string, unknown> = {};
  let stub: Server;
  let carla: string, privateChat: string, publicChat: string;

  beforeAll(async () => {
    stub = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const path = req.url!.split('?')[0]!;
        requests.push({ method: req.method!, path, body: raw ? JSON.parse(raw) : undefined });
        const json = (status: number, body?: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
        if (path === '/api/v1/ingest/messages') return json(200, { conversationId: 'conv', accepted: JSON.parse(raw).messages.length, duplicates: 0, conflicts: [] });
        if (req.method === 'PATCH') return json(204);
        if (path === '/api/v1/me') return json(200, { memoryId: 'mem-carla', displayName: 'Carla' });
        if (path in diary) return json(200, diary[path]);
        json(404);
      });
    });
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
    process.env.RECORDARE_URL = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
    process.env.RECORDARE_API_KEY = 'rk_regression';

    const ds = db.dataSource;
    await new RecordareMemory1787200000090().up(ds.createQueryRunner());
    new RecordareMessageSubscriber(ds);
    const users = ds.getRepository(User);
    carla = (await users.save(users.create({ email: 'carla@mem.local', name: 'Carla', password: 'x', episodicMemoryEnabled: true }))).id;
    const chats = ds.getRepository(Chat);
    privateChat = (await chats.save(chats.create({ title: 'Surprise', userId: carla, isPrivate: true }))).id;
    publicChat = (await chats.save(chats.create({ title: 'Groceries', userId: carla }))).id;
  });

  afterAll(async () => {
    delete process.env.RECORDARE_URL; delete process.env.RECORDARE_API_KEY;
    await new Promise<void>((r) => stub.close(() => r()));
  });

  const outbox = () => new RecordareOutboxService(db.dataSource, { cachedMemoryId: () => undefined } as any);
  const say = (chatId: string, role: 'user' | 'assistant', content: string, isPrivate = false) =>
    db.dataSource.getRepository(Message).save({ chatId, role, content, authorId: role === 'user' ? carla : null, isPrivate });

  it('a private chat is ingested with its person\'s messages private: true; a public one without the flag', async () => {
    // Messages are saved with the chat's switch, as the chat stream does (MessagesController).
    const mine = await say(privateChat, 'user', 'I am planning a surprise party for Marta', true);
    const reply = await say(privateChat, 'assistant', 'I will keep it between us.');
    const open = await say(publicChat, 'user', 'buy milk');
    expect(await outbox().drain()).toMatchObject({ sent: 3, parked: 0 });

    const ingests = requests.filter((r) => r.path === '/api/v1/ingest/messages').map((r) => r.body);
    const priv = ingests.find((b) => b.conversation.externalId === privateChat)!;
    expect(priv.messages.map((m: any) => [m.externalId, m.private])).toEqual([[mine.id, true], [reply.id, undefined]]);
    const pub = ingests.find((b) => b.conversation.externalId === publicChat)!;
    expect(pub.messages).toEqual([expect.not.objectContaining({ private: expect.anything() })]);
    expect(pub.messages[0].externalId).toBe(open.id);
  });

  it('making a message public again goes out as its current flag', async () => {
    const [mine] = await db.dataSource.getRepository(Message).find({ where: { chatId: privateChat, role: 'user' } });
    requests.length = 0;
    await new MessagesService(db.dataSource.getRepository(Message)).setPrivate({ id: privateChat, userId: carla }, mine!.id, carla, false);
    expect(await outbox().drain()).toMatchObject({ sent: 1 });
    expect(requests).toEqual([{ method: 'PATCH', path: `/api/v1/ingest/conversations/${privateChat}/messages/${mine!.id}`, body: { private: false } }]);
    expect((await db.dataSource.getRepository(Message).findOneBy({ id: mine!.id }))!.isPrivate).toBe(false);
  });

  it('the Diary keeps whose a private memory is, and an empty private list stays empty', async () => {
    const ctrl = new RecordareDiaryController(db.dataSource.getRepository(User), {} as any, {} as any);
    diary['/api/v1/episodes'] = { items: [
      { id: 'e1', content: 'Planning a surprise party for Marta', private: { by: ['Carla'] } },
      { id: 'e2', content: 'Bought milk' },
    ], nextCursor: null };
    diary['/api/v1/private'] = [];
    const episodes = await ctrl.episodes({ id: carla } as User);
    expect(episodes.items.map((e) => e.private ?? null)).toEqual([{ by: ['Carla'] }, null]);
    expect(await ctrl.privateItems({ id: carla } as User)).toEqual([]);
  });
});
