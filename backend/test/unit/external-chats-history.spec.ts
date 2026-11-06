// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * The history of an external chat (a guest's on Telegram, a satellite's focused chat) as the agent gets it: the
 * assistant's tool calls go back with its answer — the agent replays them — so what a tool returned (the id of a task
 * waiting for confirmation) is still known on the next turn and a "yes" confirms it instead of preparing it again.
 */
import { describe, it, expect, vi } from 'vitest';
import { ExternalChatsService } from '../../src/chats/external-chats.service';

describe('ExternalChatsService.historyOf', () => {
  it('returns the messages oldest first, the assistant\'s tool calls with them; null for another user\'s chat', async () => {
    const prepared = { name: 'schedule_task', input: { title: 'Pancakes' }, output: 'PREPARED (awaiting confirmation) — id=t1', ok: true };
    const chatRepo = { findOne: vi.fn(async ({ where }: any) => (where.userId === 'u1' ? { id: where.id } : null)) };
    const messageRepo = {
      find: vi.fn(async () => [
        { id: 'm3', role: 'assistant', content: 'Te lo attivo? Basta un sì.', toolCalls: [prepared] },
        { id: 'm2', role: 'user', content: 'Ricordami i pancakes', toolCalls: null },
        { id: 'm1', role: 'system', content: 'x', toolCalls: null },
      ]),
    };
    const svc = new ExternalChatsService(chatRepo as any, messageRepo as any);
    expect(await svc.historyOf('c1', 'u1', 40)).toEqual([
      { id: 'm2', role: 'user', content: 'Ricordami i pancakes' },
      { id: 'm3', role: 'assistant', content: 'Te lo attivo? Basta un sì.', toolCalls: [prepared] },
    ]);
    expect(messageRepo.find).toHaveBeenCalledWith(expect.objectContaining({ select: expect.objectContaining({ toolCalls: true, id: true }) }));
    expect(await svc.historyOf('c1', 'u2', 40)).toBeNull();
  });
});
