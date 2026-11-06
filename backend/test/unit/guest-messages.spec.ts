// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Guests (contacts writing on a skill's messaging channel): only a daemon of a skill whose user channel reaches
 * contacts on that channel hands them over; the guest's message is saved with its speaker BEFORE the agent runs (the
 * memory reads who speaks), in one chat per guest; the answer is saved and returned; a guest's turns run in order. The
 * agent is told who speaks (a contact, never the owner); only a guest the skill marks authorized gets tools, any other
 * gets words only (the maintainer's rule, 2026-11-06).
 */
import { describe, it, expect, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { GuestMessagesService, guestInstructions } from '../../src/guests/guest-messages.service';

function setup() {
  const saved: any[] = [];
  const order: string[] = [];
  const messages = { create: (x: any) => x, save: vi.fn(async (x: any) => { saved.push(x); order.push(`save:${x.role}`); return x; }) };
  const chats = { update: vi.fn(async () => undefined) };
  const daemons = { findOne: vi.fn(async ({ where }: any) => (where.id === 'd1' && where.userId === 'agent' ? { id: 'd1', skillId: 'sk-tg' } : null)) };
  const externalChats = {
    openChat: vi.fn(async (q: any) => `chat:${q.source}:${q.key}`),
    historyOf: vi.fn(async () => [{ role: 'assistant', content: 'Chloé, domani hai la verifica.' }]),
  };
  const skills = { userChannels: vi.fn(async () => [{ kind: 'messaging', channel: 'telegram', script: 's', reaches: ['self', 'contacts'], skillId: 'sk-tg', skillName: 'telegram' }]) };
  const agent = {
    streamResponse: vi.fn(async (text: string, _u: string, _p: unknown, _c: unknown, _h: unknown, _a: unknown, _i: unknown, _b: unknown, onChunk: (s: string) => void) => {
      order.push(`run:${text}`);
      await new Promise((r) => setTimeout(r, 5));
      onChunk(`ok: ${text}`);
      return { inputTokens: 1, outputTokens: 2 };
    }),
  };
  const users = { findOne: vi.fn(async () => ({ id: 'agent', name: 'Andrea' })) };
  const svc = new GuestMessagesService(messages as any, chats as any, daemons as any, users as any, externalChats as any, skills as any, agent as any);
  return { svc, saved, order, agent, externalChats };
}

describe('GuestMessagesService', () => {
  it('runs the turn as the daemon owner in the guest\'s chat, the message saved with its speaker before the run', async () => {
    const t = setup();
    const res = await t.svc.handle('agent', 'd1', { channel: 'telegram', externalId: '4242', displayName: 'Chloé', text: 'sì, lo so!' });
    expect(res).toEqual({ answer: 'ok: sì, lo so!', chatId: 'chat:telegram:4242' });
    expect(t.externalChats.openChat).toHaveBeenCalledWith(expect.objectContaining({ userId: 'agent', source: 'telegram', key: '4242', title: 'Chloé · telegram' }));
    expect(t.order).toEqual(['save:user', 'run:sì, lo so!', 'save:assistant']);
    expect(t.saved[0]).toMatchObject({ chatId: 'chat:telegram:4242', role: 'user', authorId: null, speaker: { channel: 'telegram', externalId: '4242', displayName: 'Chloé' } });
    expect(t.saved[1]).toMatchObject({ role: 'assistant', content: 'ok: sì, lo so!' });
    expect(t.agent.streamResponse.mock.calls[0][4]).toEqual([{ role: 'assistant', content: 'Chloé, domani hai la verifica.' }]);
    expect(t.agent.streamResponse.mock.calls[0][12]).toMatchObject({ conversationId: 'chat:telegram:4242' });
  });

  it('a guest gets words only and is named as who speaks; an authorized contact gets the tools', async () => {
    const t = setup();
    await t.svc.handle('agent', 'd1', { channel: 'telegram', externalId: '88', displayName: 'Eriona', text: 'Ricordami lo yogurt' });
    const guest = t.agent.streamResponse.mock.calls[0][12];
    expect(guest).toMatchObject({ textOnly: true });
    expect(guest.agentPromptOverride).toContain('You are talking with Eriona');
    expect(guest.agentPromptOverride).toContain('never as Andrea');
    expect(guest.agentPromptOverride).toContain('no tools');
    // The authorized flag comes only as `true`; anything else is a guest.
    await t.svc.handle('agent', 'd1', { channel: 'telegram', externalId: '89', displayName: 'Chloé', text: 'accendi la luce', authorized: true });
    const trusted = t.agent.streamResponse.mock.calls[1][12];
    expect(trusted.textOnly).toBeUndefined();
    expect(trusted.agentPromptOverride).toContain('authorized contact');
    expect(trusted.agentPromptOverride).toContain('never as Andrea');
    expect(trusted.agentPromptOverride).toContain('is delivered to them on telegram');
  });

  it('guestInstructions: who speaks, and for a guest no action and the owner\'s memory kept private', () => {
    const words = guestInstructions({ name: 'Eriona', channel: 'telegram', authorized: false }, 'Andrea');
    expect(words).toMatch(/must not promise any action/);
    expect(words).toMatch(/private: do not reveal it to Eriona/);
    expect(guestInstructions({ name: 'Eriona', channel: 'telegram', authorized: true }, 'Andrea')).not.toMatch(/no tools/);
  });

  it('refuses a daemon that is not the owner\'s, or whose skill holds no channel for guests there', async () => {
    const t = setup();
    await expect(t.svc.handle('someone-else', 'd1', { channel: 'telegram', externalId: '1', text: 'x' })).rejects.toThrow(ForbiddenException);
    await expect(t.svc.handle('agent', 'd1', { channel: 'whatsapp', externalId: '1', text: 'x' })).rejects.toThrow(ForbiddenException);
    expect(t.agent.streamResponse).not.toHaveBeenCalled();
  });

  it('answers one guest\'s messages in order', async () => {
    const t = setup();
    await Promise.all([
      t.svc.handle('agent', 'd1', { channel: 'telegram', externalId: '4242', text: 'uno' }),
      t.svc.handle('agent', 'd1', { channel: 'telegram', externalId: '4242', text: 'due' }),
    ]);
    expect(t.order).toEqual(['save:user', 'run:uno', 'save:assistant', 'save:user', 'run:due', 'save:assistant']);
  });
});
