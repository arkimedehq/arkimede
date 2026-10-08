// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Recordare as the episodic memory, against a fake Recordare (local HTTP stub):
 * identity lookup + naming + caching; outbox enqueue (gated, savepoint-safe,
 * no-op when off), send, retry with back-off, parking, idempotent externalIds;
 * MCP calls carry the user AND conversation headers on every request; tracing
 * spans get recordare.owner_id when the mapping is known.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { RecordareIdentityService, RecordareMemoryNotEmptyError } from '../../src/recordare/recordare-identity.service';
import { RecordareOutboxService } from '../../src/recordare/recordare-outbox.service';
import { DEFAULT_DELIVERY, backoffMs } from '../../src/recordare/client';

const MAX_ATTEMPTS = DEFAULT_DELIVERY.maxAttempts;
import { RecordareMcpService } from '../../src/recordare/recordare-mcp.service';
import { RecordareDiaryController } from '../../src/recordare/recordare-diary.controller';
import {
  enqueueRecordareMessage, enqueueRecordareMessageDeletes, enqueueRecordareConversationDelete,
  setConsentOffProvider, withoutRecordareIngest,
} from '../../src/recordare/recordare-outbox';
import { buildIngestBody, clipUtf8 } from '../../src/recordare/recordare-ingest.mapper';
import { GenAiTraceHandler, setRecordareOwnerResolver } from '../../src/observability/genai-trace.handler';
import { runWithLlmCallContext } from '../../src/usage/llm-call-context';

// ── Fake Recordare ─────────────────────────────────────────────────────────

interface Seen { method: string; path: string; headers: IncomingMessage['headers']; body: any }

const seen: Seen[] = [];
let sessions = 0;
/** Users whose consent the fake Recordare reports as given (GET /me → episodicEnabled). */
const consented = new Set<string>();
/** Per-route override: return a status (and optional body) for the next matching requests. */
let respond: (req: Seen) => { status: number; body?: any; headers?: Record<string, string> } | undefined = () => undefined;
let server: Server;
let baseUrl: string;

function handle(req: IncomingMessage, res: ServerResponse): void {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const s: Seen = { method: req.method!, path: req.url!, headers: req.headers, body: raw ? JSON.parse(raw) : undefined };
    seen.push(s);
    const custom = respond(s);
    const send = (status: number, body?: any, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    if (custom) return send(custom.status, custom.body, custom.headers);
    if (s.path === '/api/v1/me' && s.method === 'GET') {
      const u = String(s.headers['x-recordare-user']);
      return send(200, { ownerId: `owner-of-${u}`, displayName: u, episodicEnabled: consented.has(u) });
    }
    if (s.path === '/api/v1/me' && s.method === 'PATCH') return send(204);
    if (s.path.startsWith('/api/v1/episodes')) return send(200, { items: [{ id: 'e1', content: 'Gita a Bologna' }], nextCursor: null });
    if (s.path === '/api/v1/context') return send(200, { block: `<memory-context>\n- fact: car = Yaris\n</memory-context>`, items: 1 });
    if (s.path === '/api/v1/ingest/messages') return send(200, { conversationId: 'c', accepted: s.body.messages.length, duplicates: 0, conflicts: [], stored: false });
    if (s.method === 'DELETE') return send(202, { jobId: 'j' });
    if (s.path === '/mcp' && s.method === 'GET') return send(405); // no server-initiated stream
    if (s.path === '/mcp' && s.method === 'DELETE') return send(200);
    if (s.path === '/mcp') {
      if (s.body?.method === 'initialize') {
        return send(200, { jsonrpc: '2.0', id: s.body.id, result: {
          protocolVersion: s.body.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'recordare', version: '0' } } },
        { 'mcp-session-id': `sess-${++sessions}` });
      }
      if (s.body?.method === 'notifications/initialized') return send(202);
      if (s.body?.method === 'tools/list') {
        const tool = (name: string, props: Record<string, unknown> = {}) => ({ name, description: `${name} (Recordare)`, inputSchema: { type: 'object', properties: props } });
        return send(200, { jsonrpc: '2.0', id: s.body.id, result: { tools: [
          tool('search_episodes', { query: { type: 'string' }, mode: { type: 'string', enum: ['search', 'list', 'latest'] } }),
          tool('search_memory', { query: { type: 'string' } }), tool('resolve_period', { expression: { type: 'string' } }),
          tool('log_episode'), tool('remember'), tool('correct_episode'), tool('forget_episode'),
        ] } });
      }
      if (s.body?.method === 'tools/call') return send(200, { jsonrpc: '2.0', id: s.body.id, result: { content: [{ type: 'text', text: JSON.stringify({ episodes: [], notes: ['nothing to show here'] }) }] } });
    }
    send(404);
  });
}

beforeAll(async () => {
  server = createServer(handle);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

function configure(on: boolean): void {
  if (on) { process.env.RECORDARE_URL = baseUrl; process.env.RECORDARE_API_KEY = 'rk_test_key'; }
  else { delete process.env.RECORDARE_URL; delete process.env.RECORDARE_API_KEY; }
}

beforeEach(() => { seen.length = 0; consented.clear(); respond = () => undefined; configure(true); });
afterEach(() => { configure(false); setRecordareOwnerResolver(null); setConsentOffProvider(null); });


// ── Identity ────────────────────────────────────────────────────────────────

function fakeUsers(rows: Record<string, any>) {
  const updates: any[] = [];
  return {
    updates,
    repo: {
      findOne: async ({ where }: any) => (rows[where.id] ? { ...rows[where.id] } : null),
      update: async (id: string, patch: any) => { updates.push({ id, ...patch }); Object.assign(rows[id], patch); },
    } as any,
  };
}

describe('RecordareIdentityService', () => {
  it('provisions via GET /me, stores the ownerId, names the person, then serves from cache', async () => {
    const { repo, updates } = fakeUsers({ u1: { id: 'u1', name: 'Andrea', episodicMemoryEnabled: true, recordareOwnerId: null } });
    const svc = new RecordareIdentityService(repo);
    expect(await svc.ensureOwner('u1')).toBe('owner-of-u1');
    expect(updates).toEqual([{ id: 'u1', recordareOwnerId: 'owner-of-u1' }]);
    const me = seen.find((s) => s.method === 'GET')!;
    expect(me.headers['x-recordare-user']).toBe('u1');
    expect(me.headers.authorization).toBe('Bearer rk_test_key');
    const patch = seen.find((s) => s.method === 'PATCH')!;
    expect(patch.body).toEqual({ displayName: 'Andrea' });

    seen.length = 0;
    expect(svc.cachedOwnerId('u1')).toBe('owner-of-u1');
    expect(await svc.ensureOwner('u1')).toBe('owner-of-u1'); // stored column: no further GET
    expect(seen.filter((s) => s.path === '/api/v1/me')).toHaveLength(0);
  });

  it('cachedOwnerId never waits: undefined first, background lookup, value afterwards', async () => {
    const { repo } = fakeUsers({ u2: { id: 'u2', name: 'B', episodicMemoryEnabled: true, recordareOwnerId: null } });
    const svc = new RecordareIdentityService(repo);
    expect(svc.cachedOwnerId('u2')).toBeUndefined();
    // The background lookup does real HTTP round trips to the stub: wait for it instead of a fixed number of ticks
    // (it is slower when the whole suite runs).
    await vi.waitFor(() => expect(svc.cachedOwnerId('u2')).toBe('owner-of-u2'));
    expect(svc.cachedOwnerId('u2')).toBe('owner-of-u2');
  });

  it('a naming failure never fails the lookup', async () => {
    respond = (s) => (s.method === 'PATCH' ? { status: 403, body: { title: 'Forbidden' } } : undefined);
    const { repo } = fakeUsers({ u3: { id: 'u3', name: 'C', episodicMemoryEnabled: true, recordareOwnerId: null } });
    expect(await new RecordareIdentityService(repo).ensureOwner('u3')).toBe('owner-of-u3');
  });

  it('keeps the name in sync with the profile: renames only when it differs', async () => {
    respond = (s) => (s.method === 'GET' && s.path === '/api/v1/me'
      ? { status: 200, body: { ownerId: 'owner-of-u6', displayName: 'Andrea', episodicEnabled: true } } : undefined);
    const rows = { u6: { id: 'u6', name: 'Andrea', episodicMemoryEnabled: true, recordareOwnerId: 'owner-of-u6' } };
    const svc = new RecordareIdentityService(fakeUsers(rows).repo);
    await svc.status('u6', true);
    expect(seen.filter((s) => s.method === 'PATCH')).toHaveLength(0); // same name: nothing to do
    rows.u6.name = 'Andrea G.';
    svc.invalidate('u6'); // the profile changed (UsersService invalidates on rename)
    await svc.status('u6', true);
    expect(seen.filter((s) => s.method === 'PATCH').map((s) => s.body)).toEqual([{ displayName: 'Andrea G.' }]);
  });

  it('reads the kind of memory and the Atlas address, and maps a refused kind change', async () => {
    respond = (s) => {
      if (s.method === 'GET' && s.path === '/api/v1/me') {
        return { status: 200, body: { ownerId: 'owner-of-u7', displayName: 'Voice', episodicEnabled: true, kind: 'entity', atlasUrl: 'http://atlas:5175' } };
      }
      return s.method === 'PATCH' && s.body?.kind ? { status: 409, body: { title: 'Conflict' } } : undefined;
    };
    const svc = new RecordareIdentityService(fakeUsers({ u7: { id: 'u7', name: 'Voice', episodicMemoryEnabled: true, recordareOwnerId: 'owner-of-u7' } }).repo);
    expect(await svc.status('u7', true)).toBe('active');
    expect(svc.details('u7')).toEqual({ kind: 'entity', atlasUrl: 'http://atlas:5175' });
    await expect(svc.setKind('u7', 'human')).rejects.toBeInstanceOf(RecordareMemoryNotEmptyError);
    expect(seen.filter((s) => s.method === 'PATCH').map((s) => s.body)).toEqual([{ kind: 'human' }]);
  });

  it('never provisions a user whose switch is off, nor when Recordare is not configured', async () => {
    const { repo } = fakeUsers({ u4: { id: 'u4', name: 'D', episodicMemoryEnabled: false, recordareOwnerId: null } });
    expect(await new RecordareIdentityService(repo).ensureOwner('u4')).toBeNull();
    configure(false);
    const { repo: repo2 } = fakeUsers({ u5: { id: 'u5', name: 'E', episodicMemoryEnabled: true, recordareOwnerId: null } });
    expect(await new RecordareIdentityService(repo2).ensureOwner('u5')).toBeNull();
    expect(seen).toHaveLength(0);
  });
});

// ── Consent state ───────────────────────────────────────────────────────────

describe('consent state (GET /me → episodicEnabled)', () => {
  it('status: off (switch off / not configured), waiting_activation, active, unknown (Recordare down)', async () => {
    const { repo } = fakeUsers({
      on: { id: 'on', name: 'A', episodicMemoryEnabled: true, recordareOwnerId: null },
      wait: { id: 'wait', name: 'W', episodicMemoryEnabled: true, recordareOwnerId: null },
      down: { id: 'down', name: 'D', episodicMemoryEnabled: true, recordareOwnerId: 'owner-x' },
    });
    consented.add('on');
    const svc = new RecordareIdentityService(repo);
    (repo as any).find = async () => [{ id: 'down', recordareOwnerId: 'owner-x' }]; // stored ids, loaded at start
    await svc.warm();
    expect(await svc.status('on', false)).toBe('off');
    expect(await svc.status('on', true)).toBe('active');
    expect(await svc.status('wait', true)).toBe('waiting_activation');
    respond = (s) => (s.path === '/api/v1/me' ? { status: 503 } : undefined);
    expect(await svc.status('down', true)).toBe('unknown');
    expect(svc.cachedOwnerId('down')).toBe('owner-x'); // stored id kept when Recordare is down
    configure(false);
    expect(await svc.status('on', true)).toBe('off');
  });

  it('every profile read re-checks: consent given later by the admin becomes active', async () => {
    const { repo } = fakeUsers({ u: { id: 'u', name: 'U', episodicMemoryEnabled: true, recordareOwnerId: null } });
    const svc = new RecordareIdentityService(repo);
    expect(await svc.status('u', true)).toBe('waiting_activation');
    expect(svc.consentKnownOff()).toEqual(['u']);
    consented.add('u');
    expect(await svc.status('u', true)).toBe('active');
    expect(svc.consentKnownOff()).toEqual([]);
  });

  it('registers the known-off list with the outbox: those owners are skipped in the enqueue statement', async () => {
    const { repo } = fakeUsers({ u: { id: 'u', name: 'U', episodicMemoryEnabled: true, recordareOwnerId: null } });
    const svc = new RecordareIdentityService(repo);
    svc.onModuleInit();
    await svc.status('u', true); // consent off
    const r = fakeRunner();
    await enqueueRecordareMessage(r, { id: 'm1', chatId: 'c1', role: 'user' });
    expect(r.calls[0].sql).toMatch(/NOT \(c\."userId" = ANY\(\$3::uuid\[\]\)\)/);
    expect(r.calls[0].params).toEqual(['m1', 'c1', ['u']]);
    svc.invalidate('u'); // the switch changed: unknown again → enqueued as usual
    const r2 = fakeRunner();
    await enqueueRecordareMessage(r2, { id: 'm2', chatId: 'c1', role: 'user' });
    expect(r2.calls[0].params).toEqual(['m2', 'c1', []]);
  });
});

// ── Outbox: enqueue ─────────────────────────────────────────────────────────

function fakeRunner(opts: { inTx?: boolean; failOn?: RegExp } = {}) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  return {
    calls,
    isTransactionActive: !!opts.inTx,
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql: sql.trim(), params });
      if (opts.failOn?.test(sql)) throw new Error('relation "recordare_outbox" does not exist');
      return [];
    },
  } as any;
}

describe('outbox enqueue', () => {
  it('is a no-op (no query at all) when Recordare is not configured', async () => {
    configure(false);
    const r = fakeRunner({ inTx: true });
    await enqueueRecordareMessage(r, { id: 'm1', chatId: 'c1', role: 'user' });
    await enqueueRecordareMessageDeletes(r, 'c1', ['m1']);
    await enqueueRecordareConversationDelete(r, 'c1');
    expect(r.calls).toHaveLength(0);
  });

  it('gates on the chat owner\'s episodicMemoryEnabled inside the INSERT, never sends system messages', async () => {
    const r = fakeRunner();
    await enqueueRecordareMessage(r, { id: 'm1', chatId: 'c1', role: 'assistant' });
    await enqueueRecordareMessage(r, { id: 'm2', chatId: 'c1', role: 'system' });
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].sql).toMatch(/INSERT INTO "recordare_outbox"/);
    expect(r.calls[0].sql).toMatch(/"episodicMemoryEnabled" = true/);
    expect(r.calls[0].params).toEqual(['m1', 'c1', []]);
  });

  it('inside a transaction uses a savepoint and swallows failures (the chat save is never aborted)', async () => {
    const r = fakeRunner({ inTx: true, failOn: /INSERT/ });
    await expect(enqueueRecordareMessage(r, { id: 'm1', chatId: 'c1', role: 'user' })).resolves.toBeUndefined();
    const sqls = r.calls.map((c: any) => c.sql.split(/\s+/).slice(0, 3).join(' '));
    expect(sqls[0]).toMatch(/^SAVEPOINT recordare_outbox_\d+/);
    expect(sqls[1]).toMatch(/^INSERT INTO/);
    expect(sqls[2]).toMatch(/^ROLLBACK TO SAVEPOINT/);
  });

  it('error turns (saved inside withoutRecordareIngest) are never enqueued', async () => {
    const r = fakeRunner({ inTx: true });
    await withoutRecordareIngest(() => enqueueRecordareMessage(r, { id: 'err', chatId: 'c1', role: 'assistant' }));
    expect(r.calls).toHaveLength(0);
    await enqueueRecordareMessage(r, { id: 'ok', chatId: 'c1', role: 'assistant' }); // outside the scope: enqueued
    expect(r.calls.some((c: any) => c.params?.[0] === 'ok')).toBe(true);
  });

  it('deletions are enqueued also when the switch is off but the user was provisioned', async () => {
    const r = fakeRunner();
    await enqueueRecordareMessageDeletes(r, 'c1', ['m1', 'm2']);
    await enqueueRecordareConversationDelete(r, 'c1');
    expect(r.calls[0].sql).toMatch(/'delete_message'/);
    expect(r.calls[0].sql).toMatch(/"recordareOwnerId" IS NOT NULL/);
    expect(r.calls[0].params).toEqual(['c1', ['m1', 'm2']]);
    expect(r.calls[1].sql).toMatch(/'delete_conversation'/);
  });
});

// ── Outbox: worker ──────────────────────────────────────────────────────────

/** Tiny in-memory stand-in for the SQL the worker runs. */
function fakeDb() {
  const outbox: any[] = [];
  const chats: Record<string, any> = { c1: { id: 'c1', title: 'Car', userId: 'u1', externalSource: null } };
  const messages: any[] = [
    { id: 'm1', chatId: 'c1', role: 'user', content: 'I serviced the car today', toolCalls: null, authorId: 'u1', createdAt: new Date('2026-10-06T10:00:00Z') },
    { id: 'm2', chatId: 'c1', role: 'assistant', content: 'Noted!', toolCalls: [{ name: 'get_time', input: {}, output: '10:00', ok: true, startedAt: Date.parse('2026-10-06T10:00:01Z') }], authorId: null, createdAt: new Date('2026-10-06T10:00:02Z') },
  ];
  const users = [{ id: 'u1', name: 'Andrea' }];
  let seq = 0;
  const add = (row: any) => outbox.push({ id: String(++seq), attempts: 0, parkedAt: null, due: true, lastError: null, messageId: null, ...row });
  const ds = {
    query: async (sql: string, p: any[] = []) => {
      if (/^\s*SELECT .* FROM "recordare_outbox"/s.test(sql)) {
        return outbox.filter((r) => !r.parkedAt && r.due && (!p[1] || r.chatId === p[1])).slice(0, p[0]);
      }
      if (/FROM "chats"/.test(sql)) return chats[p[0]] ? [chats[p[0]]] : [];
      if (/FROM "messages"/.test(sql)) return messages.filter((m) => m.chatId === p[0] && p[1].includes(m.id));
      if (/FROM "users"/.test(sql)) return users.filter((u) => p[0].includes(u.id));
      if (/^\s*DELETE FROM "recordare_outbox"/.test(sql)) { for (const id of p[0]) outbox.splice(outbox.findIndex((r) => r.id === id), 1); return []; }
      if (/^\s*UPDATE "recordare_outbox"/.test(sql)) {
        const r = outbox.find((x) => x.id === p[0]);
        r.attempts = p[1]; r.lastError = p[2];
        if (/"parkedAt" = now\(\)/.test(sql)) r.parkedAt = new Date(); else { r.due = false; r.delayMs = p[3]; }
        return [];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  return { ds: ds as any, outbox, chats, messages, add, makeDue: () => outbox.forEach((r) => { r.due = true; }) };
}

const noIdentity = { cachedOwnerId: () => undefined } as any;

describe('RecordareOutboxService', () => {
  it('sends a chat\'s messages in one ingest call with stable externalIds and participants, then clears the rows', async () => {
    const db = fakeDb();
    db.add({ userId: 'u1', chatId: 'c1', messageId: 'm1', op: 'message' });
    db.add({ userId: 'u1', chatId: 'c1', messageId: 'm2', op: 'message' });
    const res = await new RecordareOutboxService(db.ds, noIdentity).drain();
    expect(res).toMatchObject({ sent: 2, retried: 0, parked: 0 });
    expect(db.outbox).toHaveLength(0);

    const posts = seen.filter((s) => s.path === '/api/v1/ingest/messages');
    expect(posts).toHaveLength(1);
    expect(posts[0].headers['x-recordare-user']).toBe('u1');
    expect(posts[0].headers.authorization).toBe('Bearer rk_test_key');
    const body = posts[0].body;
    expect(body.conversation).toMatchObject({ externalId: 'c1', source: 'chat', title: 'Car' });
    expect(body.conversation.participants.map((p: any) => p.role)).toEqual(['owner', 'assistant']);
    expect(body.messages.map((m: any) => [m.externalId, m.role])).toEqual([
      ['m1', 'user'], ['m2:tool:0', 'tool'], ['m2', 'assistant'],
    ]);
    expect(body.messages[1].toolName).toBe('get_time');
  });

  it('resending the same rows produces the same externalIds (idempotent on Recordare\'s side)', async () => {
    const db = fakeDb();
    db.add({ userId: 'u1', chatId: 'c1', messageId: 'm1', op: 'message' });
    await new RecordareOutboxService(db.ds, noIdentity).drain();
    db.add({ userId: 'u1', chatId: 'c1', messageId: 'm1', op: 'message' });
    await new RecordareOutboxService(db.ds, noIdentity).drain();
    const [a, b] = seen.filter((s) => s.path === '/api/v1/ingest/messages').map((s) => s.body);
    expect(b).toEqual(a);
  });

  it('retries with exponential back-off on outage and parks after MAX_ATTEMPTS', async () => {
    respond = (s) => (s.path === '/api/v1/ingest/messages' ? { status: 503 } : undefined);
    const db = fakeDb();
    db.add({ userId: 'u1', chatId: 'c1', messageId: 'm1', op: 'message' });
    const svc = new RecordareOutboxService(db.ds, noIdentity);
    const r1 = await svc.drain();
    expect(r1.retried).toBe(1);
    expect(db.outbox[0]).toMatchObject({ attempts: 1, parkedAt: null });
    expect(db.outbox[0].delayMs).toBeGreaterThanOrEqual(DEFAULT_DELIVERY.baseDelayMs); // jittered, never below the base
    expect(db.outbox[0].delayMs).toBeLessThanOrEqual(backoffMs(1));
    expect(backoffMs(2)).toBe(2 * backoffMs(1));
    for (let i = 1; i < MAX_ATTEMPTS; i++) { db.makeDue(); await svc.drain(); }
    expect(db.outbox[0].parkedAt).toBeInstanceOf(Date);
    expect(db.outbox[0].attempts).toBe(MAX_ATTEMPTS);
    db.makeDue();
    seen.length = 0;
    await svc.drain(); // parked rows are not picked up again
    expect(seen).toHaveLength(0);
  });

  it('parks at once on a request Recordare will never accept (400)', async () => {
    respond = (s) => (s.path === '/api/v1/ingest/messages' ? { status: 400, body: { title: 'Bad Request' } } : undefined);
    const db = fakeDb();
    db.add({ userId: 'u1', chatId: 'c1', messageId: 'm1', op: 'message' });
    expect((await new RecordareOutboxService(db.ds, noIdentity).drain()).parked).toBe(1);
  });

  it('drops rows whose message was deleted, and sends deletions (404 = done)', async () => {
    respond = (s) => (s.method === 'DELETE' && s.path.endsWith('/messages/m9') ? { status: 404 } : undefined);
    const db = fakeDb();
    db.add({ userId: 'u1', chatId: 'c1', messageId: 'gone', op: 'message' });
    db.add({ userId: 'u1', chatId: 'c1', messageId: 'm9', op: 'delete_message' });
    db.add({ userId: 'u1', chatId: 'c1', op: 'delete_conversation' });
    const res = await new RecordareOutboxService(db.ds, noIdentity).drain();
    expect(res).toMatchObject({ dropped: 1, sent: 2 });
    expect(db.outbox).toHaveLength(0);
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
      'DELETE /api/v1/ingest/conversations/c1/messages/m9',
      'DELETE /api/v1/ingest/conversations/c1',
    ]);
  });

  it('does nothing when Recordare is not configured', async () => {
    configure(false);
    const db = fakeDb();
    db.add({ userId: 'u1', chatId: 'c1', messageId: 'm1', op: 'message' });
    const svc = new RecordareOutboxService(db.ds, noIdentity);
    svc.onModuleInit(); // no worker either
    expect(await svc.drain()).toMatchObject({ sent: 0 });
    expect(db.outbox).toHaveLength(1);
    expect(seen).toHaveLength(0);
    svc.onModuleDestroy();
  });
});

describe('ingest mapper', () => {
  it('maps other authors of a shared chat to role other with their identity', () => {
    const body = buildIngestBody(
      { id: 'c', title: null, userId: 'owner', externalSource: 'wyoming' },
      [{ id: 'x', role: 'user', content: 'hi', toolCalls: null, authorId: 'colleague', createdAt: new Date(0) },
       { id: 'y', role: 'system', content: 'secret prompt', toolCalls: null, authorId: null, createdAt: new Date(1) }],
      new Map([['colleague', 'Bob']]), 'Arkimede',
    );
    expect(body.conversation.source).toBe('voice');
    expect(body.messages).toEqual([{ externalId: 'x', role: 'other', authorRef: 'user:colleague', content: 'hi', sentAt: new Date(0).toISOString() }]);
    expect(body.conversation.participants[2]).toEqual({ ref: 'user:colleague', role: 'other', displayName: 'Bob', identity: { externalUserId: 'colleague' } });
  });

  it('clips content below Recordare\'s 64 KB limit, marking the cut', () => {
    const clipped = clipUtf8('è'.repeat(50_000));
    expect(Buffer.byteLength(clipped, 'utf8')).toBeLessThanOrEqual(64 * 1024);
    expect(clipped.endsWith('…[truncated]')).toBe(true);
  });
});

// ── MCP ─────────────────────────────────────────────────────────────────────

describe('RecordareMcpService', () => {
  const outbox = { flushChat: async () => undefined } as any;
  const posts = (method: string) => seen.filter((s) => s.path === '/mcp' && s.body?.method === method);

  it('builds the tools from Recordare\'s list, and every MCP request carries the key, the user AND the conversation', async () => {
    const svc = new RecordareMcpService(outbox);
    const tools = await svc.buildTools('u1', 'chat-42');
    expect(tools.map((t) => t.name).sort()).toEqual([
      'recordare_correct_episode', 'recordare_forget_episode', 'recordare_remember',
      'recordare_resolve_period', 'recordare_search_episodes', 'recordare_search_memory',
    ]); // prefixed (no clash with A-MEM search_memory); no log_episode: the ingest already captures the conversation
    expect(tools.find((t) => t.name === 'recordare_search_episodes')!.description).toBe('search_episodes (Recordare)');
    const out = await tools.find((t) => t.name === 'recordare_search_episodes')!.invoke({ mode: 'list' });
    expect(out).toContain('nothing to show here');

    const mcp = seen.filter((s) => s.path === '/mcp' && s.method === 'POST');
    expect(mcp.map((s) => s.body.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
    for (const s of mcp) {
      expect(s.headers.authorization).toBe('Bearer rk_test_key');
      expect(s.headers['x-recordare-user']).toBe('u1');
      expect(s.headers['x-recordare-conversation']).toBe('chat-42');
    }
    expect(posts('tools/call')[0]!.body.params).toEqual({ name: 'search_episodes', arguments: { mode: 'list' } });
    expect(posts('tools/call')[0]!.headers['mcp-session-id']).toMatch(/^sess-/);
  });

  it('one session per user and conversation, reused across calls', async () => {
    const svc = new RecordareMcpService(outbox);
    await svc.callTool('u1', 'chat-a', 'search_episodes', {});
    await svc.callTool('u1', 'chat-b', 'search_episodes', {});
    await svc.callTool('u1', 'chat-a', 'search_episodes', {});
    expect(posts('initialize').map((s) => s.headers['x-recordare-conversation'])).toEqual(['chat-a', 'chat-b']);
    expect(posts('tools/call').map((s) => s.headers['x-recordare-conversation'])).toEqual(['chat-a', 'chat-b', 'chat-a']);
  });

  it('re-opens an expired session once', async () => {
    const svc = new RecordareMcpService(outbox);
    await svc.callTool('u1', 'c-exp', 'search_episodes', {});
    let expired = true;
    respond = (s) => (s.body?.method === 'tools/call' && expired ? ((expired = false), { status: 404 }) : undefined);
    expect(await svc.callTool('u1', 'c-exp', 'search_episodes', {})).toContain('nothing to show here');
    expect(posts('initialize').filter((s) => s.headers['x-recordare-conversation'] === 'c-exp')).toHaveLength(2);
  });

  it('withholds the tools while consent is known off, offers them when on or unknown', async () => {
    const identity = (c: boolean | undefined) => ({ cachedConsent: () => c }) as any;
    expect(await new RecordareMcpService(outbox, identity(false)).buildTools('u1', 'c')).toHaveLength(0);
    expect(await new RecordareMcpService(outbox, identity(true)).buildTools('u1', 'c')).toHaveLength(6);
    expect(await new RecordareMcpService(outbox, identity(undefined)).buildTools('u1', 'c')).toHaveLength(6);
  });

  it('a Recordare outage never fails the run: no tools when it cannot list them, a short answer when a call fails', async () => {
    respond = (s) => (s.path === '/mcp' ? { status: 503 } : undefined);
    expect(await new RecordareMcpService(outbox).buildTools('u1', 'c-down')).toEqual([]);
    respond = () => undefined;
    const svc = new RecordareMcpService(outbox);
    const tool = (await svc.buildTools('u1', 'c-later'))[0]!;
    respond = (s) => (s.body?.method === 'tools/call' ? { status: 503 } : undefined);
    expect(await tool.invoke({ query: 'x' })).toMatch(/not reachable/);
  });
});

// ── Tracing ─────────────────────────────────────────────────────────────────

describe('RecordareMcpService.contextBlock (Agent.memoryContext)', () => {
  const flushed: string[] = [];
  const outbox = { flushChat: async (chatId: string) => { flushed.push(chatId); } } as any;

  it('flushes the current turn, then asks Recordare for the block of this message in this chat', async () => {
    const block = await new RecordareMcpService(outbox).contextBlock('u1', 'chat-9', 'Che macchina ho?');
    expect(block).toContain('<memory-context>');
    expect(flushed).toContain('chat-9');
    const req = seen.find((s) => s.path === '/api/v1/context')!;
    expect(req.body).toEqual({ query: 'Che macchina ho?' });
    expect(req.headers['x-recordare-user']).toBe('u1');
    expect(req.headers['x-recordare-conversation']).toBe('chat-9');
  });

  it('never fails or holds the answer: consent off, Recordare down or slow → null', async () => {
    const off = { cachedConsent: () => false } as any;
    expect(await new RecordareMcpService(outbox, off).contextBlock('u1', 'c', 'x')).toBeNull();
    respond = (s) => (s.path === '/api/v1/context' ? { status: 503 } : undefined);
    expect(await new RecordareMcpService(outbox).contextBlock('u1', 'c', 'x')).toBeNull();
    respond = () => undefined;
    const slow = { flushChat: () => new Promise<void>((r) => setTimeout(r, 10_000)) } as any;
    const started = Date.now();
    expect(await new RecordareMcpService(slow).contextBlock('u1', 'c', 'x')).toBeNull();
    expect(Date.now() - started).toBeLessThan(4_000);
  });
});

describe('RecordareDiaryController (Settings → Diary)', () => {
  const users = (enabled: boolean) => ({ findOne: async () => ({ id: 'u1', episodicMemoryEnabled: enabled }) }) as any;

  it('reads as the logged-in user, with the query forwarded', async () => {
    const res = await new RecordareDiaryController(users(true)).episodes({ id: 'u1' } as any, '2026-10-01', undefined, undefined, 'unresolved', 'Bologna');
    expect(res.items[0]!.content).toBe('Gita a Bologna');
    const req = seen.find((s) => s.path.startsWith('/api/v1/episodes'))!;
    expect(req.headers['x-recordare-user']).toBe('u1');
    expect(req.path).toBe('/api/v1/episodes?from=2026-10-01&planStatus=unresolved&q=Bologna');
  });

  it('refuses a user whose memory is off, keeps Recordare\'s 404 and turns an outage into a 503', async () => {
    await expect(new RecordareDiaryController(users(false)).episodes({ id: 'u1' } as any)).rejects.toMatchObject({ status: 403 });
    respond = (s) => (s.path.startsWith('/api/v1/episodes/') ? { status: 404, body: { code: 'not_found' } } : undefined);
    await expect(new RecordareDiaryController(users(true)).episode({ id: 'u1' } as any, 'x')).rejects.toMatchObject({ status: 404 });
    respond = (s) => (s.path.startsWith('/api/v1/episodes') ? { status: 502 } : undefined);
    await expect(new RecordareDiaryController(users(true)).episodes({ id: 'u1' } as any)).rejects.toMatchObject({ status: 503 });
    configure(false);
    await expect(new RecordareDiaryController(users(true)).episodes({ id: 'u1' } as any)).rejects.toMatchObject({ status: 503 });
  });
});

describe('tracing: recordare.owner_id', () => {
  it('spans carry recordare.owner_id when the mapping is known, nothing otherwise', async () => {
    const exporter = new InMemorySpanExporter();
    const handler = new GenAiTraceHandler(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }).getTracer('t'));
    setRecordareOwnerResolver((uid) => (uid === 'known' ? 'owner-1' : undefined));
    for (const user of ['known', 'unknown']) {
      await runWithLlmCallContext({ userId: user }, async () => {
        handler.handleChatModelStart({} as any, [], `r-${user}`, undefined, { invocation_params: { model: 'm' } });
      });
      handler.handleLLMEnd({ generations: [] }, `r-${user}`);
    }
    const [a, b] = exporter.getFinishedSpans();
    expect(a.attributes['recordare.owner_id']).toBe('owner-1');
    expect(b.attributes['recordare.owner_id']).toBeUndefined();
    expect(b.attributes['user.id']).toBe('unknown');
  });
});
