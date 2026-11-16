// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * GET /api/chat-runs: the runs in progress in the chats the user may write to — a client listing chats (the wall
 * panel's drawer) shows which are working; another user's run is never listed.
 */
import { describe, expect, it, vi } from 'vitest';
import { ActiveChatRunsController } from '../../src/messages/chat-runs.controller';
import { ChatRunsService } from '../../src/messages/chat-runs.service';
import { SequencesService } from '../../src/sequences/sequences.service';
import { DEFAULT_LIMITS } from '../../src/sequences/sequence-program';

describe('ActiveChatRunsController', () => {
  it('lists the runs of the user\'s chats only', async () => {
    const gateway = { emitToWatchers: vi.fn(), emitToUser: vi.fn(), registerWatchable: vi.fn() };
    const runs = new ChatRunsService(gateway as any, {} as any);
    runs.start('chat-mine');
    runs.start('chat-other');
    const chats = { findOneForWrite: vi.fn(async (chatId: string) => { if (chatId !== 'chat-mine') throw new Error('not yours'); return {}; }) };
    const { runs: listed } = await new ActiveChatRunsController(chats as any, runs, new SequencesService(DEFAULT_LIMITS)).list({ id: 'u1' });
    expect(listed.map((r) => r.chatId)).toEqual(['chat-mine']);
    expect(listed[0].kind).toBe('run');
    expect(chats.findOneForWrite).toHaveBeenCalledWith('chat-other', 'u1');
  });

  it('lists the user\'s own sequences beside the runs', async () => {
    vi.useFakeTimers();
    try {
      const runs = new ChatRunsService({ emitToWatchers: vi.fn(), registerWatchable: vi.fn() } as any, {} as any);
      const sequences = new SequencesService(DEFAULT_LIMITS);
      const light = { name: 'light', invoke: vi.fn(async () => '{"ok":true}') };
      const program = (title: string) => ({ title, steps: [{ repeat: { forSeconds: 30, steps: [{ call: { tool: 'light', args: { t: title } } }, { wait: { seconds: 1 } }] } }] });
      sequences.start(program('Mine'), { userId: 'u1', chatId: 'c1', tools: [light] });
      sequences.start(program('Theirs'), { userId: 'u2', chatId: 'c2', tools: [light] });
      const out = await new ActiveChatRunsController({ findOneForWrite: vi.fn() } as any, runs, sequences).list({ id: 'u1' });
      expect(out.runs).toEqual([]);
      expect(out.sequences).toEqual([expect.objectContaining({ kind: 'sequence', title: 'Mine', chatId: 'c1', plannedSeconds: 30 })]);
      sequences.stop('u1');
      sequences.stop('u2');
      await vi.advanceTimersByTimeAsync(10);
    } finally {
      vi.useRealTimers();
    }
  });
});
