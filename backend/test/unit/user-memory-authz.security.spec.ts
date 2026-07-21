/**
 * M5 regression — POST /api/user-memory/extract (extractForChat) must verify the
 * caller can access the chat before distilling facts from it. Before the fix it
 * loaded the chat's messages by chatId with no ownership check, letting a user
 * extract durable facts from another tenant's conversation.
 */
import { describe, it, expect, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { UserMemoryService } from '../../src/user-memory/user-memory.service';

function makeService(chatAccess: (chatId: string, userId: string) => unknown) {
  const svc: any = Object.create(UserMemoryService.prototype);
  svc.chats = { findOne: vi.fn(async (chatId: string, userId: string) => chatAccess(chatId, userId)) };
  svc.messageRepo = { find: vi.fn(async () => []) };
  svc.extract = vi.fn(async () => []); // isolate the access gate from the extraction logic
  return svc;
}

describe('user-memory extractForChat — chat access enforced (M5)', () => {
  it('extracts when the caller can access the chat', async () => {
    const svc = makeService((id) => ({ id }));
    await svc.extractForChat('owner', 'chat-1');
    expect(svc.chats.findOne).toHaveBeenCalledWith('chat-1', 'owner');
    expect(svc.messageRepo.find).toHaveBeenCalled();
    expect(svc.extract).toHaveBeenCalled();
  });

  it("denies extracting from another tenant's chat and reads no messages", async () => {
    const svc = makeService(() => { throw new ForbiddenException(); });
    await expect(svc.extractForChat('attacker', 'chat-1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(svc.messageRepo.find).not.toHaveBeenCalled();
    expect(svc.extract).not.toHaveBeenCalled();
  });
});
