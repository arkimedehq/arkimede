/**
 * M4 regression — POST /api/feedback must verify the caller can access the chat
 * the rated message belongs to. Before the fix, createOrUpdate looked the message
 * up by id with no ownership check and copied the prompt/answer into the returned
 * feedback, leaking other tenants' conversation content by iterating messageIds.
 */
import { describe, it, expect, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { FeedbackService } from '../../src/feedback/feedback.service';

function makeService(chatAccess: (chatId: string, userId: string) => unknown) {
  const svc: any = Object.create(FeedbackService.prototype);
  svc.logger = { log() {}, debug() {}, warn() {}, error() {} };
  svc.messageRepo = {
    findOne: vi.fn(async (opts: any) =>
      opts.where.role === 'user'
        ? { content: "victim's prompt" }
        : { id: 'm1', chatId: 'chat-1', content: "victim's answer", createdAt: new Date('2020-01-01') }),
  };
  svc.chats = { findOne: vi.fn(async (chatId: string, userId: string) => chatAccess(chatId, userId)) };
  svc.repo = { findOne: vi.fn(async () => null), create: vi.fn((x: any) => x), save: vi.fn(async (x: any) => ({ ...x, id: 'f1' })) };
  svc.appConfig = { getFeedbackMemoryEnabled: vi.fn(async () => false) };
  svc.embedding = null;
  svc.vectorStore = null;
  return svc;
}

describe('feedback createOrUpdate — chat access enforced (M4)', () => {
  it('allows a user who can access the chat', async () => {
    const svc = makeService((id) => ({ id }));
    const res = await svc.createOrUpdate('owner', { messageId: 'm1', rating: 'positive' });
    expect(res.id).toBe('f1');
    expect(svc.chats.findOne).toHaveBeenCalledWith('chat-1', 'owner');
    expect(svc.repo.save).toHaveBeenCalled();
  });

  it("denies reading another tenant's message, saving nothing", async () => {
    const svc = makeService(() => { throw new ForbiddenException(); });
    await expect(svc.createOrUpdate('attacker', { messageId: 'm1', rating: 'positive' }))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(svc.repo.save).not.toHaveBeenCalled();
  });
});
