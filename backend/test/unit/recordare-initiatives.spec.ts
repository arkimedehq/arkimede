// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * The memory's initiatives in Arkimede (Recordare D55): a verified webhook delivers into the user's dedicated chat with
 * a notification and reports the outcome; a reminder the user already scheduled is reported done, not delivered twice;
 * a delivery happens once (webhook + feed, through the library's InitiativeInbox); a presence impulse when the user opens the app may bring one; the feed
 * catches up on recent pushes only; nothing for a user with the memory off; a bad signature is refused.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHmac } from 'crypto';
import type { Initiative } from '@arkimedehq/recordare-client';
import { RecordareInitiativesService, sharedWords, CHAT_SOURCE, EVENT_TYPE } from '../../src/recordare/recordare-initiatives.service';
import { RecordareWebhookController } from '../../src/recordare/recordare-webhook.controller';
import { Chat } from '../../src/chats/chats.entity';
import { Message } from '../../src/messages/messages.entity';

const NOW = Date.parse('2026-11-05T09:00:00Z');

function initiative(over: Partial<Initiative> = {}): Initiative {
  return {
    id: '11111111-1111-4111-8111-111111111111', seq: 1, kind: 'say', for: null, text: 'Mi avevi chiesto di ricordarti di chiamare il commercialista: è oggi.',
    reason: 'a request they made to me', worth: 0.9, episodeIds: [], dueAt: '2026-11-05T08:00:00Z', expiresAt: '2026-11-06T08:00:00Z',
    status: 'offered', outcomeAt: null, reply: null, createdAt: '2026-11-05T08:00:00Z', timing: 'timed',
    window: { notBefore: '2026-11-05T08:00:00Z', notAfter: '2026-11-06T08:00:00Z' }, channel: 'chat', identity: { required: 'medium' },
    source: { conversation: 'chat-origin', messageIds: ['m1'] }, offeredAt: '2026-11-05T08:00:00Z', pushedAt: '2026-11-05T08:00:00Z', ...over,
  };
}

/** A fake database: users, notifications, scheduled tasks, chats and messages in memory. */
function fakeDb() {
  const state = {
    users: [{ id: 'u1', episodicMemoryEnabled: true, recordareMemoryId: 'mem-1' }, { id: 'u2', episodicMemoryEnabled: false, recordareMemoryId: 'mem-2' }],
    notifications: [] as Array<{ userId: string; source: string; sourceId: string }>,
    tasks: [] as Array<{ userId: string; chatId: string | null; runAt: Date | null; title: string | null; instruction: string }>,
    chats: [] as any[],
    messages: [] as any[],
  };
  const repo = (list: any[]) => ({
    create: (x: any) => ({ ...x }),
    save: async (x: any) => { const row = { id: `id-${list.length + 1}`, ...x }; list.push(row); return row; },
    update: async (id: string, patch: any) => { Object.assign(list.find((r) => r.id === id) ?? {}, patch); },
    findOne: async ({ where }: any) => list.find((r) => Object.entries(where).every(([k, v]) => r[k] === v)) ?? null,
  });
  const ds = {
    query: async (sql: string, p: any[] = []) => {
      if (/FROM "users" WHERE "id" = \$1/.test(sql)) return state.users.filter((u) => u.id === p[0] && u.episodicMemoryEnabled);
      if (/FROM "users"/.test(sql)) return state.users.filter((u) => u.episodicMemoryEnabled && u.recordareMemoryId);
      if (/FROM "notifications"/.test(sql)) return state.notifications.filter((n) => n.source === p[0] && n.sourceId === p[1]);
      if (/FROM "scheduled_tasks"/.test(sql)) return state.tasks.filter((t) => t.userId === p[0]);
      throw new Error(`unexpected SQL: ${sql}`);
    },
    getRepository: (entity: unknown) => (entity === Chat ? repo(state.chats) : entity === Message ? repo(state.messages) : null),
  };
  return { ds: ds as any, state };
}

function setup() {
  const db = fakeDb();
  const notifications = { create: vi.fn(async (dto: any) => { db.state.notifications.push(dto); return { id: `n${db.state.notifications.length}` }; }) };
  const pushed: any[] = [];
  const listeners: Array<(u: string) => void> = [];
  const gateway = { emitToUser: (userId: string, event: string, data: unknown) => pushed.push({ userId, event, data }), onUserConnected: (l: (u: string) => void) => { listeners.push(l); return () => {}; } };
  const client = {
    reportInitiative: vi.fn(async () => ({})),
    presence: vi.fn(async () => ({ person: null, initiative: null, askWho: null })),
    initiatives: vi.fn(async () => ({ items: [] as Initiative[], next: 0, more: false })),
  };
  const svc = new RecordareInitiativesService(db.ds, notifications as any, gateway as any);
  svc.client = () => client as any;
  /** What a webhook `initiative.deliver` does: true when a message was written. */
  const deliver = (user: string, i: Initiative) => svc.handleEvent({ type: 'initiative.deliver', timestamp: '', data: { ...i, user, memoryId: 'm' } });
  return { svc, db, client, pushed, notifications, listeners, deliver };
}

describe('RecordareInitiativesService', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => { t = setup(); });

  it('delivers into the dedicated chat with a notification, then reports it said on the chat', async () => {
    await t.svc.handleEvent({ type: 'initiative.deliver', timestamp: '', data: { ...initiative(), user: 'u1', memoryId: 'mem-1' } });
    expect(t.db.state.chats).toEqual([expect.objectContaining({ userId: 'u1', externalSource: CHAT_SOURCE, externalKey: 'initiatives', unread: true })]);
    expect(t.db.state.messages).toEqual([expect.objectContaining({ chatId: 'id-1', role: 'assistant', content: initiative().text })]);
    expect(t.notifications.create).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', source: CHAT_SOURCE, sourceId: initiative().id, eventType: EVENT_TYPE }));
    expect(t.pushed[0]).toMatchObject({ userId: 'u1', event: 'notification', data: { eventType: EVENT_TYPE, chatId: 'id-1', message: initiative().text } });
    expect(t.client.reportInitiative).toHaveBeenCalledWith('u1', initiative().id, 'said', { channel: 'chat' });
    // The next one goes to the same chat; an ask is reported asked.
    await t.deliver('u1', initiative({ id: '22222222-2222-4222-8222-222222222222', kind: 'ask', text: 'Com\'è andata dal dentista?' }));
    expect(t.db.state.chats).toHaveLength(1);
    expect(t.client.reportInitiative).toHaveBeenLastCalledWith('u1', '22222222-2222-4222-8222-222222222222', 'asked', { channel: 'chat' });
  });

  it('delivers once (webhook and feed), ignores the other events, look-ups and users with the memory off', async () => {
    expect(await t.deliver('u1', initiative())).toBe(true);
    expect(await t.deliver('u1', initiative())).toBe(false);
    await t.svc.handleEvent({ type: 'initiative.updated', timestamp: '', data: { ...initiative({ id: 'x' }), user: 'u1', memoryId: 'm' } });
    expect(await t.deliver('u1', initiative({ id: 'lookup-1', kind: 'lookup' }))).toBe(false);
    expect(await t.deliver('u2', initiative({ id: 'other' }))).toBe(false);
    expect(t.db.state.messages).toHaveLength(1);
  });

  it('a reminder the user already scheduled is reported done, not delivered twice', async () => {
    t.db.state.tasks.push({ userId: 'u1', chatId: 'chat-origin', runAt: new Date('2026-11-05T08:00:00Z'), title: 'Promemoria: chiamare il commercialista', instruction: 'Invia un messaggio Telegram' });
    expect(await t.deliver('u1', initiative())).toBe(false);
    expect(t.db.state.messages).toHaveLength(0);
    expect(t.client.reportInitiative).toHaveBeenCalledWith('u1', initiative().id, 'done', { channel: 'chat' });
    // Same time but nothing in common: not the same reminder.
    t.db.state.tasks[0] = { userId: 'u1', chatId: 'another', runAt: new Date('2026-11-05T08:30:00Z'), title: 'Backup del NAS', instruction: 'Esegui il backup' };
    expect(await t.svc.alreadyScheduled('u1', initiative())).toBe(false);
    expect(sharedWords('chiamare il commercialista', 'Promemoria: chiamare il Commercialista')).toBe(2);
  });

  it('a presence impulse when the user opens the app may bring one (at most every ten minutes)', async () => {
    t.client.presence.mockResolvedValueOnce({ person: { personId: 'mem-1', name: 'Andrea' }, initiative: initiative({ channel: 'chat' }), askWho: null } as any);
    await t.svc.onPresence('u1', NOW);
    expect(t.client.presence).toHaveBeenCalledWith('u1', { channel: 'chat' });
    expect(t.db.state.messages).toHaveLength(1);
    await t.svc.onPresence('u1', NOW + 60_000);
    expect(t.client.presence).toHaveBeenCalledTimes(1);
    await t.svc.onPresence('u2', NOW); // memory off
    expect(t.client.presence).toHaveBeenCalledTimes(1);
  });

  it('the feed catches up on what was pushed to the chat in the last day, from its cursor', async () => {
    t.client.initiatives.mockResolvedValueOnce({ items: [
      initiative({ id: 'recent', seq: 5 }),
      initiative({ id: 'old', seq: 6, pushedAt: '2026-11-01T08:00:00Z' }),
      initiative({ id: 'pending', seq: 7, status: 'pending', pushedAt: null }),
      initiative({ id: 'voice', seq: 8, channel: 'voice' }),
    ], next: 8, more: false });
    expect(await t.svc.pollFeed(NOW)).toBe(1);
    expect(t.client.initiatives).toHaveBeenCalledWith('u1', { since: 0, limit: 200 });
    await t.svc.pollFeed(NOW);
    expect(t.client.initiatives).toHaveBeenLastCalledWith('u1', { since: 8, limit: 200 });
  });
});

describe('RecordareWebhookController', () => {
  const secret = `whsec_${Buffer.from('a-test-secret-of-some-length').toString('base64')}`;
  const sign = (id: string, ts: number, body: string) =>
    `v1,${createHmac('sha256', Buffer.from(secret.replace(/^whsec_/, ''), 'base64')).update(`${id}.${ts}.${body}`).digest('base64')}`;

  it('verifies the signature over the raw body, then hands the event over; refuses a bad one; off without the secret', async () => {
    process.env.RECORDARE_URL = 'http://recordare:8080';
    process.env.RECORDARE_API_KEY = 'rk_test';
    process.env.RECORDARE_WEBHOOK_SECRET = secret;
    const handled: unknown[] = [];
    const ctl = new RecordareWebhookController({ handleEvent: async (e: unknown) => { handled.push(e); } } as any);
    const body = JSON.stringify({ type: 'initiative.deliver', timestamp: '2026-11-05T09:00:00Z', data: { ...initiative(), user: 'u1', memoryId: 'mem-1' } });
    const ts = Math.floor(Date.now() / 1000);
    ctl.receive({ rawBody: Buffer.from(body) } as any, { 'webhook-id': 'msg_1', 'webhook-timestamp': String(ts), 'webhook-signature': sign('msg_1', ts, body) });
    await new Promise((r) => setImmediate(r));
    expect(handled).toHaveLength(1);
    expect(() => ctl.receive({ rawBody: Buffer.from(body.replace('u1', 'u2')) } as any,
      { 'webhook-id': 'msg_1', 'webhook-timestamp': String(ts), 'webhook-signature': sign('msg_1', ts, body) })).toThrow(/Unauthorized/);
    delete process.env.RECORDARE_WEBHOOK_SECRET;
    expect(() => ctl.receive({ rawBody: Buffer.from(body) } as any, {})).toThrow(/Not Found/);
    delete process.env.RECORDARE_URL;
    delete process.env.RECORDARE_API_KEY;
  });
});
