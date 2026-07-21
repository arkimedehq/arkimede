/**
 * @file llm-call-context.ts
 *
 * Per-call context for LLM invocations, carried via AsyncLocalStorage.
 * Models are CACHED and shared across callers, so anything per-call
 * (scheduling class, attribution, measured queue time) cannot live on the
 * model instance: callers set it around the call, the dispatcher enriches
 * it, and the metrics callback reads it within the same async chain.
 */
import { AsyncLocalStorage } from 'async_hooks';

export type LlmPriority = 'interactive' | 'background' | 'batch';

export interface LlmCallContext {
  /** Scheduling class (P1-F2: set by the callers; default 'background'). */
  priority?: LlmPriority;
  /** Time spent waiting in the dispatcher queue (set by the dispatcher). */
  queuedMs?: number;
  /** Attribution, when the caller knows it. */
  userId?: string;
  origin?: 'chat' | 'automation' | 'flow' | 'team' | 'system';
}

const als = new AsyncLocalStorage<LlmCallContext>();

/** Runs `fn` with `ctx` merged over the current context (if any). */
export function runWithLlmCallContext<T>(ctx: LlmCallContext, fn: () => T): T {
  return als.run({ ...als.getStore(), ...ctx }, fn);
}

/** Current call context, or {} outside any. */
export function getLlmCallContext(): LlmCallContext {
  return als.getStore() ?? {};
}
