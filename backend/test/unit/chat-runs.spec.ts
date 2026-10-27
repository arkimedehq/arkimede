// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * The agent runs in progress per chat (ChatRunsService): one per chat, the state
 * the pages show (step, phase, tool, recent tools), the throttled pushes, the end
 * of a run, a stale run id, and cancel.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  CHAT_RUN_EVENT, ChatRunsService, PROGRESS_THROTTLE_MS, RECENT_TOOLS, RUN_FILES,
} from '../../src/messages/chat-runs.service';

const T0 = 1_000_000;

function make() {
  const gateway = { emitToWatchers: vi.fn(), registerWatchable: vi.fn() };
  const runs = new ChatRunsService(gateway as any, {} as any);
  const pushes = () => gateway.emitToWatchers.mock.calls.map((c) => c[3]);
  return { runs, gateway, pushes };
}

describe('ChatRunsService', () => {
  it('runs one at a time per chat, pushed to the chat\'s watchers', () => {
    const { runs, gateway } = make();
    const a = runs.start('c1', T0);
    expect(a).not.toBeNull();
    expect(runs.start('c1', T0 + 1)).toBeNull();
    expect(runs.start('c2', T0 + 1)).not.toBeNull();
    expect(gateway.emitToWatchers).toHaveBeenCalledWith('chat', 'c1', CHAT_RUN_EVENT, {
      chatId: 'c1', run: expect.objectContaining({ phase: 'starting', step: 0, runId: a!.runId }),
    });
    expect(runs.get('c1')).toMatchObject({ chatId: 'c1', phase: 'starting' });
    expect(runs.get('c3')).toBeNull();
  });

  it('counts the steps and follows the phases', () => {
    const { runs } = make();
    const { runId } = runs.start('c1', T0)!;
    expect(runs.update('c1', runId, { phase: 'model', tool: null, nextStep: true }, T0 + 10)).toMatchObject({ step: 1, phase: 'model' });
    expect(runs.update('c1', runId, { phase: 'preparing', tool: 'archive', argsChars: 10 }, T0 + 20))
      .toMatchObject({ phase: 'preparing', tool: 'archive', argsChars: 10 });
    expect(runs.update('c1', runId, { phase: 'tool', tool: 'archive' }, T0 + 30)).toMatchObject({ phase: 'tool', argsChars: 0 });
    expect(runs.update('c1', runId, { phase: 'model', tool: null, nextStep: true }, T0 + 40)).toMatchObject({ step: 2 });
    // The same phase again: nothing to push.
    expect(runs.update('c1', runId, { phase: 'model', tool: null }, T0 + 50)).toBeNull();
  });

  it('pushes the growing arguments at most once per throttle window', () => {
    const { runs, pushes } = make();
    const { runId } = runs.start('c1', T0)!;
    runs.update('c1', runId, { phase: 'preparing', tool: 'archive', argsChars: 1 }, T0);
    const before = pushes().length;
    expect(runs.update('c1', runId, { phase: 'preparing', tool: 'archive', argsChars: 500 }, T0 + 100)).toBeNull();
    expect(pushes().length).toBe(before);
    // Not pushed, but kept: the page that opens the chat now reads it.
    expect(runs.get('c1')!.argsChars).toBe(500);
    expect(runs.update('c1', runId, { phase: 'preparing', tool: 'archive', argsChars: 900 }, T0 + PROGRESS_THROTTLE_MS))
      .toMatchObject({ argsChars: 900 });
    expect(pushes().length).toBe(before + 1);
  });

  it('keeps the last finished tools', () => {
    const { runs } = make();
    const { runId } = runs.start('c1', T0)!;
    for (let i = 0; i < RECENT_TOOLS + 3; i++) runs.toolDone('c1', runId, { tool: `t${i}`, ok: i % 2 === 0, durationMs: i }, T0 + i);
    const recent = runs.get('c1')!.recent;
    expect(recent).toHaveLength(RECENT_TOOLS);
    expect(recent[0].tool).toBe('t3');
    expect(recent.at(-1)).toMatchObject({ tool: `t${RECENT_TOOLS + 2}`, ok: true });
  });

  it('lists the files produced so far, once each, the latest RUN_FILES', () => {
    const { runs, pushes } = make();
    const { runId } = runs.start('c1', T0)!;
    const file = (i: number) => ({ name: `f${i}.pdf`, fileId: `id${i}`, downloadUrl: `/api/files/id${i}/download` });
    expect(runs.fileReady('c1', runId, file(0), T0 + 1)).toMatchObject({ files: [file(0)] });
    const before = pushes().length;
    expect(runs.fileReady('c1', runId, file(0), T0 + 2)).toBeNull();
    expect(pushes().length).toBe(before);
    for (let i = 1; i < RUN_FILES + 5; i++) runs.fileReady('c1', runId, file(i), T0 + 2 + i);
    const files = runs.get('c1')!.files;
    expect(files).toHaveLength(RUN_FILES);
    expect(files.at(-1)).toEqual(file(RUN_FILES + 4));
    expect(runs.fileReady('c1', 'stale-run', file(99), T0 + 100)).toBeNull();
  });

  it('ends with run null and the saved message, and frees the chat', () => {
    const { runs, gateway } = make();
    const { runId } = runs.start('c1', T0)!;
    runs.finish('c1', runId, 'm1');
    expect(gateway.emitToWatchers).toHaveBeenLastCalledWith('chat', 'c1', CHAT_RUN_EVENT, { chatId: 'c1', run: null, messageId: 'm1' });
    expect(runs.get('c1')).toBeNull();
    expect(runs.start('c1', T0 + 1)).not.toBeNull();
  });

  it('ignores a run id that is no longer the one in progress', () => {
    const { runs, gateway } = make();
    const old = runs.start('c1', T0)!;
    runs.finish('c1', old.runId);
    const now = runs.start('c1', T0 + 1)!;
    const calls = gateway.emitToWatchers.mock.calls.length;
    expect(runs.update('c1', old.runId, { phase: 'tool', tool: 'x' }, T0 + 2)).toBeNull();
    expect(runs.toolDone('c1', old.runId, { tool: 'x', ok: true }, T0 + 2)).toBeNull();
    runs.finish('c1', old.runId);
    expect(gateway.emitToWatchers.mock.calls.length).toBe(calls);
    expect(runs.get('c1')!.runId).toBe(now.runId);
  });

  it('keeps runs of different chats apart: state, watchers, cancel and end', () => {
    const { runs, gateway } = make();
    const a = runs.start('cA', T0)!;
    const b = runs.start('cB', T0)!;
    runs.update('cA', a.runId, { phase: 'preparing', tool: 'archive', argsChars: 30_000 }, T0 + 10);
    runs.update('cB', b.runId, { phase: 'tool', tool: 'search' }, T0 + 10);
    runs.toolDone('cB', b.runId, { tool: 'search', ok: true }, T0 + 20);

    expect(runs.get('cA')).toMatchObject({ phase: 'preparing', tool: 'archive', argsChars: 30_000, recent: [] });
    expect(runs.get('cB')).toMatchObject({ phase: 'tool', tool: 'search', recent: [expect.objectContaining({ tool: 'search' })] });
    // A run id only works on its own chat.
    expect(runs.update('cB', a.runId, { phase: 'writing' }, T0 + 30)).toBeNull();
    // Every push goes to the room of the chat it belongs to.
    for (const [kind, id, , data] of gateway.emitToWatchers.mock.calls) {
      expect(kind).toBe('chat');
      expect((data as any).chatId).toBe(id);
      if ((data as any).run) expect((data as any).run.runId).toBe(id === 'cA' ? a.runId : b.runId);
    }

    runs.cancel('cA');
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);
    runs.finish('cA', a.runId, 'mA');
    expect(runs.get('cA')).toBeNull();
    expect(runs.get('cB')).toMatchObject({ runId: b.runId, phase: 'tool' });
  });

  it('cancel aborts the run\'s signal', () => {
    const { runs } = make();
    const { signal } = runs.start('c1', T0)!;
    expect(runs.cancel('c2')).toBe(false);
    expect(runs.cancel('c1')).toBe(true);
    expect(signal.aborted).toBe(true);
  });
});
