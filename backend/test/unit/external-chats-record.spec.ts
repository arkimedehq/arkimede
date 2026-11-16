// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * An external turn recorded in two halves (external-chats.service.ts): the user's message first — with who said it
 * when known (a voice recognised on a satellite) — then the answer in the same chat; recordTurn does both, as before.
 */
import { describe, it, expect } from 'vitest';
import { ExternalChatsService } from '../../src/chats/external-chats.service';
import { fakeRepo } from './helpers/fake-repo';

function setup() {
  const chats = fakeRepo<any>();
  const messages = fakeRepo<any>();
  return { svc: new ExternalChatsService(chats as any, messages as any), chats, messages };
}
const turn = { userId: 'u1', source: 'wyoming', key: 'A', idleMs: 600_000, satellite: 'assist_satellite.living', userText: 'accendi la luce' };

describe('ExternalChatsService: a turn in two halves', () => {
  it('the user message with its speaker first, then the answer in the same chat', async () => {
    const { svc, chats, messages } = setup();
    const chatId = await svc.recordUserMessage({ ...turn, speaker: { channel: 'voice', externalId: 'v1', displayName: 'Alex' } });
    expect(chats.rows).toHaveLength(1);
    expect(messages.rows).toEqual([expect.objectContaining({ chatId, role: 'user', content: 'accendi la luce', authorId: 'u1', speaker: { channel: 'voice', externalId: 'v1', displayName: 'Alex' } })]);
    await svc.recordAnswer(chatId, { answer: 'Fatto.', toolCalls: [], usage: null });
    expect(messages.rows[1]).toMatchObject({ chatId, role: 'assistant', content: 'Fatto.' });
    expect(chats.rows[0]).toMatchObject({ unread: true });
  });

  it('recordTurn records both halves, with no speaker', async () => {
    const { svc, messages } = setup();
    const chatId = await svc.recordTurn({ ...turn, answer: 'Fatto.' });
    expect(messages.rows.map((m) => [m.chatId, m.role, m.speaker])).toEqual([[chatId, 'user', undefined], [chatId, 'assistant', undefined]]);
  });
});
