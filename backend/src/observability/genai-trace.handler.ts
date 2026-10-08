// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file genai-trace.handler.ts
 *
 * LangChain callback handler → OpenTelemetry spans, following the GenAI semantic
 * conventions (`gen_ai.*`): `chat {model}` for LLM / chat-model runs and
 * `execute_tool {tool}` for tool runs. Chain runs (graph nodes) produce no span:
 * they only carry the parent context down, so LLM and tool spans nest under the
 * nearest span ancestor (or under the `invoke_agent` span opened by withAgentSpan).
 *
 * METADATA ONLY (hard rule): names, models, providers, token counts, durations,
 * status and ids. Prompts, messages, system instructions, completions, tool
 * arguments and tool results are never put on a span — not even behind a flag.
 *
 * Safety: every callback body is wrapped in try/catch (a tracing bug must never
 * reach the LLM call), nothing here does I/O (the BatchSpanProcessor exports in
 * the background). The handler is awaited (`awaitHandlers = true`): its work is
 * synchronous and tiny, and running in the caller's async chain is what makes
 * the OTel active context (invoke_agent span) and the LLM call context (user id)
 * readable for root runs; LangChain's background queue would lose both.
 */
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { Serialized } from '@langchain/core/load/serializable';
import type { LLMResult } from '@langchain/core/outputs';
import {
  Attributes, Context, Span, SpanKind, SpanStatusCode, Tracer, context, createContextKey, trace,
} from '@opentelemetry/api';
import { getLlmCallContext } from '../usage/llm-call-context';

/** OTel context key carrying the Arkimede user id down the span tree. */
export const USER_ID_KEY = createContextKey('arkimede.user_id');
/** OTel context key carrying the user's Recordare owner id down the span tree. */
export const OWNER_ID_KEY = createContextKey('recordare.owner_id');

/**
 * Arkimede user id → Recordare owner id, when known. Synchronous and cached
 * (RecordareIdentityService registers it when Recordare is configured); it must
 * never wait on the network. null = no Recordare integration.
 */
let ownerResolver: ((userId: string) => string | undefined) | null = null;

export function setRecordareOwnerResolver(fn: ((userId: string) => string | undefined) | null): void {
  ownerResolver = fn;
}

/** Recordare owner id of a user, or undefined (unknown / no integration). Never throws. */
export function recordareOwnerOf(userId: unknown): string | undefined {
  if (typeof userId !== 'string' || !ownerResolver) return undefined;
  try { return ownerResolver(userId) || undefined; } catch { return undefined; }
}

/** Adds the user (and their Recordare owner id, when known) to a context. */
export function withUserContext(ctx: Context, userId: string): Context {
  let out = ctx.setValue(USER_ID_KEY, userId);
  const ownerId = recordareOwnerOf(userId);
  if (ownerId) out = out.setValue(OWNER_ID_KEY, ownerId);
  return out;
}

/** Entries older than this are dropped (runs whose end event never came, e.g. an interrupted stream). */
const ENTRY_TTL_MS = 60 * 60 * 1_000;
const SWEEP_EVERY_MS = 60 * 1_000;

// ── Provider name (gen_ai.provider.name) ──────────────────────────────────────

/** Arkimede llm_configs provider → semconv provider name (undefined = unknown, omitted). */
export function semconvProviderName(provider: string | null | undefined): string | undefined {
  switch (provider) {
    case 'openai':    return 'openai';
    case 'anthropic': return 'anthropic';
    case 'gemini':    return 'gcp.gemini';
    case 'deepseek':  return 'deepseek';
    case 'ollama':    return 'ollama';
    case 'lmstudio':  return 'lmstudio';
    default:          return undefined; // openai-compatible & co.: the real backend is unknown
  }
}

/** LangChain `ls_provider` metadata → semconv (fallback when the model is not registered). */
function providerFromLs(ls: unknown): string | undefined {
  switch (ls) {
    case 'anthropic':    return 'anthropic';
    case 'google_genai': return 'gcp.gemini';
    case 'ollama':       return 'ollama';
    case 'deepseek':     return 'deepseek';
    // 'openai' is NOT trusted: ChatOpenAI also serves DeepSeek, LM Studio and
    // OpenAI-compatible endpoints, so the class alone does not name the provider.
    default:             return undefined;
  }
}

// ── Handler ──────────────────────────────────────────────────────────────────

interface RunEntry {
  /** Span of this run (LLM / tool); absent for chain runs. */
  span?: Span;
  /** Context children of this run nest under. */
  ctx: Context;
  at: number;
}

export class GenAiTraceHandler extends BaseCallbackHandler {
  name = 'genai-otel-tracer';
  // Awaited on purpose (see the file header). Must stay a field initializer:
  // it overrides the env-derived default set by the base constructor.
  awaitHandlers = true;

  private readonly runs = new Map<string, RunEntry>();
  /** model name → semconv provider; null when two configs disagree (ambiguous). */
  private readonly providers = new Map<string, string | null>();
  private lastSweep = Date.now();

  constructor(readonly tracer: Tracer) { super(); }

  /** One shared instance: run state must be visible across every callback manager. */
  copy(): this { return this; }

  /** Called when a model is built: lets LLM spans name the real provider. */
  registerModel(model: string | null | undefined, provider: string | null | undefined): void {
    try {
      const p = semconvProviderName(provider);
      if (!model || !p) return;
      const known = this.providers.get(model);
      this.providers.set(model, known === undefined || known === p ? p : null);
    } catch { /* never throw into the caller */ }
  }

  /** Context of a live run (the span tree position), for linking sub-agents to their tool span. */
  contextForRun(runId: string | undefined): Context | undefined {
    return runId ? this.runs.get(runId)?.ctx : undefined;
  }

  // ── Run bookkeeping ────────────────────────────────────────────────────────

  /**
   * Parent context of a new run: the parent run's context when known, else the
   * OTel active context (the invoke_agent span around a top-level invocation),
   * with the user id from the LLM call context when the tree does not carry one.
   */
  private parentContext(parentRunId: string | undefined): Context {
    const fromRun = parentRunId ? this.runs.get(parentRunId)?.ctx : undefined;
    if (fromRun) return fromRun;
    const active = context.active();
    if (active.getValue(USER_ID_KEY) !== undefined) return active;
    const userId = getLlmCallContext().userId;
    return userId ? withUserContext(active, userId) : active;
  }

  private startSpan(runId: string, parentRunId: string | undefined, name: string, kind: SpanKind, attributes: Attributes): void {
    if (this.runs.has(runId)) return; // the same run reported twice (inherited + local handler)
    this.sweep();
    let parent = this.parentContext(parentRunId);
    const userId = parent.getValue(USER_ID_KEY);
    // The owner may have been unknown when the trace started (cold cache) and known
    // now: look it up again at every span start (cached, synchronous, cheap).
    if (typeof userId === 'string' && parent.getValue(OWNER_ID_KEY) === undefined) {
      const ownerId = recordareOwnerOf(userId);
      if (ownerId) parent = parent.setValue(OWNER_ID_KEY, ownerId);
    }
    if (typeof userId === 'string') attributes['user.id'] = userId;
    const ownerId = parent.getValue(OWNER_ID_KEY);
    if (typeof ownerId === 'string') attributes['recordare.owner_id'] = ownerId;
    const span = this.tracer.startSpan(name, { kind, attributes }, parent);
    this.runs.set(runId, { span, ctx: trace.setSpan(parent, span), at: Date.now() });
  }

  private finish(runId: string, err?: unknown, attributes?: Attributes): void {
    const entry = this.runs.get(runId);
    if (!entry) return;
    this.runs.delete(runId);
    if (!entry.span) return;
    if (attributes) entry.span.setAttributes(attributes);
    if (err !== undefined) {
      // error.type only: an error MESSAGE may echo prompt or tool content.
      entry.span.setAttribute('error.type', errorType(err));
      entry.span.setStatus({ code: SpanStatusCode.ERROR });
    }
    entry.span.end();
  }

  /** Drops entries whose end never came (no span end: their duration would be meaningless). */
  private sweep(): void {
    const now = Date.now();
    if (now - this.lastSweep < SWEEP_EVERY_MS) return;
    this.lastSweep = now;
    for (const [id, e] of this.runs) if (now - e.at > ENTRY_TTL_MS) this.runs.delete(id);
  }

  // ── Chains: no span, context only ─────────────────────────────────────────

  handleChainStart(
    _chain: Serialized, _inputs: unknown, runId: string, _runType?: string, _tags?: string[],
    _metadata?: Record<string, unknown>, _runName?: string, parentRunId?: string,
  ): void {
    try {
      if (this.runs.has(runId)) return;
      this.runs.set(runId, { ctx: this.parentContext(parentRunId), at: Date.now() });
    } catch { /* never throw into LangChain */ }
  }

  handleChainEnd(_outputs: unknown, runId: string): void {
    try { this.finish(runId); } catch { /* ignore */ }
  }

  handleChainError(_err: unknown, runId: string): void {
    try { this.finish(runId); } catch { /* ignore */ }
  }

  // ── LLM / chat model ──────────────────────────────────────────────────────

  handleChatModelStart(
    llm: Serialized, _messages: unknown, runId: string, parentRunId?: string,
    extraParams?: Record<string, unknown>, _tags?: string[], metadata?: Record<string, unknown>,
  ): void {
    try { this.startLlm(llm, runId, parentRunId, extraParams, metadata); } catch { /* ignore */ }
  }

  handleLLMStart(
    llm: Serialized, _prompts: string[], runId: string, parentRunId?: string,
    extraParams?: Record<string, unknown>, _tags?: string[], metadata?: Record<string, unknown>,
  ): void {
    try { this.startLlm(llm, runId, parentRunId, extraParams, metadata); } catch { /* ignore */ }
  }

  private startLlm(
    llm: Serialized, runId: string, parentRunId: string | undefined,
    extraParams: Record<string, unknown> | undefined, metadata: Record<string, unknown> | undefined,
  ): void {
    const inv = (extraParams?.invocation_params ?? {}) as Record<string, unknown>;
    const kwargs = ((llm as any)?.kwargs ?? {}) as Record<string, unknown>;
    const model = firstString(inv.model, inv.model_name, inv.modelName, metadata?.ls_model_name, kwargs.model, kwargs.model_name);
    const registered = model ? this.providers.get(model) : undefined;
    const provider = registered ?? (registered === null ? undefined : providerFromLs(metadata?.ls_provider));
    const attributes: Attributes = { 'gen_ai.operation.name': 'chat' };
    if (model) attributes['gen_ai.request.model'] = model;
    if (provider) attributes['gen_ai.provider.name'] = provider;
    this.startSpan(runId, parentRunId, model ? `chat ${model}` : 'chat', SpanKind.CLIENT, attributes);
  }

  handleLLMEnd(output: LLMResult, runId: string): void {
    try { this.finish(runId, undefined, llmEndAttributes(output)); } catch { /* ignore */ }
  }

  handleLLMError(err: unknown, runId: string): void {
    try { this.finish(runId, err ?? 'Error'); } catch { /* ignore */ }
  }

  // ── Tools ─────────────────────────────────────────────────────────────────

  handleToolStart(
    tool: Serialized, _input: string, runId: string, parentRunId?: string, _tags?: string[],
    _metadata?: Record<string, unknown>, runName?: string, toolCallId?: string,
  ): void {
    try {
      const id = (tool as any)?.id;
      const name = firstString(runName, (tool as any)?.name, Array.isArray(id) ? id[id.length - 1] : undefined) ?? 'tool';
      const attributes: Attributes = {
        'gen_ai.operation.name': 'execute_tool',
        'gen_ai.tool.name': name,
        'gen_ai.tool.type': 'function',
      };
      if (toolCallId) attributes['gen_ai.tool.call.id'] = toolCallId;
      this.startSpan(runId, parentRunId, `execute_tool ${name}`, SpanKind.INTERNAL, attributes);
    } catch { /* ignore */ }
  }

  handleToolEnd(output: unknown, runId: string): void {
    try {
      // A ToolMessage with status 'error' is a failure LangGraph turned into a result.
      const failed = (output as any)?.status === 'error';
      this.finish(runId, failed ? 'ToolError' : undefined);
    } catch { /* ignore */ }
  }

  handleToolError(err: unknown, runId: string): void {
    try { this.finish(runId, err ?? 'Error'); } catch { /* ignore */ }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function firstString(...values: unknown[]): string | undefined {
  for (const v of values) if (typeof v === 'string' && v.trim()) return v;
  return undefined;
}

export function errorType(err: unknown): string {
  if (typeof err === 'string') return err;
  const e = err as any;
  const name = e?.name && e.name !== 'Error' ? e.name : e?.constructor?.name;
  return typeof name === 'string' && name ? name.slice(0, 100) : 'Error';
}

/** Token counts and response model from an LLM result (usage_metadata first, legacy shapes after). */
function llmEndAttributes(output: LLMResult): Attributes {
  const attrs: Attributes = {};
  const msg: any = (output?.generations?.[0]?.[0] as any)?.message;
  const llmOut: any = output?.llmOutput ?? {};
  const u = msg?.usage_metadata ?? msg?.response_metadata?.usage ?? llmOut.tokenUsage ?? llmOut.usage ?? llmOut.estimatedTokenUsage;
  if (u) {
    const input  = Number(u.input_tokens  ?? u.promptTokens     ?? u.prompt_tokens);
    const output = Number(u.output_tokens ?? u.completionTokens ?? u.completion_tokens);
    const cache  = Number(u.input_token_details?.cache_read);
    if (Number.isFinite(input))  attrs['gen_ai.usage.input_tokens']  = input;
    if (Number.isFinite(output)) attrs['gen_ai.usage.output_tokens'] = output;
    if (Number.isFinite(cache) && cache > 0) attrs['gen_ai.usage.cache_read.input_tokens'] = cache;
  }
  const responseModel = firstString(msg?.response_metadata?.model_name, msg?.response_metadata?.model, llmOut.model_name, llmOut.model);
  if (responseModel) attrs['gen_ai.response.model'] = responseModel;
  return attrs;
}
