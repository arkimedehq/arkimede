// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file llm-dispatcher.service.ts
 *
 * In-memory LLM request scheduler (P1 of LLM_SERVING_PLAN.md). One queue per
 * llm_config, gating ONLY configs with `maxConcurrency` set (null = unlimited
 * pass-through: cloud providers handle high concurrency natively; the limit
 * matters on finite capacity, i.e. self-hosted models).
 *
 * Deliberately in-memory (decision validated with the owner): an LLM call is a
 * synchronous step inside an already-live caller (SSE request, BullMQ job, flow
 * run) — if the process dies the caller dies with it, so a persistent queue
 * buys nothing and would break streaming/AbortSignal. Constraint: per-instance
 * scheduling (the backend is single-instance today); if that changes, move the
 * COUNTER to Redis and keep the queues local — the callers never see the swap.
 *
 * INTERCEPTION (the hard-won part — see the probes in the P1 commit message):
 * LangGraph's createReactAgent calls `bindTools`, which CLONES the model —
 * instance patches, instance/constructor callbacks, tags, metadata and even
 * lc_kwargs stamps are all LOST on the clone. Callback-based gating is also
 * out: start callbacks are consumed in the background by default (they fire,
 * but do not block the call). What DOES survive is the prototype chain and the
 * functional fields the clone needs to make the call (provider class, model
 * name, base URL). So: one idempotent patch on BaseChatModel.prototype
 * invoke/stream + a registry keyed by those functional fields, populated by
 * buildModelForConfig. Unregistered models pass through untouched.
 *
 * The measured wait is exposed to the metrics layer via the call context
 * (AsyncLocalStorage → llm_calls.queuedMs): the prototype gate runs in the
 * caller's async chain, so the context flows into the model callbacks.
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { runWithLlmCallContext, getLlmCallContext, LlmPriority } from './llm-call-context';

interface Waiter {
  start: () => void;
  enqueuedAt: number;
  priority: LlmPriority;
  /** Fairness unit (round-robin within the same class). 'anon' when unknown. */
  userId: string;
}

interface ConfigQueue {
  active: number;
  waiting: Waiter[];
  /** Cap declared at the last schedule() — exposed by stats(). */
  max?: number;
  /** Round-robin bookkeeping: userId → sequence of the last slot granted. */
  rr: Map<string, number>;
  rrSeq: number;
}

interface RegistryEntry {
  llmConfigId: string;
  maxConcurrency: number;
}

/** Rank for dequeue order (P1-F2 wires callers to set the class). */
const PRIORITY_RANK: Record<LlmPriority, number> = { interactive: 0, background: 1, batch: 2 };

/** Anti-starvation aging: a waiter is promoted one class per this much wait. */
const AGING_MS_DEFAULT = 60_000;

@Injectable()
export class LlmDispatcherService implements OnModuleInit {
  private readonly logger = new Logger(LlmDispatcherService.name);
  private readonly queues = new Map<string, ConfigQueue>();
  private readonly registry = new Map<string, RegistryEntry>();

  /** The prototype gate needs the app's singleton (tests: last constructed wins). */
  private static current: LlmDispatcherService | null = null;

  constructor() { LlmDispatcherService.current = this; }

  onModuleInit(): void { LlmDispatcherService.installGate(); }

  /**
   * Functional identity of a model instance — the ONLY thing that survives the
   * bindTools clone. Two configs pointing at the same provider+model+endpoint
   * collapse into one queue (they contend for the same physical capacity anyway).
   */
  private static modelKey(m: any): string {
    const cls  = m?.constructor?.name ?? '?';
    const name = m?.model ?? m?.modelName ?? '';
    const base = m?.clientConfig?.baseURL ?? m?.configuration?.baseURL
              ?? m?.clientOptions?.baseURL ?? m?.baseUrl ?? '';
    return `${cls}|${name}|${base}`;
  }

  /**
   * Declares the concurrency policy for the config a model was built from.
   * Called by buildModelForConfig on every build; maxConcurrency null removes
   * the gate (pass-through).
   */
  register(model: BaseChatModel, opts: { llmConfigId: string; maxConcurrency: number | null }): void {
    LlmDispatcherService.installGate();
    const key = LlmDispatcherService.modelKey(model);
    if (!opts.maxConcurrency || opts.maxConcurrency < 1) {
      this.registry.delete(key);
      return;
    }
    this.registry.set(key, { llmConfigId: opts.llmConfigId, maxConcurrency: opts.maxConcurrency });
    this.logger.log(`Gate registered: ${key} → maxConcurrency=${opts.maxConcurrency}`);
  }

  /** Live queue snapshot (P1-F4 telemetry). */
  stats(): Record<string, { active: number; waiting: number; max: number | null }> {
    const out: Record<string, { active: number; waiting: number; max: number | null }> = {};
    for (const [key, q] of this.queues) out[key] = { active: q.active, waiting: q.waiting.length, max: q.max ?? null };
    return out;
  }

  // ── Prototype gate ──────────────────────────────────────────────────────────

  /** Idempotent: shadows invoke/stream on BaseChatModel.prototype (clones inherit it). */
  private static installGate(): void {
    const proto = BaseChatModel.prototype as any;
    if (proto.__arkimedeGateInstalled) return;
    proto.__arkimedeGateInstalled = true;

    const origInvoke = proto.invoke;  // inherited impl (walks the proto chain)
    proto.invoke = function (...args: unknown[]) {
      const d = LlmDispatcherService.current;
      const entry = d?.registry.get(LlmDispatcherService.modelKey(this));
      if (!d || !entry) return origInvoke.apply(this, args);
      return d.schedule(entry.llmConfigId, entry.maxConcurrency, () => origInvoke.apply(this, args));
    };

    const origStream = proto.stream;
    proto.stream = function (...args: unknown[]) {
      const d = LlmDispatcherService.current;
      const entry = d?.registry.get(LlmDispatcherService.modelKey(this));
      if (!d || !entry) return origStream.apply(this, args);
      // The slot must be held until the iterator completes, not just until the
      // stream object is created.
      return d.schedule(entry.llmConfigId, entry.maxConcurrency, async () => {
        const inner = await origStream.apply(this, args);
        return d.holdSlotUntilDone(inner as AsyncIterable<unknown>);
      }, /* releaseOnSettle */ false);
    };
  }

  // ── Scheduling core ─────────────────────────────────────────────────────────

  /**
   * Runs `fn` respecting the per-config concurrency cap. FIFO within the same
   * priority class; higher classes dequeue first. The measured wait is exposed
   * via the call context (→ llm_calls.queuedMs).
   *
   * `releaseOnSettle=false` hands slot release to the returned iterator wrapper
   * (streaming), which owns the release.
   */
  /** Test hook: shrink to exercise the anti-starvation promotion quickly. */
  agingMs = AGING_MS_DEFAULT;

  /**
   * Dequeue policy (P1-F3): effective class first (a waiter is promoted one
   * class per `agingMs` of wait, so batch can never starve), then round-robin
   * across users within the class (least-recently-served user wins — one chatty
   * user cannot monopolize a gated config), then FIFO.
   */
  private pickNext(q: ConfigQueue): Waiter | undefined {
    if (q.waiting.length === 0) return undefined;
    const now = Date.now();
    let bestIdx = 0;
    let best: [number, number, number] | null = null; // [effRank, lastServed, enqueuedAt]
    for (let i = 0; i < q.waiting.length; i++) {
      const w = q.waiting[i];
      const promoted = Math.floor((now - w.enqueuedAt) / this.agingMs);
      const effRank  = Math.max(0, PRIORITY_RANK[w.priority] - promoted);
      const score: [number, number, number] = [effRank, q.rr.get(w.userId) ?? 0, w.enqueuedAt];
      if (!best || score[0] < best[0] || (score[0] === best[0] && (score[1] < best[1] || (score[1] === best[1] && score[2] < best[2])))) {
        best = score; bestIdx = i;
      }
    }
    return q.waiting.splice(bestIdx, 1)[0];
  }

  private grant(q: ConfigQueue, userId: string): void {
    q.rr.set(userId, ++q.rrSeq);
  }

  private async schedule<T>(key: string, max: number, fn: () => Promise<T>, releaseOnSettle = true): Promise<T> {
    const q: ConfigQueue = this.queues.get(key) ?? { active: 0, waiting: [], rr: new Map(), rrSeq: 0 };
    this.queues.set(key, q);
    q.max = max;

    const ctx = getLlmCallContext();
    const priority = ctx.priority ?? 'background';
    const userId   = ctx.userId ?? 'anon';
    const enqueuedAt = Date.now();

    if (q.active >= max) {
      this.logger.debug(`Queue ${key}: ${q.active} active ≥ ${max}, waiting (${priority}, ${userId})`);
      await new Promise<void>((resolve) => {
        q.waiting.push({ start: resolve, enqueuedAt, priority, userId });
      });
    }

    q.active++;
    this.grant(q, userId);
    const queuedMs = Date.now() - enqueuedAt;
    const release = () => {
      q.active--;
      this.pickNext(q)?.start();
      // Idle queue: drop the round-robin bookkeeping (ephemeral users).
      if (q.active === 0 && q.waiting.length === 0) { q.rr.clear(); q.rrSeq = 0; }
    };

    try {
      const result = await runWithLlmCallContext({ priority, queuedMs }, fn);
      if (!releaseOnSettle) {
        (result as any).__release = release;
        return result;
      }
      release();
      return result;
    } catch (err) {
      release();
      throw err;
    }
  }

  /** Wraps an async iterable so the queue slot is released when it completes. */
  private holdSlotUntilDone<T extends AsyncIterable<unknown>>(inner: T): T {
    const self: any = {
      __release: undefined as undefined | (() => void),
      [Symbol.asyncIterator]: () => {
        const it = inner[Symbol.asyncIterator]();
        const done = () => { self.__release?.(); self.__release = undefined; };
        return {
          next: async () => {
            try {
              const r = await it.next();
              if (r.done) done();
              return r;
            } catch (err) { done(); throw err; }
          },
          return: async (v?: unknown) => { done(); return it.return ? it.return(v) : { done: true, value: v }; },
          throw:  async (e?: unknown) => { done(); return it.throw ? it.throw(e) : Promise.reject(e); },
        };
      },
    };
    return self as T;
  }
}
