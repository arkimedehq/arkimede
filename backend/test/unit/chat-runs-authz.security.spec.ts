// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Only who may send messages in a chat (its author, or the owner/collaborators of
 * its project: ChatsService.findOneForWrite) sees or stops the agent run in it:
 * the socket room `chat:<id>`, GET .../run and POST .../run/cancel.
 */
import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { NotificationsGateway } from '../../src/notifications/notifications.gateway';
import { ChatRunsService } from '../../src/messages/chat-runs.service';
import { ChatRunsController } from '../../src/messages/chat-runs.controller';

const CHAT = '11111111-1111-4111-8111-111111111111';
const chats = {
  findOneForWrite: vi.fn(async (chatId: string, userId: string) => {
    if (chatId === CHAT && userId === 'author') return { id: chatId };
    throw new ForbiddenException();
  }),
};

function gatewayWithUser(socketId: string, userId: string | null) {
  const gw: any = Object.create(NotificationsGateway.prototype);
  gw.socketUser = new Map(userId ? [[socketId, userId]] : []);
  gw.watchables = new Map();
  gw.server = { to: vi.fn(() => ({ emit: vi.fn() })) };
  return gw as NotificationsGateway;
}

function socket(id: string) {
  return { id, join: vi.fn(async () => undefined), leave: vi.fn(async () => undefined) } as any;
}

describe('watching a chat\'s run (socket room)', () => {
  function setup(userId: string | null) {
    const gw = gatewayWithUser('s1', userId);
    new ChatRunsService(gw, chats as any).onModuleInit();
    return gw;
  }

  it('lets the chat\'s author in', async () => {
    const s = socket('s1');
    expect(await setup('author').handleWatch(s, { kind: 'chat', id: CHAT })).toEqual({ ok: true });
    expect(s.join).toHaveBeenCalledWith(`chat:${CHAT}`);
  });

  it('keeps out a user without write access', async () => {
    const s = socket('s1');
    expect(await setup('stranger').handleWatch(s, { kind: 'chat', id: CHAT })).toEqual({ ok: false });
    expect(s.join).not.toHaveBeenCalled();
  });

  it('keeps out a socket that never authenticated', async () => {
    const s = socket('s1');
    expect(await setup(null).handleWatch(s, { kind: 'chat', id: CHAT })).toEqual({ ok: false });
    expect(s.join).not.toHaveBeenCalled();
  });

  it('refuses unknown kinds and malformed ids', async () => {
    const gw = setup('author');
    for (const body of [{ kind: 'project', id: CHAT }, { kind: 'chat', id: 42 }, { kind: 'chat', id: 'x'.repeat(65) }, {}]) {
      const s = socket('s1');
      expect(await gw.handleWatch(s, body as any)).toEqual({ ok: false });
      expect(s.join).not.toHaveBeenCalled();
    }
  });
});

describe('GET/cancel the run over HTTP', () => {
  const runs = { get: vi.fn(() => null), cancel: vi.fn(() => true) };
  const ctrl = new ChatRunsController(chats as any, runs as any);

  it('answers the author', async () => {
    await expect(ctrl.get(CHAT, { id: 'author' })).resolves.toEqual({ run: null });
    await expect(ctrl.cancel(CHAT, { id: 'author' })).resolves.toEqual({ cancelled: true });
  });

  it('refuses anyone else, before touching the run', async () => {
    runs.cancel.mockClear();
    await expect(ctrl.get(CHAT, { id: 'stranger' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(ctrl.cancel(CHAT, { id: 'stranger' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(runs.cancel).not.toHaveBeenCalled();
  });
});
