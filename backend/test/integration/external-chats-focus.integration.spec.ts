// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * External chats with a real DB: a focused turn is appended to the focused chat
 * (an empty one takes its title from the turn), the chat's history is read back
 * oldest first and only by its owner, a new chat keeps the satellite, and a
 * focus that ended since the chat's last activity stops the usual grouping.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestDb, type TestDb } from './_db';
import { ExternalChatsService } from '../../src/chats/external-chats.service';
import { Chat } from '../../src/chats/chats.entity';
import { Message } from '../../src/messages/messages.entity';
import { User } from '../../src/users/users.entity';

let db: TestDb;
let svc: ExternalChatsService;
let voice: string, other: string;

beforeAll(async () => {
  db = await startTestDb();
  const ds = db.dataSource;
  svc = new ExternalChatsService(ds.getRepository(Chat), ds.getRepository(Message));
  const users = ds.getRepository(User);
  voice = (await users.save(users.create({ email: 'voice@test', name: 'Voice', password: 'x' }))).id;
  other = (await users.save(users.create({ email: 'other@test', name: 'Other', password: 'x' }))).id;
}, 120_000);

afterAll(async () => { await db?.stop(); });

const turn = (over: Partial<Parameters<ExternalChatsService['recordTurn']>[0]>) => ({
  userId: voice, source: 'wyoming' as const, key: 'conv-1', idleMs: 600_000,
  userText: 'domanda', answer: 'risposta', ...over,
});

describe('ExternalChatsService — focus', () => {
  it('keeps the satellite on a new chat and groups the next turn as before', async () => {
    const first = await svc.recordTurn(turn({ satellite: 'assist_satellite.living', userText: 'luci' }));
    const second = await svc.recordTurn(turn({ satellite: 'assist_satellite.living', userText: 'spegni' }));
    expect(second).toBe(first);
    const chat = await db.dataSource.getRepository(Chat).findOneByOrFail({ id: first });
    expect(chat.externalSatellite).toBe('assist_satellite.living');
    expect(chat.title).toBe('luci');
  });

  it('appends a focused turn to the focused chat; an empty chat takes its title', async () => {
    const chats = db.dataSource.getRepository(Chat);
    const empty = await chats.save(chats.create({ userId: voice }));   // "+ New" on the client
    const id = await svc.recordTurn(turn({ key: 'conv-2', chatId: empty.id, userText: 'che tempo fa domani?' }));
    expect(id).toBe(empty.id);
    expect((await chats.findOneByOrFail({ id })).title).toBe('che tempo fa domani?');
    await svc.recordTurn(turn({ key: 'conv-3', chatId: empty.id, userText: 'e dopodomani?' }));
    expect((await chats.findOneByOrFail({ id })).title).toBe('che tempo fa domani?');
    const history = await svc.historyOf(empty.id, voice, 40);
    expect(history!.map((m) => m.content)).toEqual(['che tempo fa domani?', 'risposta', 'e dopodomani?', 'risposta']);
    expect((await svc.historyOf(empty.id, voice, 2))!.map((m) => m.content)).toEqual(['e dopodomani?', 'risposta']);
  });

  it('never reads or appends to a chat of another user', async () => {
    const chats = db.dataSource.getRepository(Chat);
    const foreign = await chats.save(chats.create({ userId: other, title: 'privata' }));
    expect(await svc.historyOf(foreign.id, voice, 40)).toBeNull();
    const id = await svc.recordTurn(turn({ key: 'conv-4', chatId: foreign.id }));
    expect(id).not.toBe(foreign.id);
    expect(await db.dataSource.getRepository(Message).countBy({ chatId: foreign.id })).toBe(0);
  });

  it('a focus that ended after the chat was last active starts a new chat', async () => {
    const first = await svc.recordTurn(turn({ key: 'conv-5' }));
    const next = await svc.recordTurn(turn({ key: 'conv-5', notBefore: Date.now() + 1000 }));
    expect(next).not.toBe(first);
    const again = await svc.recordTurn(turn({ key: 'conv-5', notBefore: Date.now() - 60_000 }));
    expect(again).toBe(next);
  });
});
