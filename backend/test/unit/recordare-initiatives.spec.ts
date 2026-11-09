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
import { RecordareInitiativesService, sharedWords, names, CHAT_SOURCE, EVENT_TYPE, ANSWER_WINDOW_MS } from '../../src/recordare/recordare-initiatives.service';
import { RecordareWebhookController } from '../../src/recordare/recordare-webhook.controller';
import { Chat } from '../../src/chats/chats.entity';
import { Message } from '../../src/messages/messages.entity';

const NOW = Date.parse('2026-11-05T09:00:00Z');

function initiative(over: Partial<Initiative> = {}): Initiative {
  return {
    id: '11111111-1111-4111-8111-111111111111', seq: 1, kind: 'say', for: null, text: 'Mi avevi chiesto di ricordarti di chiamare il commercialista: è oggi.',
    reason: 'a request they made to me', worth: 0.9, episodeIds: [], dueAt: '2026-11-05T08:00:00Z', expiresAt: '2026-11-06T08:00:00Z',
    status: 'offered', outcomeAt: null, reply: null, createdAt: '2026-11-05T08:00:00Z', timing: 'timed',
    window: { notBefore: '2026-11-05T08:00:00Z', notAfter: '2026-11-06T08:00:00Z' }, channel: 'chat', channels: ['voice', 'messaging', 'chat'], identity: { required: 'medium' },
    source: { conversation: 'chat-origin', messageIds: ['m1'] }, offeredAt: '2026-11-05T08:00:00Z', pushedAt: '2026-11-05T08:00:00Z', ...over,
  };
}

/** A fake database: users, notifications, scheduled tasks, chats and messages in memory. */
function fakeDb() {
  const state = {
    users: [{ id: 'u1', episodicMemoryEnabled: true, recordareMemoryId: 'mem-1' }, { id: 'u2', episodicMemoryEnabled: false, recordareMemoryId: 'mem-2' }],
    notifications: [] as Array<{ id?: string; userId: string; source: string; sourceId: string; eventType?: string; payload?: any; createdAt?: Date }>,
    tasks: [] as Array<{ userId: string; chatId: string | null; runAt: Date | null; title: string | null; instruction: string; status?: string; lastRunAt?: Date | null }>,
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
      if (/FROM "notifications"/.test(sql) && /'kind' = 'ask'/.test(sql)) {
        return state.notifications.filter((n) => n.source === p[0] && n.eventType === p[1] && n.payload?.kind === 'ask' && !n.payload?.answer
          && (n.createdAt as Date) > p[2]);
      }
      if (/FROM "notifications"/.test(sql)) return state.notifications.filter((n) => n.source === p[0] && n.sourceId === p[1]);
      if (/UPDATE "notifications"/.test(sql)) {
        const n = state.notifications.find((x) => x.id === p[0]);
        if (n) n.payload = { ...n.payload, ...JSON.parse(p[1]) };
        return [];
      }
      if (/FROM "messages"/.test(sql)) return state.messages.filter((m) => m.chatId === p[0] && m.role === 'user' && m.createdAt > p[1]);
      if (/FROM "scheduled_tasks"/.test(sql)) return state.tasks.filter((t) => t.userId === p[0]);
      throw new Error(`unexpected SQL: ${sql}`);
    },
    getRepository: (entity: unknown) => (entity === Chat ? repo(state.chats) : entity === Message ? repo(state.messages) : null),
  };
  return { ds: ds as any, state };
}

const clock = { now: NOW };

function setup() {
  clock.now = NOW;
  const db = fakeDb();
  const notifications = { create: vi.fn(async (dto: any) => {
    const id = `n${db.state.notifications.length + 1}`;
    db.state.notifications.push({ ...dto, id, createdAt: new Date(clock.now) });
    return { id };
  }) };
  const pushed: any[] = [];
  const listeners: Array<(u: string) => void> = [];
  const gateway = { emitToUser: (userId: string, event: string, data: unknown) => pushed.push({ userId, event, data }), onUserConnected: (l: (u: string) => void) => { listeners.push(l); return () => {}; } };
  const client = {
    reportInitiative: vi.fn(async () => ({})),
    presence: vi.fn(async () => ({ person: null, initiative: null, askWho: null })),
    initiatives: vi.fn(async () => ({ items: [] as Initiative[], next: 0, more: false })),
  };
  // The skills a user may use with a user channel (none by default), and what running one answers.
  const skills = {
    channels: [] as Array<{ kind: 'messaging'; channel: string; script: string; reaches: Array<'self' | 'contacts'>; skillId: string; skillName: string }>,
    userChannels: vi.fn(async () => skills.channels),
    invoke: vi.fn(async (..._a: unknown[]): Promise<any> => ({ success: true, output: { success: true }, raw: '', duration_ms: 1, exit_code: 0 })),
  };
  const svc = new RecordareInitiativesService(db.ds, notifications as any, gateway as any, skills as any);
  svc.client = () => client as any;
  /** What a webhook `initiative.deliver` does: true when a message was written. */
  const deliver = (user: string, i: Initiative) => svc.handleEvent({ type: 'initiative.deliver', timestamp: '', data: { ...i, user, memoryId: 'm' } });
  return { svc, db, client, pushed, notifications, listeners, deliver, skills };
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

  it('a question nobody answers in its chat within the channel\'s window is reported ignored; an answered one is not (F4)', async () => {
    const ask = (id: string) => initiative({ id, kind: 'ask', text: 'Hai steso i panni?' });
    await t.deliver('u1', ask('44444444-4444-4444-8444-444444444444'));
    await t.deliver('u1', ask('55555555-5555-4555-8555-555555555555'));
    await t.deliver('u1', initiative({ id: '66666666-6666-4666-8666-666666666666' })); // a reminder said: never checked
    const chatId = t.db.state.chats[0].id;
    // An hour later: within the chat's 12 hours, nothing reported yet.
    expect(await t.svc.checkAnswers(NOW + 3_600_000)).toBe(0);
    // The person answers (one reply after both questions, in the chat they were asked in).
    t.db.state.messages.push({ chatId, role: 'user', content: 'sì', createdAt: new Date(NOW + 2 * 3_600_000) });
    t.client.reportInitiative.mockClear();
    expect(await t.svc.checkAnswers(NOW + 13 * 3_600_000)).toBe(0);
    expect(t.client.reportInitiative).not.toHaveBeenCalled();
    expect(t.db.state.notifications.filter((n) => n.payload?.kind === 'ask').map((n) => n.payload.answer)).toEqual(['answered', 'answered']);
    // A new question, unanswered past the window: ignored, on its channel, once.
    clock.now = NOW + 20 * 3_600_000;
    await t.deliver('u1', ask('77777777-7777-4777-8777-777777777777'));
    expect(await t.svc.checkAnswers(NOW + 33 * 3_600_000)).toBe(1);
    expect(t.client.reportInitiative).toHaveBeenLastCalledWith('u1', '77777777-7777-4777-8777-777777777777', 'ignored', { channel: 'chat' });
    expect(await t.svc.checkAnswers(NOW + 34 * 3_600_000)).toBe(0);
    expect(ANSWER_WINDOW_MS).toEqual({ voice: 600_000, messaging: 21_600_000, chat: 43_200_000 });
  });

  it('messaging first when a skill offers a user channel: to the user\'s own account, recorded in the chat the skill uses, no push', async () => {
    const bot = { kind: 'messaging' as const, channel: 'telegram', script: 'scripts/send_message.js', reaches: ['self' as const, 'contacts' as const], skillId: 'sk-bot', skillName: 'telegram-bot' };
    t.skills.channels.push(bot);
    t.db.state.chats.push({ id: '33333333-3333-4333-8333-333333333333', userId: 'u1', title: 'Telegram' });
    t.skills.invoke.mockResolvedValueOnce({ success: true, output: { success: true, arkimede_chat: '33333333-3333-4333-8333-333333333333' } });
    expect(await t.deliver('u1', initiative())).toBe(true);
    expect(t.skills.invoke).toHaveBeenCalledWith('sk-bot', 'scripts/send_message.js', { text: initiative().text }, 30_000, 'u1', undefined);
    expect(t.db.state.messages).toEqual([expect.objectContaining({ chatId: '33333333-3333-4333-8333-333333333333', role: 'assistant' })]);
    expect(t.notifications.create).toHaveBeenCalledTimes(1); // the delivery record
    expect(t.pushed).toHaveLength(0); // it already rang on the phone
    expect(t.client.reportInitiative).toHaveBeenCalledWith('u1', initiative().id, 'said', { channel: 'messaging' });
  });

  it('to a contact at their address (the first channel that works), else the chat; an ask never goes by message', async () => {
    const forChloe = { personId: 'p-chloe', name: 'Chloé', addresses: [{ channel: 'telegram', id: '4242' }] };
    t.skills.channels.push(
      { kind: 'messaging', channel: 'telegram', script: 'scripts/send_message.js', reaches: ['self'], skillId: 'sk-self-only', skillName: 'self-only' },
      { kind: 'messaging', channel: 'telegram', script: 'scripts/send_message.js', reaches: ['self', 'contacts'], skillId: 'sk-bot', skillName: 'telegram-bot' },
      { kind: 'messaging', channel: 'telegram', script: 'scripts/send_message.py', reaches: ['contacts'], skillId: 'sk-account', skillName: 'telegram-account' },
    );
    t.skills.invoke.mockResolvedValueOnce({ success: true, output: { success: false, error: 'Forbidden: bot was blocked by the user' } });
    await t.deliver('u1', initiative({ for: forChloe }));
    expect(t.skills.invoke.mock.calls.map((c) => [c[0], c[5]])).toEqual([['sk-bot', { DELIVERY_ADDRESS: '4242' }], ['sk-account', { DELIVERY_ADDRESS: '4242' }]]);
    // Written in Chloé's guest chat on that channel, where her reply will arrive.
    expect(t.db.state.chats[0]).toMatchObject({ userId: 'u1', externalSource: 'telegram', externalKey: '4242', title: 'Chloé · telegram' });
    expect(t.db.state.messages[0]).toMatchObject({ chatId: 'id-1' });
    expect(t.client.reportInitiative).toHaveBeenLastCalledWith('u1', initiative().id, 'said', { channel: 'messaging' });
    // No address on any messaging channel: the chat.
    await t.deliver('u1', initiative({ id: '44444444-4444-4444-8444-444444444444', for: { ...forChloe, addresses: [{ channel: 'homeassistant', id: 'person.chloe' }] } }));
    expect(t.skills.invoke).toHaveBeenCalledTimes(2);
    expect(t.client.reportInitiative).toHaveBeenLastCalledWith('u1', '44444444-4444-4444-8444-444444444444', 'said', { channel: 'chat' });
    // An ask accepts voice and chat only.
    await t.deliver('u1', initiative({ id: '55555555-5555-4555-8555-555555555555', kind: 'ask', channels: ['voice', 'chat'] }));
    expect(t.skills.invoke).toHaveBeenCalledTimes(2);
  });

  it('messaging falls back to a push on the person\'s phone (Home Assistant) when no skill reaches them', async () => {
    const pushed: any[] = [];
    t.svc.setPush({ push: async (person, text) => { pushed.push({ person, text }); return person === 'person.chloe'; } });
    const forChloe = { personId: 'p', name: 'Chloé', addresses: [{ channel: 'homeassistant', id: 'person.chloe' }] };
    await t.deliver('u1', initiative({ for: forChloe, channels: ['messaging', 'chat'] }));
    expect(pushed).toEqual([{ person: 'person.chloe', text: initiative().text }]);
    expect(t.db.state.messages[0]).toMatchObject({ chatId: 'id-1' });
    expect(t.client.reportInitiative).toHaveBeenLastCalledWith('u1', initiative().id, 'said', { channel: 'messaging' });
  });

  it('by voice first when a voice channel reaches the person: their room, the message in the chat, reported voice', async () => {
    const said: any[] = [];
    t.svc.setVoice({ say: async (user, text, where, chatId) => { said.push({ user, text, where, chatId }); return where.person === 'person.chloe' ? 'assist_satellite.cucina' : null; } });
    const forChloe = { personId: 'p', name: 'Chloé', addresses: [{ channel: 'homeassistant', id: 'person.chloe' }] };
    expect(await t.deliver('u1', initiative({ for: forChloe }))).toBe(true);
    expect(said[0]).toMatchObject({ user: 'u1', where: { person: 'person.chloe' }, chatId: 'id-1' });
    expect(t.db.state.messages[0]).toMatchObject({ chatId: 'id-1' });
    expect(t.pushed).toHaveLength(0);
    expect(t.client.reportInitiative).toHaveBeenLastCalledWith('u1', initiative().id, 'said', { channel: 'voice' });
    // Nobody to reach by voice (no Home Assistant address, no room): the next channel (the chat).
    await t.deliver('u1', initiative({ id: '66666666-6666-4666-8666-666666666666' }));
    expect(t.client.reportInitiative).toHaveBeenLastCalledWith('u1', '66666666-6666-4666-8666-666666666666', 'said', { channel: 'chat' });
  });

  it('a room\'s presence: what Recordare answers is said in that room; with others there, only the opening', async () => {
    const said: any[] = [];
    t.svc.setVoice({ say: async (_u, text, where) => { said.push({ text, where }); return 'assist_satellite.cucina'; } });
    t.client.presence.mockResolvedValueOnce({ person: null, people: [], initiative: initiative({ for: null, channel: 'voice' }), askWho: null, opening: null } as any);
    const impulse = { channel: 'voice' as const, place: 'Cucina', people: [{ identity: { channel: 'homeassistant', externalId: 'person.chloe' } }] };
    await t.svc.roomPresence('u1', impulse, 'cucina');
    expect(t.client.presence).toHaveBeenCalledWith('u1', impulse);
    expect(said[0]).toEqual({ text: initiative().text, where: { areaId: 'cucina', person: undefined } });
    const opening = 'Chloé, ho una cosa per te: vuoi sentirla?';
    t.client.presence.mockResolvedValueOnce({ person: null, people: [], initiative: initiative({ id: '77777777-7777-4777-8777-777777777777', status: 'pending' }), askWho: null, opening } as any);
    await t.svc.roomPresence('u1', { ...impulse, someone: 1 }, 'cucina');
    expect(said[1]).toEqual({ text: opening, where: { areaId: 'cucina' } });
    expect(t.db.state.messages).toHaveLength(1); // the opening is not the initiative
    await t.svc.roomPresence('u2', impulse, 'cucina'); // memory off
    expect(t.client.presence).toHaveBeenCalledTimes(2);
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

  it('a task covers an initiative only for the same person, and a task already run near its time too (never twice)', async () => {
    const eriona = { personId: 'p-er', name: 'Eriona', addresses: [{ channel: 'telegram', id: '4242001' }] };
    const yogurt = initiative({ for: eriona as any, text: 'Eriona, ricordati di preparare lo yogurt con la yogurtiera', dueAt: '2026-11-06T19:00:00Z', source: null });
    // The task the agent made at her request was a push to Andrea: it does not cover what is for Eriona (she would get nothing).
    t.db.state.tasks.push({ userId: 'u1', chatId: 'x', runAt: new Date('2026-11-06T20:00:00Z'), title: 'Promemoria yogurt in yogurtiera', instruction: 'Invia ad Andrea una notifica push: prepara lo yogurt', status: 'active' });
    const log = vi.spyOn((t.svc as any).logger, 'log');
    expect(await t.svc.alreadyScheduled('u1', yogurt)).toBe(false);
    // Why it did not cover is logged (the task may be gone by the time someone asks).
    expect(log).toHaveBeenLastCalledWith(expect.stringMatching(/not covered — .*: does not name Eriona/));
    // A task that names her (or carries her Telegram id) covers it; its own time wins (an hour apart).
    t.db.state.tasks[0].instruction = 'Manda a Eriona su Telegram: prepara lo yogurt';
    expect(await t.svc.alreadyScheduled('u1', yogurt)).toBe(true);
    t.db.state.tasks[0].instruction = 'send_message to 4242001: prepara lo yogurt nella yogurtiera';
    expect(await t.svc.alreadyScheduled('u1', yogurt)).toBe(true);
    // Already run near the initiative's time: covered (said once); run long before, or failed: the memory's net.
    Object.assign(t.db.state.tasks[0], { status: 'done', lastRunAt: new Date('2026-11-06T18:30:00Z') });
    expect(await t.svc.alreadyScheduled('u1', yogurt)).toBe(true);
    t.db.state.tasks[0].lastRunAt = new Date('2026-11-06T08:00:00Z');
    expect(await t.svc.alreadyScheduled('u1', yogurt)).toBe(false);
    expect(names('Promemoria per Eriona', eriona)).toBe(true);
    expect(names('Promemoria per Andrea', eriona)).toBe(false);
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

  it('the chat presence says busy when the user\'s Home Assistant person is busy on their phone, else nothing about it', async () => {
    (t.db.state.users[0] as any).haPerson = 'person.alex';
    const busy = new Set<string>(['person.alex']);
    t.svc.setBusy({ busy: (p) => busy.has(p) });
    await t.svc.onPresence('u1', NOW);
    expect(t.client.presence).toHaveBeenLastCalledWith('u1', { channel: 'chat', busy: true });
    busy.clear();
    await t.svc.onPresence('u1', NOW + 11 * 60_000);
    expect(t.client.presence).toHaveBeenLastCalledWith('u1', { channel: 'chat' });
    t.svc.setBusy(null);
    busy.add('person.alex');
    await t.svc.onPresence('u1', NOW + 22 * 60_000);
    expect(t.client.presence).toHaveBeenLastCalledWith('u1', { channel: 'chat' });
  });

  it('the feed catches up on what was pushed to its channels in the last day, from its cursor', async () => {
    t.client.initiatives.mockResolvedValueOnce({ items: [
      initiative({ id: 'recent', seq: 5 }),
      initiative({ id: 'old', seq: 6, pushedAt: '2026-11-01T08:00:00Z' }),
      initiative({ id: 'pending', seq: 7, status: 'pending', pushedAt: null }),
      initiative({ id: 'voice', seq: 8, channel: 'voice' }),
    ], next: 8, more: false });
    // Recent pushes on Arkimede's channels — the chat and the voice one too (nobody in a room: the chat takes it).
    expect(await t.svc.pollFeed(NOW)).toBe(2);
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
