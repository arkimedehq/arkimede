// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Memory proposals are personal. The chat shows again the caller's own proposals
 * still to confirm that came from that chat (GET /api/user-memory/pending), and the
 * new ones reach only the user who wrote the turn — never the other writers of a
 * shared chat, who do follow its run.
 */
import { describe, expect, it, vi } from 'vitest';
import { UserMemoryService } from '../../src/user-memory/user-memory.service';
import { ChatRunsService, MEMORY_PROPOSAL_EVENT } from '../../src/messages/chat-runs.service';

const CHAT = 'chat-shared';
const rows = [
  { id: 'p1', userId: 'alice', status: 'pending', sourceChatId: CHAT, content: 'Alice lives in Ragusa' },
  { id: 'p2', userId: 'bob', status: 'pending', sourceChatId: CHAT, content: 'Bob is vegetarian' },
  { id: 'p3', userId: 'alice', status: 'pending', sourceChatId: 'other-chat', content: 'Alice has a dog' },
  { id: 'c1', userId: 'alice', status: 'confirmed', sourceChatId: CHAT, content: 'Alice likes jazz' },
];

function service() {
  const svc: any = Object.create(UserMemoryService.prototype);
  // A repository that honours `where` equality, as TypeORM does.
  svc.repo = {
    find: vi.fn(async ({ where }: any) => rows.filter((r: any) => Object.entries(where).every(([k, v]) => r[k] === v))),
  };
  return svc as UserMemoryService;
}

describe('pending proposals of a chat', () => {
  it('returns only the caller\'s own proposals from that chat, still to confirm', async () => {
    expect(await service().pendingForChat('alice', CHAT)).toEqual([{ id: 'p1', content: 'Alice lives in Ragusa' }]);
    expect(await service().pendingForChat('bob', CHAT)).toEqual([{ id: 'p2', content: 'Bob is vegetarian' }]);
  });

  it('gives nothing to a user without proposals there', async () => {
    expect(await service().pendingForChat('carol', CHAT)).toEqual([]);
  });
});

describe('new proposals after a turn', () => {
  it('go to the user who wrote, not to the chat\'s watchers', () => {
    const gateway = { emitToUser: vi.fn(), emitToWatchers: vi.fn(), registerWatchable: vi.fn() };
    const runs = new ChatRunsService(gateway as any, {} as any);
    runs.memoryProposals('alice', CHAT, [{ id: 'p1', content: 'x' }]);
    expect(gateway.emitToUser).toHaveBeenCalledWith('alice', MEMORY_PROPOSAL_EVENT, { chatId: CHAT, proposals: [{ id: 'p1', content: 'x' }] });
    expect(gateway.emitToWatchers).not.toHaveBeenCalled();
    runs.memoryProposals('alice', CHAT, []);
    expect(gateway.emitToUser).toHaveBeenCalledTimes(1);
  });
});
