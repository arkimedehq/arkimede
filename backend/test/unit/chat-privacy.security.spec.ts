// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Private chats and messages: only whoever wrote a message makes it private or
 * public again (never the assistant's, never a colleague's); the chat switch needs
 * write access; a message written in a private chat is saved private; the episodic
 * memory is told through the outbox, and nothing is enqueued when it is not configured.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { MessagesService } from '../../src/messages/messages.service';
import { MessagesController } from '../../src/messages/messages.controller';
import { ChatsService } from '../../src/chats/chats.service';
import { ChatRunsService } from '../../src/messages/chat-runs.service';

const CHAT = { id: 'c1', userId: 'owner' };
const rows: Record<string, { id: string; chatId: string; role: string; authorId: string | null }> = {
  mine: { id: 'mine', chatId: 'c1', role: 'user', authorId: 'owner' },
  legacy: { id: 'legacy', chatId: 'c1', role: 'user', authorId: null },
  colleague: { id: 'colleague', chatId: 'c1', role: 'user', authorId: 'marta' },
  reply: { id: 'reply', chatId: 'c1', role: 'assistant', authorId: null },
  elsewhere: { id: 'elsewhere', chatId: 'c2', role: 'user', authorId: 'owner' },
};

function service() {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const repo = {
    findOne: vi.fn(async ({ where }: any) => {
      const r = rows[where.id];
      return r && r.chatId === where.chatId ? { ...r } : null;
    }),
    update: vi.fn(async () => undefined),
    manager: { query: vi.fn(async (sql: string, params: unknown[]) => { queries.push({ sql, params }); return []; }) },
  };
  return { svc: new MessagesService(repo as any), repo, queries };
}

afterEach(() => { delete process.env.RECORDARE_URL; delete process.env.RECORDARE_API_KEY; });

describe('making a message private (MessagesService.setPrivate)', () => {
  it('its author decides, and the chat owner for a message without an author', async () => {
    const { svc, repo } = service();
    await expect(svc.setPrivate(CHAT, 'mine', 'owner', true)).resolves.toEqual({ id: 'mine', isPrivate: true });
    await expect(svc.setPrivate(CHAT, 'legacy', 'owner', false)).resolves.toEqual({ id: 'legacy', isPrivate: false });
    expect(repo.update).toHaveBeenCalledWith('mine', { isPrivate: true });
  });

  it('never someone else\'s message, the assistant\'s, or a message of another chat', async () => {
    const { svc, repo } = service();
    await expect(svc.setPrivate(CHAT, 'colleague', 'owner', true)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.setPrivate(CHAT, 'mine', 'marta', true)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.setPrivate(CHAT, 'reply', 'owner', true)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.setPrivate(CHAT, 'elsewhere', 'owner', true)).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('tells the episodic memory through the outbox only when it is configured', async () => {
    const off = service();
    await off.svc.setPrivate(CHAT, 'mine', 'owner', true);
    expect(off.queries).toHaveLength(0);

    process.env.RECORDARE_URL = 'http://recordare.test'; process.env.RECORDARE_API_KEY = 'rk_x';
    const on = service();
    await on.svc.setPrivate(CHAT, 'mine', 'owner', true);
    expect(on.queries).toHaveLength(1);
    expect(on.queries[0]!.sql).toMatch(/'message_privacy'/);
    expect(on.queries[0]!.params).toEqual(['c1', 'mine']);
  });
});

describe('the private chat switch (ChatsService.setPrivate)', () => {
  it('needs write access to the chat', async () => {
    const repo = { findOne: vi.fn(async () => ({ id: 'c1', userId: 'owner', projectId: null })), update: vi.fn(async () => undefined) };
    const svc = new ChatsService(repo as any, { canWrite: async () => false } as any);
    await expect(svc.setPrivate('c1', 'owner', true)).resolves.toEqual({ id: 'c1', isPrivate: true });
    await expect(svc.setPrivate('c1', 'stranger', true)).rejects.toBeInstanceOf(ForbiddenException);
    expect(repo.update).toHaveBeenCalledTimes(1);
  });
});

describe('sending in a private chat', () => {
  async function send(isPrivate: boolean) {
    const saved: any[] = [];
    const runs = new ChatRunsService({ emitToWatchers: vi.fn(), emitToUser: vi.fn(), registerWatchable: vi.fn() } as any, {} as any);
    const ctrl = new MessagesController(
      { findByChat: vi.fn(async () => []), save: vi.fn(async (m: any) => { saved.push(m); return { ...m, id: `m${saved.length}` }; }) } as any,
      {
        findOneForWrite: vi.fn(async () => ({ id: 'c1', title: 'x', userId: 'u1', projectId: null, agentTeamId: null, isPrivate })),
        touch: vi.fn(async () => undefined), updateTitle: vi.fn(async () => undefined),
      } as any,
      { streamResponse: vi.fn(async (...a: any[]) => { a[8]('ok'); return { inputTokens: 1, outputTokens: 1 }; }) } as any,
      {} as any, {} as any, { maybeExtractOnTurn: vi.fn(async () => []) } as any, runs,
    );
    const res: any = { on: vi.fn(), setHeader: vi.fn(), flushHeaders: vi.fn(), write: vi.fn(), end: vi.fn() };
    await ctrl.streamMessage('c1', { content: 'between us' } as any, { id: 'u1' }, res);
    return saved;
  }

  it('saves the person\'s message private, and a normal chat\'s public', async () => {
    expect((await send(true))[0]).toMatchObject({ role: 'user', content: 'between us', isPrivate: true });
    expect((await send(false))[0]).toMatchObject({ role: 'user', isPrivate: false });
  });
});
