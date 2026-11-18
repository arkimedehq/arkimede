// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Sequences (specs/RUN_SEQUENCE.md): the program check (tools, denylist, confirmation, bounds, restart key), the engine
 * (timing, repeat, parallel, random, jitter, finally on stop/failure/timeout, failure streaks) and the per-user registry
 * (start at once, replace by key, cap, stop).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkProgram, DEFAULT_LIMITS, isDeniedTool, limitsFromEnv } from '../../src/sequences/sequence-program';
import { runSequence, type SequenceTool } from '../../src/sequences/sequence-engine';
import { SequencesService, sequenceProcedureRun } from '../../src/sequences/sequences.service';
import * as recordareConfigModule from '../../src/recordare/recordare.config';
import { PROCEDURE_NOTE_MAX } from '../../src/recordare/recordare-procedures';

const T0 = Date.UTC(2026, 10, 16, 10, 0, 0);

function tool(name: string, impl?: (args: any) => unknown): SequenceTool & { times: number[]; args: any[] } {
  const times: number[] = [];
  const args: any[] = [];
  return {
    name, times, args,
    invoke: vi.fn(async (a: any) => { times.push(Date.now() - T0); args.push(a); return impl ? impl(a) : '{"ok":true}'; }),
  };
}

const call = (t: string, args: Record<string, unknown> = {}) => ({ call: { tool: t, args } });
const wait = (seconds: number, jitterSeconds?: number) => ({ wait: jitterSeconds === undefined ? { seconds } : { seconds, jitterSeconds } });

describe('checkProgram', () => {
  const tools = ['light', 'notify', 'agent_dev', 'save_memory', 'schedule_task'];

  it('accepts a program and plans duration, calls and tools', () => {
    const r = checkProgram({
      title: 'Blink',
      steps: [{ repeat: { forSeconds: 10, steps: [{ parallel: [call('light', { area: 'A' }), call('light', { area: 'B' })] }, wait(1, 0.5)] } }],
      finally: [call('notify')],
    }, tools);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.plannedSeconds).toBe(10);
    // 10 s / 0.5 s shortest round = 20 rounds × 2 calls + finally
    expect(r.plan.maxCalls).toBe(41);
    expect(r.plan.tools).toEqual(['light', 'notify']);
  });

  it('refuses tools not in the turn and tools that run a model, schedule or write memory', () => {
    const r = checkProgram({ steps: [call('missing'), call('agent_dev'), call('save_memory'), call('schedule_task')] }, tools);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join('\n')).toMatch(/"missing" is not one of your tools/);
    expect(r.errors.filter((e) => /cannot run in a sequence/.test(e))).toHaveLength(3);
    for (const n of ['team_x', 'flow_y', 'run_sequence', 'stop_sequences', 'run_in_sandbox', 'search_memory']) expect(isDeniedTool(n)).toBe(true);
    expect(isDeniedTool('ha_call_service')).toBe(false);
  });

  it('never confirms on the user\'s behalf', () => {
    const r = checkProgram({ steps: [call('light', { confirmed: true })] }, tools);
    expect(r).toMatchObject({ ok: false, errors: [expect.stringMatching(/never confirms/)] });
    expect(checkProgram({ steps: [call('light', { confirmed: false })] }, tools).ok).toBe(true);
  });

  it('enforces the bounds', () => {
    const bad = (program: unknown, re: RegExp) => {
      const r = checkProgram(program, tools);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.join('\n')).toMatch(re);
    };
    bad({ steps: [wait(0.1)] }, /at least 0.2 s/);
    bad({ steps: [wait(1, 2)] }, /jitterSeconds cannot exceed/);
    bad({ steps: [{ repeat: { steps: [call('light')] } }] }, /either count or forSeconds/);
    bad({ steps: [{ repeat: { count: 2, forSeconds: 2, steps: [call('light')] } }] }, /either count or forSeconds/);
    bad({ steps: [{ repeat: { forSeconds: 5, steps: [call('light')] } }] }, /needs a wait/);
    bad({ steps: [{ repeat: { count: 11, steps: [wait(60)] } }] }, /lasts 660 s.*schedule_task/);
    bad({ steps: [{ repeat: { count: 1001, steps: [call('light')] } }] }, /1001 tool calls/);
    bad({ steps: [{ parallel: Array.from({ length: 9 }, () => call('light')) }] }, /at most 8 parallel/);
    const deep = (n: number): any => (n === 0 ? call('light') : { repeat: { count: 1, steps: [deep(n - 1)] } });
    bad({ steps: [deep(4)] }, /deeper than 4/);
    expect(checkProgram({ steps: [deep(3)] }, tools).ok).toBe(true);
    bad({ steps: [{ call: { tool: 'light' }, extra: 1 }] }, /steps/);
    bad({ steps: [] }, /steps/);
    bad({ steps: [call('light')], finally: [wait(31)] }, /finally lasts/);
  });

  it('derives the restart key from the calls (not the timing), or takes the program\'s', () => {
    const key = (p: unknown) => { const r = checkProgram(p, tools); return r.ok ? r.plan.key : null; };
    const a = key({ steps: [{ repeat: { count: 3, steps: [call('light', { area: 'A', x: 1 }), wait(1)] } }] });
    const b = key({ steps: [{ repeat: { forSeconds: 5, steps: [call('light', { x: 1, area: 'A' }), wait(0.3)] } }] });
    const c = key({ steps: [call('light', { area: 'B' })] });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(key({ key: 'kitchen', steps: [call('light')] })).toBe('key:kitchen');
  });

  it('reads its limits from the environment', () => {
    expect(limitsFromEnv({ RUN_SEQUENCE_MAX_SECONDS: '120', RUN_SEQUENCE_MAX_PER_USER: 'x' } as any))
      .toMatchObject({ maxSeconds: 120, maxPerUser: DEFAULT_LIMITS.maxPerUser, maxCalls: 1000 });
  });
});

describe('runSequence', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0); });
  afterEach(() => { vi.useRealTimers(); });

  const run = (program: any, tools: SequenceTool[], extra: Partial<Parameters<typeof runSequence>[1]> = {}) => {
    const abort = new AbortController();
    const done = runSequence(program, {
      tools: new Map(tools.map((t) => [t.name, t])), limits: DEFAULT_LIMITS, signal: abort.signal, ...extra,
    });
    return { abort, done };
  };

  it('keeps the timing of repeats and waits', async () => {
    const l = tool('light');
    const { done } = run({ steps: [{ repeat: { count: 3, steps: [call('light'), wait(1)] } }] }, [l]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await done).toMatchObject({ status: 'completed', calls: 3, failures: 0 });
    expect(l.times).toEqual([0, 1000, 2000]);
  });

  it('keeps the cadence when the calls take time, without bursts when they take longer than the wait', async () => {
    const slow = (ms: number) => tool('light', () => new Promise((r) => setTimeout(() => r('{"ok":true}'), ms)));
    // "every 2 s for 10 s": off, 1 s, on, 1 s — each call takes 400 ms, the rounds still start every 2 s.
    const l = slow(400);
    const end = tool('end');
    const { done } = run({ steps: [{ repeat: { count: 5, steps: [call('light', { s: 'off' }), wait(1), call('light', { s: 'on' }), wait(1)] } }], finally: [call('end')] }, [l, end]);
    await vi.advanceTimersByTimeAsync(15000);
    expect((await done).status).toBe('completed');
    expect(l.times.filter((_, i) => i % 2 === 0)).toEqual([0, 2000, 4000, 6000, 8000]);
    expect(l.times.filter((_, i) => i % 2 === 1)).toEqual([1000, 3000, 5000, 7000, 9000]);
    expect(end.times).toEqual([10000]);

    // forSeconds counts the same way: 3 rounds in 3 s, not fewer because of the calls.
    vi.setSystemTime(T0);
    const f = slow(300);
    const second = run({ steps: [{ repeat: { forSeconds: 3, steps: [call('light'), wait(1)] } }] }, [f]);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await second.done).calls).toBe(3);
    expect(f.times).toEqual([0, 1000, 2000]);

    // A call slower than the wait: no wait, then the beat restarts from now (no catch-up burst).
    vi.setSystemTime(T0);
    const v = slow(1500);
    const third = run({ steps: [{ repeat: { count: 3, steps: [call('light'), wait(1)] } }] }, [v]);
    await vi.advanceTimersByTimeAsync(10000);
    expect((await third.done).calls).toBe(3);
    expect(v.times).toEqual([0, 1500, 3000]);
  });

  it('keeps the beat across parallel branches: the longest branch sets it', async () => {
    const a = tool('a', () => new Promise((r) => setTimeout(() => r('{"ok":true}'), 200)));
    const b = tool('b');
    const c = tool('c');
    const { done } = run({ steps: [call('a'), { parallel: [wait(2), call('b')] }, wait(1), call('c')] }, [a, b, c]);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await done).status).toBe('completed');
    expect(b.times).toEqual([200]);
    expect(c.times).toEqual([3000]);
  });

  it('repeats for a duration, with parallel branches at the same moment', async () => {
    const a = tool('a');
    const b = tool('b');
    const { done } = run({ steps: [{ repeat: { forSeconds: 3, steps: [{ parallel: [call('a'), call('b')] }, wait(1)] } }] }, [a, b]);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await done).status).toBe('completed');
    expect(a.times).toEqual([0, 1000, 2000]);
    expect(b.times).toEqual(a.times);
  });

  it('chooses at random and applies the jitter', async () => {
    const a = tool('a');
    const b = tool('b');
    const randoms = [0.9, 0, 0.1, 1 - 1e-9];
    const { done } = run({ steps: [{ choose: { random: [call('a'), call('b')] } }, wait(1, 0.5), { choose: { random: [call('a'), call('b')] } }, wait(1, 0.5), call('a')] },
      [a, b], { random: () => randoms.shift()! });
    await vi.advanceTimersByTimeAsync(5000);
    await done;
    // 0.9 → b at 0; wait 1 - 0.5 = 0.5 s; 0.1 → a at 500; wait ≈ 1.5 s; a at ≈ 2000
    expect(b.times).toEqual([0]);
    expect(a.times[0]).toBe(500);
    expect(a.times[1]).toBeGreaterThanOrEqual(1999);
  });

  it('stops on request and still runs finally', async () => {
    const l = tool('light');
    const restore = tool('restore');
    const { abort, done } = run({ steps: [{ repeat: { forSeconds: 60, steps: [call('light'), wait(1)] } }], finally: [call('restore')] }, [l, restore]);
    await vi.advanceTimersByTimeAsync(2500);
    abort.abort();
    await vi.advanceTimersByTimeAsync(10);
    const out = await done;
    expect(out.status).toBe('stopped');
    expect(l.times).toEqual([0, 1000, 2000]);
    expect(restore.times).toEqual([2500]);
    expect(out.errors).toEqual([]);
  });

  it('goes on after a failed call, and stops when the same call fails three times in a row', async () => {
    let n = 0;
    const flaky = tool('flaky', () => { n++; if (n === 1) throw new Error('boom'); return '{"ok":true}'; });
    const dead = tool('dead', () => '{"error":"unavailable"}');
    const restore = tool('restore');
    const first = run({ steps: [call('flaky'), call('flaky')] }, [flaky]);
    await vi.advanceTimersByTimeAsync(10);
    expect(await first.done).toMatchObject({ status: 'completed', calls: 2, failures: 1, errors: ['flaky: boom'] });

    const second = run({ steps: [{ repeat: { count: 10, steps: [call('dead'), wait(1)] } }], finally: [call('restore')] }, [dead, restore]);
    await vi.advanceTimersByTimeAsync(10_000);
    const out = await second.done;
    expect(out).toMatchObject({ status: 'failed', calls: 4, failures: 3 });
    expect(out.errors.join('\n')).toMatch(/dead failed 3 times in a row/);
  });

  it('stops at the first failure when asked, also across parallel branches', async () => {
    const bad = tool('bad', () => '{"needs_confirmation":true}');
    const slow = tool('slow');
    const { done } = run({ stopOnError: true, steps: [{ parallel: [call('bad'), { repeat: { count: 5, steps: [wait(1), call('slow')] } }] }] }, [bad, slow]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await done).status).toBe('failed');
    expect(slow.times).toEqual([]);
  });

  it('is cut at the time limit (plus grace) and runs finally', async () => {
    const l = tool('light');
    const restore = tool('restore');
    const hang = { name: 'hang', invoke: (_: any, cfg?: { signal?: AbortSignal }) => new Promise((_r, reject) => cfg?.signal?.addEventListener('abort', () => reject(new Error('aborted')))) };
    const { done } = run({ steps: [call('light'), call('hang')], finally: [call('restore')] }, [l, restore, hang],
      { limits: { ...DEFAULT_LIMITS, maxSeconds: 1 } });
    await vi.advanceTimersByTimeAsync(62_000);
    const out = await done;
    expect(out.status).toBe('timeout');
    expect(restore.times).toEqual([61_000]);
  });

  it('reports progress after each call', async () => {
    const l = tool('light');
    const seen: number[] = [];
    const { done } = run({ steps: [call('light'), wait(1), call('light')] }, [l], { onProgress: (p) => seen.push(p.calls) });
    await vi.advanceTimersByTimeAsync(2000);
    await done;
    expect(seen).toEqual([1, 2]);
  });
});

describe('SequencesService', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0); });
  afterEach(() => { vi.useRealTimers(); });

  const blink = (key?: string, seconds = 60) => ({ ...(key ? { key } : {}), title: 'Blink', steps: [{ repeat: { forSeconds: seconds, steps: [call('light', { area: key ?? 'A' }), wait(1)] } }] });

  it('answers at once, lists while running, reports the end', async () => {
    const svc = new SequencesService(DEFAULT_LIMITS);
    const l = tool('light');
    const onEnd = vi.fn();
    const r = svc.start(blink(undefined, 3), { userId: 'u1', chatId: 'c1', tools: [l], onEnd });
    expect(r).toMatchObject({ ok: true, estimatedSeconds: 3, replaced: [] });
    expect(l.invoke).not.toHaveBeenCalled();
    expect(svc.list('u1')).toEqual([expect.objectContaining({ title: 'Blink', chatId: 'c1', tools: ['light'] })]);
    expect(svc.list('u2')).toEqual([]);
    await vi.advanceTimersByTimeAsync(4000);
    expect(svc.list('u1')).toEqual([]);
    expect(onEnd).toHaveBeenCalledWith(expect.objectContaining({ title: 'Blink' }), expect.objectContaining({ status: 'completed', calls: 3 }));
  });

  it('returns the check errors without starting', () => {
    const svc = new SequencesService(DEFAULT_LIMITS);
    expect(svc.start({ steps: [call('nope')] }, { userId: 'u1', tools: [] })).toMatchObject({ ok: false });
    expect(svc.list('u1')).toEqual([]);
  });

  it('replaces a running sequence with the same key, and caps the sequences per user', async () => {
    const svc = new SequencesService({ ...DEFAULT_LIMITS, maxPerUser: 2 });
    const l = tool('light');
    const onEnd = vi.fn();
    const a = svc.start(blink('kitchen'), { userId: 'u1', tools: [l], onEnd });
    const b = svc.start(blink('kitchen'), { userId: 'u1', tools: [l] });
    expect(b).toMatchObject({ ok: true, replaced: [(a as any).sequenceId] });
    await vi.advanceTimersByTimeAsync(10);
    expect(onEnd).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ status: 'stopped' }));
    expect(svc.start(blink('hall'), { userId: 'u1', tools: [l] }).ok).toBe(true);
    expect(svc.start(blink('porch'), { userId: 'u1', tools: [l] })).toMatchObject({ ok: false, errors: [expect.stringMatching(/at most 2/)] });
    // Replacing does not count against the cap; another user has their own.
    expect(svc.start(blink('hall'), { userId: 'u1', tools: [l] }).ok).toBe(true);
    expect(svc.start(blink('porch'), { userId: 'u2', tools: [l] }).ok).toBe(true);
    svc.stop('u1');
    svc.stop('u2');
    await vi.advanceTimersByTimeAsync(10);
  });

  it('stops one sequence or all of a user\'s, never another user\'s', async () => {
    const svc = new SequencesService(DEFAULT_LIMITS);
    const l = tool('light');
    const a = svc.start(blink('a'), { userId: 'u1', tools: [l] }) as any;
    svc.start(blink('b'), { userId: 'u1', tools: [l] });
    const c = svc.start(blink('c'), { userId: 'u2', tools: [l] }) as any;
    expect(svc.stop('u1', c.sequenceId)).toEqual([]);
    expect(svc.stop('u1', a.sequenceId)).toEqual([a.sequenceId]);
    await vi.advanceTimersByTimeAsync(10);
    expect(svc.list('u1').map((s) => s.title)).toHaveLength(1);
    expect(svc.stop('u1')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(svc.list('u1')).toEqual([]);
    expect(svc.list('u2')).toHaveLength(1);
    svc.stop('u2');
    await vi.advanceTimersByTimeAsync(10);
  });
});

describe('run_sequence / stop_sequences tools', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0); });
  afterEach(() => { vi.useRealTimers(); });

  const byName = (tools: any[]) => Object.fromEntries(tools.map((t) => [t.name, t]));

  it('are absent when no tool of the turn may run in a sequence', () => {
    const svc = new SequencesService(DEFAULT_LIMITS);
    expect(svc.buildTools('u1', 'c1', [])).toEqual([]);
    expect(svc.buildTools('u1', 'c1', [tool('agent_dev'), tool('save_memory'), tool('run_in_sandbox')])).toEqual([]);
    expect(svc.buildTools('u1', 'c1', [tool('light')]).map((t) => t.name)).toEqual(['run_sequence', 'stop_sequences']);
  });

  it('refuses a program with a denied or unknown tool, telling the model why', async () => {
    const svc = new SequencesService(DEFAULT_LIMITS);
    const t = byName(svc.buildTools('u1', 'c1', [tool('light'), tool('agent_dev')]));
    const out = JSON.parse(await t.run_sequence.invoke({ steps: [call('agent_dev'), call('nope')] }));
    expect(out.error).toBe('program refused');
    expect(out.errors.join('\n')).toMatch(/"agent_dev" is not one of your tools/);
    expect(out.errors.join('\n')).toMatch(/"nope" is not one of your tools/);
    expect(svc.list('u1')).toEqual([]);
  });

  it('starts at once and returns, then stop_sequences stops it (finally runs)', async () => {
    const svc = new SequencesService(DEFAULT_LIMITS);
    const l = tool('light');
    const t = byName(svc.buildTools('u1', 'c1', [l]));
    const out = JSON.parse(await t.run_sequence.invoke({
      title: 'Blink', key: 'k',
      steps: [{ repeat: { forSeconds: 30, steps: [call('light', { s: 'toggle' }), wait(1)] } }],
      finally: [call('light', { s: 'on' })],
    }));
    expect(out).toMatchObject({ started: true, estimatedSeconds: 30, sequenceId: expect.any(String) });
    // Answered without waiting: at most the first call has been made (no time has passed).
    expect(l.times.length).toBeLessThanOrEqual(1);
    await vi.advanceTimersByTimeAsync(2500);
    expect(JSON.parse(await t.stop_sequences.invoke({}))).toEqual({ stopped: ['Blink'] });
    await vi.advanceTimersByTimeAsync(10);
    expect(l.args.map((a) => a.s)).toEqual(['toggle', 'toggle', 'toggle', 'on']);
    expect(JSON.parse(await t.stop_sequences.invoke({}))).toEqual({ stopped: [], message: 'no sequence is running' });
  });

  it('stops by id only the user\'s own sequence, listing what runs otherwise', async () => {
    const svc = new SequencesService(DEFAULT_LIMITS);
    const l = tool('light');
    const mine = byName(svc.buildTools('u1', 'c1', [l]));
    const theirs = byName(svc.buildTools('u2', 'c2', [l]));
    const a = JSON.parse(await mine.run_sequence.invoke({ title: 'Mine', steps: [{ repeat: { forSeconds: 30, steps: [call('light'), wait(1)] } }] }));
    const out = JSON.parse(await theirs.stop_sequences.invoke({ sequenceId: a.sequenceId }));
    expect(out).toEqual({ stopped: [], message: 'no sequence is running' });
    expect(svc.list('u1')).toHaveLength(1);
    svc.stop('u1');
    await vi.advanceTimersByTimeAsync(10);
  });
});

describe('sequence pushes and end line', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0); });
  afterEach(() => { vi.useRealTimers(); });

  function make(chatOwner = 'u1', language: string | null = 'it') {
    const gateway = { emitToWatchers: vi.fn() };
    const saved: any[] = [];
    const messages = { create: (m: any) => m, save: vi.fn(async (m: any) => { saved.push(m); return { ...m, id: 'm1' }; }) };
    const chats = { findOne: vi.fn(async () => ({ id: 'c1', userId: chatOwner })), update: vi.fn(async () => undefined) };
    const users = { findOne: vi.fn(async () => ({ id: 'u1', language })) };
    const svc = new SequencesService(DEFAULT_LIMITS, gateway as any, messages as any, chats as any, users as any);
    const events = () => gateway.emitToWatchers.mock.calls.map((c) => c[3]);
    return { svc, gateway, saved, events };
  }

  it('pushes the state to the chat\'s watchers (throttled) and, at the end, writes one line and asks to reload', async () => {
    const { svc, saved, events, gateway } = make();
    const l = tool('light');
    svc.start({ title: 'Luci', steps: [{ repeat: { count: 4, steps: [call('light'), wait(0.5)] } }] }, { userId: 'u1', chatId: 'c1', tools: [l] });
    await vi.advanceTimersByTimeAsync(3000);
    expect(gateway.emitToWatchers.mock.calls.every((c) => c[0] === 'chat' && c[1] === 'c1' && c[2] === 'sequence')).toBe(true);
    const ev = events();
    expect(ev[0].sequence).toMatchObject({ kind: 'sequence', title: 'Luci', progress: { calls: 0 } });
    // start + progress at most once a second over ~2 s + end
    expect(ev.length).toBeLessThanOrEqual(5);
    expect(ev.at(-1)).toEqual({ chatId: 'c1', sequenceId: ev[0].sequenceId, sequence: null, messageId: 'm1' });
    expect(saved).toEqual([{ chatId: 'c1', role: 'assistant', content: expect.stringMatching(/^🔁 «Luci» completata — 4 azioni in 2 s$/) }]);
  });

  it('says why it failed, in English for an English user, and writes nothing in another user\'s chat', async () => {
    const en = make('u1', 'en');
    const dead = tool('dead', () => '{"error":"device unavailable"}');
    en.svc.start({ title: 'Blink', steps: [{ repeat: { count: 5, steps: [call('dead'), wait(1)] } }] }, { userId: 'u1', chatId: 'c1', tools: [dead] });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(en.saved[0].content).toMatch(/^🔁 «Blink» stopped by an error — 3 actions \(3 failed\) in 2 s\n\ndead failed 3 times in a row$/);

    const other = make('someone-else');
    other.svc.start({ title: 'X', steps: [call('light')] }, { userId: 'u1', chatId: 'c1', tools: [tool('light')] });
    await vi.advanceTimersByTimeAsync(10);
    expect(other.saved).toEqual([]);
    expect(other.events().at(-1)).toMatchObject({ sequence: null, messageId: null });
  });
});

describe('sequence carrying out a procedure of the memory', () => {
  const report = vi.fn(async () => ({ id: 'run-1', pending: false }));
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(T0);
    report.mockClear();
    vi.spyOn(recordareConfigModule, 'recordareClient').mockReturnValue({ reportProcedureRun: report } as any);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  function make(episodicMemoryEnabled = true) {
    const users = { findOne: vi.fn(async () => ({ id: 'u1', language: 'en', episodicMemoryEnabled })) };
    return new SequencesService(DEFAULT_LIMITS, null, null, null, users as any);
  }

  it('maps the outcome: completed → done, failures / failed / timeout → failed with why, stopped → stopped', () => {
    const base = { calls: 4, failures: 0, elapsedMs: 2000, errors: [] as string[] };
    expect(sequenceProcedureRun({ ...base, status: 'completed' }, { id: 'p1' })).toEqual({ outcome: 'done' });
    expect(sequenceProcedureRun({ ...base, status: 'completed' }, { id: 'p1', step: 3 })).toEqual({ outcome: 'done', step: 3 });
    expect(sequenceProcedureRun({ ...base, status: 'completed', failures: 1, errors: ['move refused'] }, { id: 'p1', step: 2 }))
      .toEqual({ outcome: 'failed', step: 2, note: '1 of 4 calls failed; move refused' });
    expect(sequenceProcedureRun({ ...base, status: 'failed', errors: ['device unavailable'] }, { id: 'p1' }))
      .toEqual({ outcome: 'failed', note: 'device unavailable' });
    expect(sequenceProcedureRun({ ...base, status: 'timeout' }, { id: 'p1' })).toEqual({ outcome: 'failed', note: 'time limit reached' });
    expect(sequenceProcedureRun({ ...base, status: 'stopped' }, { id: 'p1', step: 2 }))
      .toEqual({ outcome: 'stopped', step: 2, note: 'stopped before the end, after 4 actions' });
  });

  it('accepts a procedure in the program and refuses a malformed one', () => {
    expect(checkProgram({ steps: [call('light')], procedure: { id: 'p1', step: 2 } }, ['light']).ok).toBe(true);
    expect(checkProgram({ steps: [call('light')], procedure: { id: '', step: 0 } }, ['light']).ok).toBe(false);
  });

  it('reports the run to the memory when it ends, in the chat it came from', async () => {
    const svc = make();
    svc.start({ title: 'Task', steps: [call('light')], procedure: { id: 'p1', step: 4 } }, { userId: 'u1', chatId: 'c1', tools: [tool('light')] });
    await vi.advanceTimersByTimeAsync(10);
    expect(report).toHaveBeenCalledWith('u1', 'p1', { outcome: 'done', step: 4, conversation: { externalId: 'c1' } });
  });

  it('reports a failure with what went wrong (the note bounded)', async () => {
    const svc = make();
    const dead = tool('dead', () => `{"error":"${'x'.repeat(2000)}"}`);
    svc.start({ steps: [call('dead')], stopOnError: true, procedure: { id: 'p1' } }, { userId: 'u1', chatId: 'c1', tools: [dead] });
    await vi.advanceTimersByTimeAsync(10);
    const [, , run] = report.mock.calls[0] as any[];
    expect(run.outcome).toBe('failed');
    expect(run.note.length).toBeLessThanOrEqual(PROCEDURE_NOTE_MAX);
  });

  it('reports nothing without a procedure, or when the user\'s memory is not Recordare', async () => {
    make().start({ steps: [call('light')] }, { userId: 'u1', chatId: 'c1', tools: [tool('light')] });
    make(false).start({ steps: [call('light')], procedure: { id: 'p1' } }, { userId: 'u1', chatId: 'c1', tools: [tool('light')] });
    await vi.advanceTimersByTimeAsync(10);
    expect(report).not.toHaveBeenCalled();
  });

  it('a sequence the user stops reports the procedure stopped, at its step', async () => {
    const svc = make();
    const r = svc.start({ key: 'k', steps: [{ repeat: { forSeconds: 30, steps: [call('light'), wait(1)] } }], procedure: { id: 'p1', step: 4 } },
      { userId: 'u1', chatId: 'c1', tools: [tool('light')] });
    await vi.advanceTimersByTimeAsync(1500);
    if (r.ok) svc.stop('u1', r.sequenceId);
    await vi.advanceTimersByTimeAsync(100);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][1]).toBe('p1');
    expect(report.mock.calls[0][2]).toMatchObject({ outcome: 'stopped', step: 4 });
  });

  it('a Recordare error never breaks the sequence', async () => {
    report.mockRejectedValueOnce(new Error('down'));
    const svc = make();
    const r = svc.start({ steps: [call('light')], procedure: { id: 'p1' } }, { userId: 'u1', chatId: null, tools: [tool('light')] });
    await vi.advanceTimersByTimeAsync(10);
    expect(r.ok).toBe(true);
    expect(report).toHaveBeenCalledTimes(1);
    expect(svc.list('u1')).toEqual([]);
  });
});
