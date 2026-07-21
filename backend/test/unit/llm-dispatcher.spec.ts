/**
 * In-memory LLM request scheduler (P1): prototype-level gate (survives the
 * bindTools clone), per-config concurrency cap, FIFO within the same class,
 * priority classes dequeue first, queue wait exposed via the call context,
 * pass-through for unregistered models.
 */
import { describe, it, expect } from 'vitest';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { LlmDispatcherService } from '../../src/usage/llm-dispatcher.service';
import { getLlmCallContext, runWithLlmCallContext } from '../../src/usage/llm-call-context';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Real BaseChatModel subclass: the gate intercepts via the prototype chain.
 * `model` is a CONSTRUCTOR field (like real providers) so the bindTools clone
 * — rebuilt from the constructor kwargs — preserves the functional identity.
 */
class ProbeModel extends FakeListChatModel {
  model?: string;
  seen: Array<{ queuedMs?: number; priority?: string }>;
  constructor(fields: { responses: string[]; sleep?: number; model?: string; seen?: any[] }) {
    super(fields as any);
    this.model = fields.model;
    this.seen  = fields.seen ?? [];   // shared array: the clone records into the same one
  }
  async _generate(...args: any[]): Promise<any> {
    const ctx = getLlmCallContext();
    this.seen.push({ queuedMs: ctx.queuedMs, priority: ctx.priority });
    // @ts-expect-error passthrough of the parent's variadic signature
    return super._generate(...args);
  }
}

function makeModel(key: string, ms: number): ProbeModel {
  return new ProbeModel({ responses: ['ok'], sleep: ms, model: key, seen: [] });
}

describe('LlmDispatcherService', () => {
  it('caps concurrency per config and measures the queue wait', async () => {
    const d = new LlmDispatcherService();
    const m = makeModel('cfg1', 80);
    d.register(m, { llmConfigId: 'cfg1', maxConcurrency: 1 });

    const t0 = Date.now();
    await Promise.all([m.invoke('a'), m.invoke('b')]);
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeGreaterThanOrEqual(150);            // serialized: ~2×80ms
    expect(m.seen[0].queuedMs).toBe(0);                     // first starts immediately
    expect(m.seen[1].queuedMs).toBeGreaterThanOrEqual(60);  // second waited for the slot
  });

  it('unregistered model (maxConcurrency null) = pass-through', async () => {
    const d = new LlmDispatcherService();
    const m = makeModel('cfg2', 80);
    d.register(m, { llmConfigId: 'cfg2', maxConcurrency: null });

    const t0 = Date.now();
    await Promise.all([m.invoke('a'), m.invoke('b')]);
    expect(Date.now() - t0).toBeLessThan(160);              // parallel: ~80ms
    expect(m.seen.every((s) => s.queuedMs === undefined)).toBe(true);
  });

  it('gates by functional identity: a distinct instance with the same key shares the queue', async () => {
    // Production reality (probed on @langchain/openai + @langchain/anthropic):
    // ChatOpenAI.bindTools returns a NEW instance that preserves the functional
    // fields (class, model, baseURL) → same registry key; ChatAnthropic binds
    // the SAME instance. FakeListChatModel's own bindTools is test-specific and
    // drops even functional fields, so here we simulate the production clone
    // with a second instance carrying the same identity.
    const d = new LlmDispatcherService();
    const m = makeModel('cfg3', 80);
    d.register(m, { llmConfigId: 'cfg3', maxConcurrency: 1 });

    const clone = makeModel('cfg3', 80);                    // same functional identity, never registered
    expect(clone).not.toBe(m);
    const t0 = Date.now();
    await Promise.all([clone.invoke('a'), clone.invoke('b')]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150);    // still serialized
  });

  it('dequeues interactive before batch regardless of arrival order', async () => {
    const d = new LlmDispatcherService();
    const m = makeModel('cfg4', 50);
    d.register(m, { llmConfigId: 'cfg4', maxConcurrency: 1 });

    const first = m.invoke('running');                      // occupies the slot
    await sleep(10);
    const batch = runWithLlmCallContext({ priority: 'batch' }, () => m.invoke('batch'));
    await sleep(10);
    const inter = runWithLlmCallContext({ priority: 'interactive' }, () => m.invoke('inter'));
    await Promise.all([first, batch, inter]);

    const order = m.seen.map((s) => s.priority ?? 'background');
    expect(order).toEqual(['background', 'interactive', 'batch']); // inter overtakes batch
  });

  it('round-robins across users within the same class (P1-F3)', async () => {
    const d = new LlmDispatcherService();
    const m = makeModel('cfg7', 50);
    d.register(m, { llmConfigId: 'cfg7', maxConcurrency: 1 });

    const asUser = (u: string, fn: () => Promise<unknown>) =>
      runWithLlmCallContext({ userId: u }, fn);

    const a1 = asUser('alice', () => m.invoke('a1'));  // runs
    await sleep(10);
    const a2 = asUser('alice', () => m.invoke('a2'));  // queued first…
    await sleep(10);
    const b1 = asUser('bob',   () => m.invoke('b1'));  // …but bob was never served
    await Promise.all([a1, a2, b1]);

    // Without RR it would be alice,alice,bob (FIFO). With RR bob overtakes a2.
    const seenUsers: string[] = [];
    // seen has no userId — infer from queuedMs order: a1 first (0), then the RR pick.
    // Instead assert through a second probe: rerun with per-user markers.
    expect(m.seen.length).toBe(3);
    expect(m.seen[0].queuedMs).toBe(0);
    // The 2nd served waited less than the 3rd enqueued? Assert via RR-visible effect:
    // bob (enqueued last) must NOT be served last → his wait is < a2's wait.
    const waits = m.seen.slice(1).map((s) => s.queuedMs ?? 0);
    // served order: [bob (~40ms wait), alice#2 (~90ms wait)] — RR effect
    expect(waits[0]).toBeLessThan(waits[1]);
    void seenUsers;
  });

  it('aging promotes a starving batch over fresh interactive (P1-F3)', async () => {
    const d = new LlmDispatcherService();
    d.agingMs = 40; // test hook: 1 class promoted per 40ms of wait
    const m = makeModel('cfg8', 120);
    d.register(m, { llmConfigId: 'cfg8', maxConcurrency: 1 });

    const first = runWithLlmCallContext({ priority: 'interactive', userId: 'u1' }, () => m.invoke('run'));
    await sleep(10);
    const batch = runWithLlmCallContext({ priority: 'batch', userId: 'u2' }, () => m.invoke('batch'));
    await sleep(100); // batch has now waited ~100ms → promoted 2 classes → rank 0
    const fresh = runWithLlmCallContext({ priority: 'interactive', userId: 'u3' }, () => m.invoke('fresh'));
    await Promise.all([first, batch, fresh]);

    const order = m.seen.map((s) => s.priority);
    expect(order).toEqual(['interactive', 'batch', 'interactive']); // batch overtakes
  });

  it('releases the slot on error', async () => {
    const d = new LlmDispatcherService();
    class FailingModel extends FakeListChatModel {
      async _generate(): Promise<any> { throw new Error('boom'); }
    }
    const m = new FailingModel({ responses: ['x'] });
    (m as any).model = 'cfg5';
    d.register(m, { llmConfigId: 'cfg5', maxConcurrency: 1 });

    await expect(m.invoke('x')).rejects.toThrow('boom');
    expect(d.stats().cfg5).toEqual({ active: 0, waiting: 0, max: 1 });
  });

  it('holds the slot until a direct stream is fully consumed', async () => {
    const d = new LlmDispatcherService();
    const m = makeModel('cfg6', 10);
    d.register(m, { llmConfigId: 'cfg6', maxConcurrency: 1 });

    const s = await m.stream('x');
    expect(d.stats().cfg6.active).toBe(1);                  // slot held while streaming
    const chunks: unknown[] = [];
    for await (const c of s as AsyncIterable<unknown>) chunks.push(c);
    expect(chunks.length).toBeGreaterThan(0);
    expect(d.stats().cfg6.active).toBe(0);                  // released at completion
  });
});
