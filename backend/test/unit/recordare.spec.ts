// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Recordare as the episodic memory, against a fake Recordare (local HTTP stub):
 * identity lookup + naming + caching; outbox enqueue (gated, savepoint-safe,
 * no-op when off), send, retry with back-off, parking, idempotent externalIds;
 * MCP calls carry the user AND conversation headers on every request; tracing
 * spans get recordare.memory_id when the mapping is known.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { RecordareIdentityService, RecordareMemoryNotEmptyError } from '../../src/recordare/recordare-identity.service';
import { RecordareOutboxService } from '../../src/recordare/recordare-outbox.service';
import { UsersService } from '../../src/users/users.service';
import { ConflictException } from '@nestjs/common';
import { DEFAULT_DELIVERY, backoffMs } from '@arkimedehq/recordare-client';

const MAX_ATTEMPTS = DEFAULT_DELIVERY.maxAttempts;
import { RecordareMcpService } from '../../src/recordare/recordare-mcp.service';
import { RecordareDiaryController } from '../../src/recordare/recordare-diary.controller';
import {
  enqueueRecordareMessage, enqueueRecordareMessageDeletes, enqueueRecordareConversationDelete,
  enqueueRecordareMessagePrivacy, withoutRecordareIngest,
} from '../../src/recordare/recordare-outbox';
import { buildIngestBody, clipUtf8 } from '../../src/recordare/recordare-ingest.mapper';
import { GenAiTraceHandler, setRecordareMemoryResolver } from '../../src/observability/genai-trace.handler';
import { runWithLlmCallContext } from '../../src/usage/llm-call-context';

// ── Fake Recordare ─────────────────────────────────────────────────────────

interface Seen { method: string; path: string; headers: IncomingMessage['headers']; body: any }

const seen: Seen[] = [];
let sessions = 0;
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
      return send(200, { memoryId: `memory-of-${u}`, displayName: u });
    }
    if (s.path === '/api/v1/me' && s.method === 'PATCH') return send(204);
    if (s.path.startsWith('/api/v1/episodes')) return send(200, { items: [{ id: 'e1', content: 'Gita a Bologna' }], nextCursor: null });
    if (s.path === '/api/v1/context') return send(200, { block: `<memory-context>\n- fact: car = Yaris\n</memory-context>`, items: 1 });
    if (s.path === '/api/v1/ingest/messages') return send(200, { conversationId: 'c', accepted: s.body.messages.length, duplicates: 0, conflicts: [] });
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

beforeEach(() => { seen.length = 0; respond = () => undefined; configure(true); });
afterEach(() => { configure(false); setRecordareMemoryResolver(null); });


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
  it('provisions via GET /me, stores the memoryId, names the person, then serves from cache', async () => {
    const { repo, updates } = fakeUsers({ u1: { id: 'u1', name: 'Andrea', episodicMemoryEnabled: true, recordareMemoryId: null } });
    const svc = new RecordareIdentityService(repo);
    expect(await svc.ensureMemory('u1')).toBe('memory-of-u1');
    expect(updates).toEqual([{ id: 'u1', recordareMemoryId: 'memory-of-u1' }]);
    const me = seen.find((s) => s.method === 'GET')!;
    expect(me.headers['x-recordare-user']).toBe('u1');
    expect(me.headers.authorization).toBe('Bearer rk_test_key');
    const patch = seen.find((s) => s.method === 'PATCH')!;
    expect(patch.body).toEqual({ displayName: 'Andrea' });

    seen.length = 0;
    expect(svc.cachedMemoryId('u1')).toBe('memory-of-u1');
    expect(await svc.ensureMemory('u1')).toBe('memory-of-u1'); // stored column: no further GET
    expect(seen.filter((s) => s.path === '/api/v1/me')).toHaveLength(0);
  });

  it('cachedMemoryId never waits: undefined first, background lookup, value afterwards', async () => {
    const { repo } = fakeUsers({ u2: { id: 'u2', name: 'B', episodicMemoryEnabled: true, recordareMemoryId: null } });
    const svc = new RecordareIdentityService(repo);
    expect(svc.cachedMemoryId('u2')).toBeUndefined();
    // The background lookup does real HTTP round trips to the stub: wait for it instead of a fixed number of ticks
    // (it is slower when the whole suite runs).
    await vi.waitFor(() => expect(svc.cachedMemoryId('u2')).toBe('memory-of-u2'));
    expect(svc.cachedMemoryId('u2')).toBe('memory-of-u2');
  });

  it('a naming failure never fails the lookup', async () => {
    respond = (s) => (s.method === 'PATCH' ? { status: 403, body: { title: 'Forbidden' } } : undefined);
    const { repo } = fakeUsers({ u3: { id: 'u3', name: 'C', episodicMemoryEnabled: true, recordareMemoryId: null } });
    expect(await new RecordareIdentityService(repo).ensureMemory('u3')).toBe('memory-of-u3');
  });

  it('keeps the name in sync with the profile: renames only when it differs', async () => {
    respond = (s) => (s.method === 'GET' && s.path === '/api/v1/me'
      ? { status: 200, body: { memoryId: 'memory-of-u6', displayName: 'Andrea' } } : undefined);
    const rows = { u6: { id: 'u6', name: 'Andrea', episodicMemoryEnabled: true, recordareMemoryId: 'memory-of-u6' } };
    const svc = new RecordareIdentityService(fakeUsers(rows).repo);
    await svc.status('u6', true);
    expect(seen.filter((s) => s.method === 'PATCH')).toHaveLength(0); // same name: nothing to do
    rows.u6.name = 'Andrea G.';
    svc.invalidate('u6'); // the profile changed (UsersService invalidates on rename)
    await svc.status('u6', true);
    expect(seen.filter((s) => s.method === 'PATCH').map((s) => s.body)).toEqual([{ displayName: 'Andrea G.' }]);
  });

  it('reads the memory mode and the Atlas address, and maps a refused mode change', async () => {
    respond = (s) => {
      if (s.method === 'GET' && s.path === '/api/v1/me') {
        return { status: 200, body: { memoryId: 'memory-of-u7', displayName: 'Voice', mode: 'entity', gender: 'masculine', atlasUrl: 'http://atlas:5175' } };
      }
      return s.method === 'PATCH' && s.body?.mode ? { status: 409, body: { title: 'Conflict' } } : undefined;
    };
    const svc = new RecordareIdentityService(fakeUsers({ u7: { id: 'u7', name: 'Voice', episodicMemoryEnabled: true, recordareMemoryId: 'memory-of-u7' } }).repo);
    expect(await svc.status('u7', true)).toBe('active');
    expect(svc.details('u7')).toEqual({ mode: 'entity', atlasUrl: 'http://atlas:5175' });
    await expect(svc.setMode('u7', 'personal')).rejects.toBeInstanceOf(RecordareMemoryNotEmptyError);
    expect(seen.filter((s) => s.method === 'PATCH').map((s) => s.body)).toEqual([{ mode: 'personal' }]);
  });

  it('sets the mode while the memory is empty', async () => {
    const svc = new RecordareIdentityService(fakeUsers({ u8: { id: 'u8', name: 'Home', episodicMemoryEnabled: true, recordareMemoryId: 'memory-of-u8' } }).repo);
    await svc.setMode('u8', 'entity');
    expect(seen.filter((s) => s.method === 'PATCH' && s.body?.mode).map((s) => s.body)).toEqual([{ mode: 'entity' }]);
  });

  it('sends the profile gender when Recordare\'s differs, again after a change, never when not set', async () => {
    let stored = 'masculine'; // Recordare's side: what the last PATCH set
    respond = (s) => {
      if (s.method === 'PATCH' && s.body?.gender) stored = s.body.gender;
      return s.method === 'GET' && s.path === '/api/v1/me'
        ? { status: 200, body: { memoryId: 'memory-of-u9', displayName: 'Giulia', mode: 'personal', gender: stored } } : undefined;
    };
    const rows: Record<string, any> = {
      u9: { id: 'u9', name: 'Giulia', episodicMemoryEnabled: true, recordareMemoryId: 'memory-of-u9', gender: 'feminine' },
      u10: { id: 'u10', name: 'Giulia', episodicMemoryEnabled: true, recordareMemoryId: 'memory-of-u10', gender: null },
    };
    const svc = new RecordareIdentityService(fakeUsers(rows).repo);
    const genders = () => seen.filter((s) => s.method === 'PATCH' && s.body?.gender).map((s) => [s.headers['x-recordare-user'], s.body]);
    await svc.status('u9', true);
    expect(genders()).toEqual([['u9', { gender: 'feminine' }]]);
    svc.invalidate('u9'); // e.g. a rename: the lookup runs again
    await svc.status('u9', true);
    seen.length = 0;
    await svc.status('u9', true); // Recordare already has it: nothing
    rows.u9.gender = 'neutral';
    svc.invalidate('u9'); // UsersService invalidates when the gender changes
    await svc.status('u9', true);
    expect(genders()).toEqual([['u9', { gender: 'neutral' }]]);
    seen.length = 0;
    await svc.status('u10', true); // not set: Recordare's default (masculine) stands
    expect(genders()).toEqual([]);
  });

  it('a gender sync failure never fails the lookup', async () => {
    respond = (s) => (s.method === 'PATCH' && s.body?.gender ? { status: 503, body: { title: 'Unavailable' } } : undefined);
    const { repo } = fakeUsers({ u11: { id: 'u11', name: 'F', episodicMemoryEnabled: true, recordareMemoryId: null, gender: 'feminine' } });
    expect(await new RecordareIdentityService(repo).ensureMemory('u11')).toBe('memory-of-u11');
  });

  it('never provisions a user whose switch is off, nor when Recordare is not configured', async () => {
    const { repo } = fakeUsers({ u4: { id: 'u4', name: 'D', episodicMemoryEnabled: false, recordareMemoryId: null } });
    expect(await new RecordareIdentityService(repo).ensureMemory('u4')).toBeNull();
    configure(false);
    const { repo: repo2 } = fakeUsers({ u5: { id: 'u5', name: 'E', episodicMemoryEnabled: true, recordareMemoryId: null } });
    expect(await new RecordareIdentityService(repo2).ensureMemory('u5')).toBeNull();
    expect(seen).toHaveLength(0);
  });
});

describe('UsersService: memory mode and gender', () => {
  function setup(row: Record<string, any>, recordare: Record<string, any>) {
    const saved: any[] = [];
    const repo = {
      findOne: async () => ({ ...row }),
      save: async (u: any) => { saved.push({ ...u }); Object.assign(row, u); return u; },
    } as any;
    const calls: any[] = [];
    const fake = {
      invalidate: (id: string) => calls.push(['invalidate', id]),
      status: async () => 'active',
      details: () => ({ mode: 'personal', atlasUrl: null }),
      ...recordare,
    } as any;
    return { svc: new UsersService(repo, fake), saved, calls };
  }

  it('stores the gender and re-syncs Recordare only when it changed; the profile carries mode and gender', async () => {
    const row = { id: 'u', name: 'Giulia', role: 'user', gender: null, episodicMemoryEnabled: true };
    const { svc, saved, calls } = setup(row, {});
    const profile: any = await svc.updateProfile('u', { gender: 'feminine' });
    expect(saved[0].gender).toBe('feminine');
    expect(calls).toEqual([['invalidate', 'u']]);
    expect(profile.gender).toBe('feminine');
    expect(profile.episodicMemoryMode).toBe('personal');
    calls.length = 0;
    await svc.updateProfile('u', { gender: 'feminine' });
    expect(calls).toEqual([]); // unchanged: nothing to re-sync
  });

  it('sets the memory mode; a non-empty memory is a 409 with a user-facing key; the switch must be on', async () => {
    const setMode = vi.fn(async () => undefined);
    const on = setup({ id: 'u', name: 'H', role: 'user', episodicMemoryEnabled: true }, { setMode });
    await on.svc.updateProfile('u', { episodicMemoryMode: 'entity' });
    expect(setMode).toHaveBeenCalledWith('u', 'entity');

    const full = setup({ id: 'u', name: 'H', role: 'user', episodicMemoryEnabled: true }, {
      setMode: async () => { throw new RecordareMemoryNotEmptyError(); },
    });
    const err = await full.svc.updateProfile('u', { episodicMemoryMode: 'personal' }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toBe('users.memoryNotEmpty');

    const off = setup({ id: 'u', name: 'H', role: 'user', episodicMemoryEnabled: false }, { setMode });
    await expect(off.svc.updateProfile('u', { episodicMemoryMode: 'entity' })).rejects.toThrow('users.episodicMemoryOff');
  });
});

// ── Erasing the memory with the account (Recordare WORK_PLAN 8.13) ──────────

describe('deleting an account erases its memory', () => {
  const erased = { erased: { conversations: 1, messages: 2, episodes: 1, facts: 0, notes: 0, digests: 0, sources: 0, contacts: 0 } };
  function identity() {
    const queries: unknown[][] = [];
    const repo = { manager: { query: async (...args: unknown[]) => { queries.push(args); return []; } } } as any;
    return { svc: new RecordareIdentityService(repo), queries };
  }

  it('drops the pending outbox rows, then erases with the memoryId as confirmation; a memory already gone is fine', async () => {
    respond = (s) => (s.method === 'DELETE' && s.path.startsWith('/api/v1/me') ? { status: 200, body: erased } : undefined);
    const { svc, queries } = identity();
    await svc.eraseMemory('u1', 'memory-of-u1');
    expect(queries).toEqual([['DELETE FROM "recordare_outbox" WHERE "userId" = $1', ['u1']]]);
    const req = seen.find((s) => s.method === 'DELETE')!;
    expect(req.path).toBe('/api/v1/me?confirm=memory-of-u1');
    expect(req.headers['x-recordare-user']).toBe('u1');

    respond = (s) => (s.method === 'DELETE' ? { status: 404, body: { code: 'not_found' } } : undefined);
    await expect(svc.eraseMemory('u1', 'memory-of-u1')).resolves.toBeUndefined();
    respond = (s) => (s.method === 'DELETE' ? { status: 403, body: { code: 'forbidden' } } : undefined);
    await expect(svc.eraseMemory('u1', 'memory-of-u1')).rejects.toMatchObject({ status: 403 });
  });

  it('nothing to erase when never provisioned or Recordare is off', async () => {
    const { svc, queries } = identity();
    await svc.eraseMemory('u1', null);
    configure(false);
    await svc.eraseMemory('u1', 'memory-of-u1');
    expect(queries).toEqual([]);
    expect(seen).toEqual([]);
  });

  it('the account stays when the erasure fails, and goes when it succeeds', async () => {
    const removed: string[] = [];
    const repo = { findOne: async () => ({ id: 'u', role: 'user', recordareMemoryId: 'm' }), remove: async (u: any) => { removed.push(u.id); } } as any;
    const failing = new UsersService(repo, { eraseMemory: async () => { throw new Error('down'); } } as any);
    await expect(failing.deleteUser('u')).rejects.toMatchObject({ status: 503, message: 'users.memoryEraseFailed' });
    expect(removed).toEqual([]);
    const erase = vi.fn(async () => undefined);
    await new UsersService(repo, { eraseMemory: erase } as any).deleteUser('u');
    expect(erase).toHaveBeenCalledWith('u', 'm');
    expect(removed).toEqual(['u']);
  });
});

// ── Status (no consent in Recordare, its D50: the user's switch is the only on/off) ───

describe('episodic memory status', () => {
  it('status: off (switch off / not configured), active, unknown (Recordare down)', async () => {
    const { repo } = fakeUsers({
      on: { id: 'on', name: 'A', episodicMemoryEnabled: true, recordareMemoryId: null },
      down: { id: 'down', name: 'D', episodicMemoryEnabled: true, recordareMemoryId: 'memory-x' },
    });
    const svc = new RecordareIdentityService(repo);
    (repo as any).find = async () => [{ id: 'down', recordareMemoryId: 'memory-x' }]; // stored ids, loaded at start
    await svc.warm();
    expect(await svc.status('on', false)).toBe('off');
    expect(await svc.status('on', true)).toBe('active');
    respond = (s) => (s.path === '/api/v1/me' ? { status: 503 } : undefined);
    expect(await svc.status('down', true)).toBe('unknown');
    expect(svc.cachedMemoryId('down')).toBe('memory-x'); // stored id kept when Recordare is down
    respond = () => undefined;
    expect(await svc.status('down', true)).toBe('active'); // reachable again
    configure(false);
    expect(await svc.status('on', true)).toBe('off');
  });

  it('enqueues every message of a user whose switch is on (no consent filter)', async () => {
    const r = fakeRunner();
    await enqueueRecordareMessage(r, { id: 'm1', chatId: 'c1', role: 'user' });
    expect(r.calls[0].sql).not.toMatch(/ANY\(\$3/);
    expect(r.calls[0].params).toEqual(['m1', 'c1']);
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
    expect(r.calls[0].params).toEqual(['m1', 'c1']);
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
    expect(r.calls[0].sql).toMatch(/"recordareMemoryId" IS NOT NULL/);
    expect(r.calls[0].params).toEqual(['c1', ['m1', 'm2']]);
    expect(r.calls[1].sql).toMatch(/'delete_conversation'/);
  });

  it('privacy changes are enqueued like deletions (switch on, or provisioned), never when not configured', async () => {
    const r = fakeRunner();
    await enqueueRecordareMessagePrivacy(r, 'c1', 'm1');
    expect(r.calls[0].sql).toMatch(/'message_privacy'/);
    expect(r.calls[0].sql).toMatch(/"recordareMemoryId" IS NOT NULL/);
    expect(r.calls[0].params).toEqual(['c1', 'm1']);
    configure(false);
    const off = fakeRunner();
    await enqueueRecordareMessagePrivacy(off, 'c1', 'm1');
    expect(off.calls).toHaveLength(0);
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
      if (/^\s*SELECT "isPrivate" FROM "messages"/.test(sql)) return messages.filter((m) => m.id === p[0] && m.chatId === p[1]);
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

const noIdentity = { cachedMemoryId: () => undefined } as any;

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
    expect(body.conversation.participants.map((p: any) => p.role)).toEqual(['holder', 'assistant']);
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

  it('a private message is sent private; the reply is left to Recordare (it follows the person\'s message)', async () => {
    const db = fakeDb();
    db.messages[0].isPrivate = true;
    db.add({ userId: 'u1', chatId: 'c1', messageId: 'm1', op: 'message' });
    db.add({ userId: 'u1', chatId: 'c1', messageId: 'm2', op: 'message' });
    await new RecordareOutboxService(db.ds, noIdentity).drain();
    const body = seen.find((s) => s.path === '/api/v1/ingest/messages')!.body;
    expect(body.messages.map((m: any) => [m.externalId, m.private])).toEqual([['m1', true], ['m2:tool:0', undefined], ['m2', undefined]]);
    expect(body.conversation.private).toBeUndefined();
  });

  it('a privacy change sends the message\'s CURRENT flag after its ingest; 404 and a deleted message are done', async () => {
    respond = (s) => (s.method === 'PATCH' && s.path.endsWith('/messages/m2') ? { status: 404 } : (s.method === 'PATCH' ? { status: 204 } : undefined));
    const db = fakeDb();
    db.messages[0].isPrivate = false;   // made private, then public again: the last word wins
    db.add({ userId: 'u1', chatId: 'c1', messageId: 'm1', op: 'message_privacy' });
    db.add({ userId: 'u1', chatId: 'c1', messageId: 'm1', op: 'message' });
    db.add({ userId: 'u1', chatId: 'c1', messageId: 'm2', op: 'message_privacy' });
    db.add({ userId: 'u1', chatId: 'c1', messageId: 'gone', op: 'message_privacy' });
    const res = await new RecordareOutboxService(db.ds, noIdentity).drain();
    expect(res).toMatchObject({ sent: 3, dropped: 1, retried: 0, parked: 0 });
    expect(db.outbox).toHaveLength(0);
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
      'POST /api/v1/ingest/messages',
      'PATCH /api/v1/ingest/conversations/c1/messages/m1',
      'PATCH /api/v1/ingest/conversations/c1/messages/m2',
    ]);
    expect(seen[1]!.body).toEqual({ private: false });
    expect(seen[1]!.headers['x-recordare-user']).toBe('u1');
  });

  it('a privacy change is retried on outage', async () => {
    respond = (s) => (s.method === 'PATCH' ? { status: 503 } : undefined);
    const db = fakeDb();
    db.add({ userId: 'u1', chatId: 'c1', messageId: 'm1', op: 'message_privacy' });
    expect(await new RecordareOutboxService(db.ds, noIdentity).drain()).toMatchObject({ retried: 1, sent: 0 });
    expect(db.outbox[0]).toMatchObject({ attempts: 1, parkedAt: null });
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

  it('every other speaker of a shared chat is a participant with their user id; the owner\'s turns are the account\'s', () => {
    const body = buildIngestBody(
      { id: 'c', title: 'Trip', userId: 'andrea', externalSource: null },
      [{ id: 'a', role: 'user', content: 'plan the trip', toolCalls: null, authorId: 'andrea', createdAt: new Date(0) },
       { id: 'b', role: 'user', content: 'I book the hotel', toolCalls: null, authorId: 'marta', createdAt: new Date(1) },
       { id: 'c1', role: 'user', content: 'I drive', toolCalls: null, authorId: 'luca', createdAt: new Date(2) },
       { id: 'd', role: 'user', content: 'and the train?', toolCalls: null, authorId: 'marta', createdAt: new Date(3) },
       { id: 'e', role: 'user', content: 'legacy turn', toolCalls: null, authorId: null, createdAt: new Date(4) }],
      new Map([['andrea', 'Andrea'], ['marta', 'Marta']]), 'Arkimede',
    );
    expect(body.messages.map((m) => [m.externalId, m.role, m.authorRef])).toEqual([
      ['a', 'user', 'holder'], ['b', 'other', 'user:marta'], ['c1', 'other', 'user:luca'], ['d', 'other', 'user:marta'], ['e', 'user', 'holder'],
    ]);
    expect(body.conversation.participants).toEqual([
      { ref: 'holder', role: 'holder', displayName: 'Andrea' },
      { ref: 'assistant', role: 'assistant', displayName: 'Arkimede' },
      { ref: 'user:marta', role: 'other', displayName: 'Marta', identity: { externalUserId: 'marta' } },
      { ref: 'user:luca', role: 'other', identity: { externalUserId: 'luca' } },
    ]);
  });

  it('marks a person\'s private message (owner or other author), never the assistant\'s', () => {
    const body = buildIngestBody(
      { id: 'c', title: null, userId: 'andrea', externalSource: null },
      [{ id: 'a', role: 'user', content: 'between us', toolCalls: null, authorId: 'andrea', createdAt: new Date(0), isPrivate: true },
       { id: 'b', role: 'assistant', content: 'sure', toolCalls: null, authorId: null, createdAt: new Date(1), isPrivate: false },
       { id: 'c1', role: 'user', content: 'mine too', toolCalls: null, authorId: 'marta', createdAt: new Date(2), isPrivate: true },
       { id: 'd', role: 'user', content: 'public', toolCalls: null, authorId: 'andrea', createdAt: new Date(3), isPrivate: false }],
      new Map(), 'Arkimede',
    );
    expect(body.messages.map((m) => [m.externalId, m.role, m.private])).toEqual([
      ['a', 'user', true], ['b', 'assistant', undefined], ['c1', 'other', true], ['d', 'user', undefined],
    ]);
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

  it('never fails or holds the answer: Recordare down or slow → null', async () => {
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

  it('passes the private marks through and lists the hidden private memories, as the logged-in user', async () => {
    const notes = [{ id: 'n1', content: 'Marta is planning a surprise', private: { by: ['Marta'] } }, { id: 'n2', content: 'likes tea' }];
    const hidden = [{ kind: 'episode', id: 'e9', by: ['Luca'], recordedAt: '2026-10-27T10:00:00Z' }];
    respond = (s) => (s.path.startsWith('/api/v1/notes') ? { status: 200, body: notes }
      : s.path === '/api/v1/private' ? { status: 200, body: hidden } : undefined);
    expect(await new RecordareDiaryController(users(true)).notes({ id: 'u1' } as any)).toEqual(notes);
    expect(await new RecordareDiaryController(users(true)).privateItems({ id: 'u1' } as any)).toEqual(hidden);
    expect(seen.find((s) => s.path === '/api/v1/private')!.headers['x-recordare-user']).toBe('u1');
  });

  it('copies a private note into the personal memory only, never a team or the org', async () => {
    const note = { id: 'n1', content: 'Marta is planning a surprise', category: 'knowledge', status: 'current', pending: false, private: { by: ['Marta'] } };
    respond = (s) => (s.path === '/api/v1/notes/n1' ? { status: 200, body: note } : undefined);
    const memory = { copyRecordareNote: vi.fn(async () => ({ id: 'copy-1' })) };
    const audit = { record: vi.fn(async () => undefined) };
    const ctrl = new RecordareDiaryController(users(true), memory as any, audit as any);
    const admin = { id: 'u1', role: 'admin', email: 'a@x' } as any;
    await expect(ctrl.copy(admin, 'n1', { scope: 'org' })).rejects.toMatchObject({ status: 409 });
    await expect(ctrl.copy(admin, 'n1', { scope: 'team', teamId: '11111111-1111-4111-8111-111111111111' })).rejects.toMatchObject({ status: 409 });
    expect(memory.copyRecordareNote).not.toHaveBeenCalled();
    await expect(ctrl.copy(admin, 'n1', { scope: 'personal' })).resolves.toEqual({ id: 'copy-1' });
  });

  it('reads the cards (who the user is, the people they know) as the logged-in user', async () => {
    const cards = { self: { personId: 'm', name: 'Andrea', aliases: [], facts: [], notes: [], lastMentioned: null }, contacts: [] };
    respond = (s) => (s.path === '/api/v1/cards' ? { status: 200, body: cards } : undefined);
    expect(await new RecordareDiaryController(users(true)).cards({ id: 'u1' } as any)).toEqual(cards);
    expect(seen.find((s) => s.path === '/api/v1/cards')!.headers['x-recordare-user']).toBe('u1');
  });
});

describe('tracing: recordare.memory_id', () => {
  it('spans carry recordare.memory_id when the mapping is known, nothing otherwise', async () => {
    const exporter = new InMemorySpanExporter();
    const handler = new GenAiTraceHandler(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }).getTracer('t'));
    setRecordareMemoryResolver((uid) => (uid === 'known' ? 'memory-1' : undefined));
    for (const user of ['known', 'unknown']) {
      await runWithLlmCallContext({ userId: user }, async () => {
        handler.handleChatModelStart({} as any, [], `r-${user}`, undefined, { invocation_params: { model: 'm' } });
      });
      handler.handleLLMEnd({ generations: [] }, `r-${user}`);
    }
    const [a, b] = exporter.getFinishedSpans();
    expect(a.attributes['recordare.memory_id']).toBe('memory-1');
    expect(b.attributes['recordare.memory_id']).toBeUndefined();
    expect(b.attributes['user.id']).toBe('unknown');
  });
});
