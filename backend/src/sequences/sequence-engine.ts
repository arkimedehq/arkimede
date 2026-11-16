// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Runs a checked sequence program (sequence-program.ts): waits with jitter, repeats, parallel branches, random choices,
 * then `finally` — also when stopped, failed or out of time. No model in the loop: each call is the tool itself, the
 * same instance the agent has in the turn (same user, same authorization).
 *
 * A failed call (thrown, or a result saying it failed — see actionSucceeded) is recorded and the sequence goes on,
 * unless the program asks to stop on error; the same call failing three times in a row stops it (a device gone).
 *
 * Waits keep a cadence: a wait ends SECONDS after the previous wait ended (the beat), not after the calls before it
 * returned, so the time the calls take is absorbed and "every 2 s for 10 s" lasts 10 s. When the calls take longer than
 * the wait, it does not wait and the beat restarts from now (no burst to catch up).
 */
import { actionSucceeded } from '../agent/action-replies';
import type { SequenceLimits, SequenceProgram, SequenceStep } from './sequence-program';

/** What the engine needs of a tool (a LangChain tool fits). */
export interface SequenceTool {
  name: string;
  invoke(input: Record<string, unknown>, config?: { signal?: AbortSignal }): Promise<unknown>;
}

export type SequenceStatus = 'completed' | 'stopped' | 'failed' | 'timeout';

export interface SequenceProgress {
  calls: number;
  failures: number;
  elapsedMs: number;
}

export interface SequenceOutcome extends SequenceProgress {
  status: SequenceStatus;
  /** Why it failed or stopped early, and the last call errors (short, for a chat line or a log). */
  errors: string[];
}

export interface EngineOptions {
  tools: Map<string, SequenceTool>;
  limits: SequenceLimits;
  /** Stopping the sequence (the user, a replacing sequence): the steps end, finally runs. */
  signal: AbortSignal;
  onProgress?: (p: SequenceProgress) => void;
  random?: () => number;
  now?: () => number;
}

/** Consecutive failures of the same call that stop a sequence. */
export const MAX_CONSECUTIVE_FAILURES = 3;
/** Extra time over the limit before a running sequence is cut (calls take time too). */
export const DEADLINE_GRACE_MS = 60_000;
const ERRORS_KEPT = 5;

/** When the last wait was due to end: the next wait counts from here. */
interface Beat { at: number }

class Halt extends Error {
  constructor(readonly status: Exclude<SequenceStatus, 'completed'>, reason?: string) { super(reason ?? status); }
}

/** Resolves after MS, or rejects with Halt as soon as SIGNAL aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function short(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export async function runSequence(program: SequenceProgram, opts: EngineOptions): Promise<SequenceOutcome> {
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  const started = now();
  const progress: SequenceProgress = { calls: 0, failures: 0, elapsedMs: 0 };
  const errors: string[] = [];
  const streak = new Map<object, number>();

  const note = (e: string) => { errors.push(short(e)); if (errors.length > ERRORS_KEPT) errors.shift(); };
  const report = () => { progress.elapsedMs = now() - started; opts.onProgress?.({ ...progress }); };

  const call = async (step: Extract<SequenceStep, { call: unknown }>, signal: AbortSignal, budget: { calls: number }) => {
    if (signal.aborted) throw signal.reason;
    if (budget.calls <= 0) throw new Halt('failed', `more than ${opts.limits.maxCalls} calls`);
    budget.calls -= 1;
    const { tool: name, args = {} } = step.call;
    const tool = opts.tools.get(name);
    let ok = false;
    let error = '';
    if (!tool) {
      error = `${name}: no longer available`;
    } else {
      try {
        const result: any = await tool.invoke(args, { signal });
        const content = result && typeof result === 'object' && 'content' in result ? result.content : result;
        ok = actionSucceeded(content, result?.status);
        if (!ok) error = `${name}: ${short(typeof content === 'string' ? content : JSON.stringify(content))}`;
      } catch (e: any) {
        if (signal.aborted) throw signal.reason;
        error = `${name}: ${e?.message ?? String(e)}`;
      }
    }
    progress.calls += 1;
    if (ok) {
      streak.delete(step);
    } else {
      progress.failures += 1;
      note(error);
      const n = (streak.get(step) ?? 0) + 1;
      streak.set(step, n);
      if (program.stopOnError) { report(); throw new Halt('failed', error); }
      if (n >= MAX_CONSECUTIVE_FAILURES) { report(); throw new Halt('failed', `${name} failed ${n} times in a row`); }
    }
    report();
  };

  const runSteps = async (steps: SequenceStep[], signal: AbortSignal, budget: { calls: number }, beat: Beat): Promise<void> => {
    for (const step of steps) await runStep(step, signal, budget, beat);
  };

  const runStep = async (step: SequenceStep, signal: AbortSignal, budget: { calls: number }, beat: Beat): Promise<void> => {
    if (signal.aborted) throw signal.reason;
    if ('call' in step) return call(step, signal, budget);
    if ('wait' in step) {
      const { seconds, jitterSeconds = 0 } = step.wait;
      const s = Math.max(opts.limits.minWaitSeconds, seconds + (random() * 2 - 1) * jitterSeconds);
      const due = beat.at + Math.round(s * 1000);
      const t = now();
      beat.at = due >= t ? due : t;
      if (due <= t) return;
      return sleep(due - t, signal);
    }
    if ('repeat' in step) {
      const { count, forSeconds, steps } = step.repeat;
      if (count !== undefined) {
        for (let i = 0; i < count; i++) await runSteps(steps, signal, budget, beat);
        return;
      }
      const until = now() + forSeconds! * 1000;
      while (now() < until) await runSteps(steps, signal, budget, beat);
      return;
    }
    if ('parallel' in step) {
      // A failing branch stops its siblings: they share an inner signal. Each branch keeps its own beat from the same
      // start; after them the beat is the latest one (a branch without waits leaves it where it was).
      const inner = new AbortController();
      const onAbort = () => inner.abort(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      const beats = step.parallel.map(() => ({ at: beat.at }));
      try {
        await Promise.all(step.parallel.map((s, i) => runStep(s, inner.signal, budget, beats[i]).catch((e) => {
          inner.abort(e);
          throw e;
        })));
      } catch (e) {
        throw signal.aborted ? signal.reason : e;
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
      beat.at = Math.max(...beats.map((b) => b.at));
      return;
    }
    const options = step.choose.random;
    return runStep(options[Math.min(options.length - 1, Math.floor(random() * options.length))], signal, budget, beat);
  };

  /** Runs STEPS until done, OUTER aborts, or MS pass; the reason it ended. */
  const bounded = async (steps: SequenceStep[], outer: AbortSignal | null, ms: number, budget: { calls: number }) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new Halt('timeout', 'time limit reached')), ms);
    const onAbort = () => ctl.abort(new Halt('stopped', 'stopped'));
    if (outer?.aborted) onAbort();
    outer?.addEventListener('abort', onAbort, { once: true });
    try {
      await runSteps(steps, ctl.signal, budget, { at: now() });
      return null;
    } catch (e) {
      return e instanceof Halt ? e : new Halt('failed', (e as any)?.message ?? String(e));
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onAbort);
    }
  };

  const budget = { calls: opts.limits.maxCalls };
  const halt = await bounded(program.steps, opts.signal, opts.limits.maxSeconds * 1000 + DEADLINE_GRACE_MS, budget);
  if (halt && halt.status !== 'stopped') note(halt.message);

  if (program.finally?.length) {
    // finally runs even after a stop, with its own short time limit (a second stop is not possible: the run has ended).
    const end = await bounded(program.finally, null, opts.limits.finallySeconds * 1000, budget);
    if (end) note(`finally: ${end.message}`);
  }

  progress.elapsedMs = now() - started;
  return { ...progress, status: halt?.status ?? 'completed', errors };
}
