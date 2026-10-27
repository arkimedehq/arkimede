// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * POST /api/chats/:chatId/messages/stream and the run behind it: the run outlives
 * the SSE connection (a reload does not stop the agent; its answer is saved and the
 * watchers are told), stopping is explicit (cancel), one run per chat, progress
 * goes to the SSE page and to the chat's watchers.
 */
import { EventEmitter } from 'events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MessagesController } from '../../src/messages/messages.controller';
import { CHAT_RUN_EVENT, ChatRunsService } from '../../src/messages/chat-runs.service';

const CHAT = 'chat-1';

function fakeRes() {
  const res: any = new EventEmitter();
  res.events = [] as any[];
  res.setHeader = vi.fn();
  res.flushHeaders = vi.fn();
  res.write = vi.fn((s: string) => { res.events.push(JSON.parse(s.slice(6))); return true; });
  res.end = vi.fn();
  return res;
}

// A skill output on disk, under the caller's skills-output subdir.
let outDir: string;
let reportPath: string;
const savedEnv = process.env.SKILLS_OUTPUT_DIR;
beforeAll(() => {
  outDir = mkdtempSync(join(tmpdir(), 'pa-run-files-'));
  mkdirSync(join(outDir, 'u1'));
  reportPath = join(outDir, 'u1', 'diary.pdf');
  writeFileSync(reportPath, 'pdf');
  process.env.SKILLS_OUTPUT_DIR = outDir;
});
afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
  process.env.SKILLS_OUTPUT_DIR = savedEnv;
});

/**
 * An agent that starts a step, calls a tool (whose result is TOOL_RESULT), then waits
 * for `release` before answering — or failing, with FAIL_AFTER_GATE.
 */
function gatedAgent(toolResult: unknown = 'ok', failAfterGate = false) {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let started!: () => void;
  const running = new Promise<void>((r) => { started = r; });
  const seen: { signal?: AbortSignal } = {};
  const streamResponse = vi.fn(async (
    _input: string, _u: string, _p: unknown, _c: string, _h: unknown, _a: unknown, _i: unknown, _b: unknown,
    onChunk: (c: string) => void, onToolCall: (t: any) => void, signal: AbortSignal,
    onToolResult: (n: string, r: unknown, s: string) => void, opts: any,
  ) => {
    seen.signal = signal;
    opts?.onProgress?.({ type: 'model_start' });
    onToolCall({ name: 'archive', input: {} });
    onToolResult('archive', toolResult, 'success');
    started();
    await gate;
    if (failAfterGate) throw new Error('model provider exploded');
    if (signal.aborted) return null;
    opts?.onProgress?.({ type: 'model_start' });
    opts?.onProgress?.({ type: 'text' });
    onChunk('Archived.');
    return { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, provider: 'x', model: 'y' };
  });
  return { streamResponse, release: () => release(), running, seen };
}

function setup(agent = gatedAgent(), proposals: { id: string; content: string }[] = []) {
  const saved: any[] = [];
  const gateway = { emitToWatchers: vi.fn(), emitToUser: vi.fn(), registerWatchable: vi.fn() };
  const runs = new ChatRunsService(gateway as any, {} as any);
  const ctrl = new MessagesController(
    { findByChat: vi.fn(async () => []), save: vi.fn(async (m: any) => { saved.push(m); return { ...m, id: `m${saved.length}` }; }) } as any,
    {
      findOneForWrite: vi.fn(async () => ({ id: CHAT, title: 'x', userId: 'u1', projectId: null, agentTeamId: null })),
      touch: vi.fn(async () => undefined), updateTitle: vi.fn(async () => undefined),
    } as any,
    agent as any,
    {} as any,
    { trackOutput: vi.fn(async () => 'file-1') } as any,
    { maybeExtractOnTurn: vi.fn(async () => proposals) } as any,
    runs,
  );
  const send = (res: any) => ctrl.streamMessage(CHAT, { content: 'archive this' } as any, { id: 'u1' }, res);
  const runEvents = () => gateway.emitToWatchers.mock.calls.filter((c) => c[2] === CHAT_RUN_EVENT).map((c) => c[3]);
  return { ctrl, runs, agent, saved, send, runEvents, gateway };
}

describe('the run behind the SSE stream', () => {
  it('goes on after the page disconnects, saves the answer and tells the watchers', async () => {
    const { runs, agent, saved, send, runEvents } = setup();
    const res = fakeRes();
    const done = send(res);
    await agent.running;
    expect(runs.get(CHAT)).toMatchObject({ phase: 'tool', tool: 'archive', step: 1 });

    res.emit('close');                    // the page reloads
    const writesAtClose = res.write.mock.calls.length;
    agent.release();
    await done;

    expect(agent.seen.signal!.aborted).toBe(false);
    expect(saved.at(-1)).toMatchObject({ role: 'assistant', content: 'Archived.' });
    expect(res.write.mock.calls.length).toBe(writesAtClose);   // nothing written to the closed stream
    expect(res.end).not.toHaveBeenCalled();
    expect(runEvents().at(-1)).toEqual({ chatId: CHAT, run: null, messageId: `m${saved.length}` });
    expect(runs.get(CHAT)).toBeNull();
  });

  it('sends the progress to the page that asked', async () => {
    const { agent, send } = setup();
    const res = fakeRes();
    const done = send(res);
    await agent.running;
    agent.release();
    await done;
    const progress = res.events.filter((e: any) => e.type === 'progress').map((e: any) => [e.run.phase, e.run.step, e.run.tool]);
    expect(progress).toEqual([
      ['model', 1, null], ['tool', 1, 'archive'], ['tool', 1, 'archive'], ['model', 2, null], ['writing', 2, null],
    ]);
    expect(res.events.at(-1)).toMatchObject({ type: 'done', messageId: 'm2' });
    expect(res.end).toHaveBeenCalled();
  });

  it('stops only when cancelled', async () => {
    const { runs, agent, send, runEvents } = setup();
    const done = send(fakeRes());
    await agent.running;
    expect(runs.cancel(CHAT)).toBe(true);
    agent.release();
    await done;
    expect(agent.seen.signal!.aborted).toBe(true);
    expect(runEvents().at(-1)).toMatchObject({ run: null });
    expect(runs.get(CHAT)).toBeNull();
  });

  it('shows the files produced so far to the pages following the run', async () => {
    const { runs, agent, saved, send, runEvents } = setup(gatedAgent({ file: reportPath }));
    const done = send(fakeRes());
    await agent.running;
    await vi.waitFor(() => expect(runs.get(CHAT)!.files).toEqual([
      { name: 'diary.pdf', fileId: 'file-1', downloadUrl: '/api/files/file-1/download' },
    ]));
    expect(runEvents().some((e: any) => e.run?.files?.length === 1)).toBe(true);
    agent.release();
    await done;
    expect(saved.at(-1)).toMatchObject({ role: 'assistant', attachments: [expect.objectContaining({ fileId: 'file-1' })] });
  });

  it('keeps the files made before an error attached to the error turn', async () => {
    const { agent, saved, send } = setup(gatedAgent({ file: reportPath }, true));
    const res = fakeRes();
    const done = send(res);
    await agent.running;
    agent.release();
    await done;
    expect(saved.at(-1)).toMatchObject({
      role: 'assistant',
      content: expect.stringContaining('model provider exploded'),
      attachments: [{ name: 'diary.pdf', fileId: 'file-1', mimeType: 'application/pdf' }],
    });
    expect(res.events.find((e: any) => e.type === 'error')).toBeTruthy();
  });

  it('sends the memory proposals to this page and to the user\'s other pages', async () => {
    const proposals = [{ id: 'p1', content: 'Lives in Ragusa' }];
    const { agent, send, gateway } = setup(gatedAgent(), proposals);
    const res = fakeRes();
    const done = send(res);
    await agent.running;
    agent.release();
    await done;
    expect(res.events.find((e: any) => e.type === 'memory_proposal')).toEqual({ type: 'memory_proposal', proposals });
    expect(gateway.emitToUser).toHaveBeenCalledWith('u1', 'memory_proposal', { chatId: CHAT, proposals });
  });

    it('refuses a second message while the agent is still answering', async () => {
    const { agent, saved, send } = setup();
    const first = send(fakeRes());
    await agent.running;
    const res2 = fakeRes();
    await send(res2);
    expect(res2.events.map((e: any) => e.type)).toEqual(['connected', 'error', 'done']);
    expect(res2.events[1]).toMatchObject({ code: 'busy' });
    expect(res2.events[2]).toMatchObject({ messageId: null });
    expect(agent.streamResponse).toHaveBeenCalledTimes(1);
    expect(saved.filter((m) => m.role === 'user')).toHaveLength(1);
    agent.release();
    await first;
  });
});
