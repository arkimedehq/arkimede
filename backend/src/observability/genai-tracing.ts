// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file genai-tracing.ts
 *
 * Opt-in OpenTelemetry tracing of agent work (GenAI semantic conventions):
 * `invoke_agent` spans around agent / team runs, `chat` and `execute_tool`
 * spans from the LangChain callback handler (genai-trace.handler.ts), and
 * `transcription` / `speech` spans around speech-to-text and text-to-speech
 * (withVoiceSpan; the GenAI conventions define no speech operation).
 *
 * OFF unless OTEL_EXPORTER_OTLP_TRACES_ENDPOINT or OTEL_EXPORTER_OTLP_ENDPOINT
 * is set: then nothing is started, no handler is attached and withAgentSpan /
 * withRunParent just call through — zero cost, no behaviour change.
 *
 * Standard OTel env vars: OTEL_EXPORTER_OTLP_TRACES_HEADERS (e.g. the
 * Authorization header), OTEL_EXPORTER_OTLP_TRACES_PROTOCOL (`http/protobuf`
 * default, `http/json`), OTEL_SERVICE_NAME (default `arkimede`),
 * OTEL_RESOURCE_ATTRIBUTES. Spans are exported in the background by a
 * BatchSpanProcessor: the request path never waits on the network.
 *
 * Metadata only — see the handler file header.
 */
import { Logger } from '@nestjs/common';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { Attributes, Context, Span, SpanKind, SpanStatusCode, context, trace } from '@opentelemetry/api';
import { NodeTracerProvider, BatchSpanProcessor, SpanExporter, SpanProcessor } from '@opentelemetry/sdk-trace-node';
import { defaultResource, detectResources, envDetector, resourceFromAttributes } from '@opentelemetry/resources';
import { GenAiTraceHandler, OWNER_ID_KEY, USER_ID_KEY, errorType, recordareOwnerOf, withUserContext } from './genai-trace.handler';
import { getLlmCallContext } from '../usage/llm-call-context';

export { setRecordareOwnerResolver } from './genai-trace.handler';

const logger = new Logger('GenAiTracing');

let state: { provider: NodeTracerProvider; handler: GenAiTraceHandler } | null = null;

/** True when an OTLP traces endpoint is configured. */
export function genAiTracingConfigured(): boolean {
  return !!(process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim() || process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim());
}

/**
 * Starts the tracer once, at backend start-up (main.ts). Returns false (and
 * does nothing) when no endpoint is configured. Never throws: a tracing setup
 * failure is logged and the backend runs without it.
 *
 * @param opts.spanProcessor - replaces the BatchSpanProcessor + OTLP exporter (tests only).
 */
export function initGenAiTracing(opts?: { spanProcessor?: SpanProcessor }): boolean {
  if (state) return true;
  if (!genAiTracingConfigured()) return false;
  try {
    const provider = new NodeTracerProvider({
      // Precedence: SDK defaults < service.name 'arkimede' < OTEL_SERVICE_NAME / OTEL_RESOURCE_ATTRIBUTES.
      resource: defaultResource()
        .merge(resourceFromAttributes({ 'service.name': 'arkimede' }))
        .merge(detectResources({ detectors: [envDetector] })),
      spanProcessors: [opts?.spanProcessor ?? new BatchSpanProcessor(createExporter())],
    });
    // Registers the global provider and the AsyncLocalStorage context manager
    // (needed for invoke_agent spans to parent the runs started inside them).
    provider.register();
    state = { provider, handler: new GenAiTraceHandler(provider.getTracer('arkimede.genai')) };
    // Flush what is buffered on a natural exit (no signal handlers: adding one
    // would change how the process reacts to SIGTERM/SIGINT).
    process.once('beforeExit', () => { void shutdownGenAiTracing(); });
    logger.log('OpenTelemetry GenAI tracing enabled (metadata only)');
    return true;
  } catch (err: any) {
    logger.warn(`OpenTelemetry tracing NOT enabled: ${err?.message ?? err}`);
    state = null;
    return false;
  }
}

function createExporter(): SpanExporter {
  const protocol = (process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ?? process.env.OTEL_EXPORTER_OTLP_PROTOCOL ?? 'http/protobuf').trim();
  if (protocol === 'http/json') {
    const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
    return new OTLPTraceExporter();
  }
  if (protocol !== 'http/protobuf') logger.warn(`OTLP protocol "${protocol}" not supported: using http/protobuf`);
  // Endpoint and headers come from the standard OTEL_EXPORTER_OTLP_* env vars.
  const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-proto');
  return new OTLPTraceExporter();
}

/** Flushes and stops the exporter (tests, natural exit). */
export async function shutdownGenAiTracing(): Promise<void> {
  const s = state;
  state = null;
  if (!s) return;
  try {
    await s.provider.shutdown();
    trace.disable();
    context.disable();
  } catch { /* best effort */ }
}

/** The shared callback handler, or null when tracing is off (attach nothing then). */
export function getGenAiTraceHandler(): BaseCallbackHandler | null {
  return state?.handler ?? null;
}

/** Records which provider serves a model name (for gen_ai.provider.name); no-op when off. */
export function registerGenAiModel(model: string | null | undefined, provider: string | null | undefined): void {
  state?.handler.registerModel(model, provider);
}

export interface AgentSpanInfo {
  /** gen_ai.agent.name */
  name: string;
  /** gen_ai.agent.id, when the agent has a persistent id. */
  id?: string;
  /** Arkimede user id → user.id (inherited by the child spans). */
  userId?: string;
  /** gen_ai.conversation.id (the chat id), when there is one. */
  conversationId?: string;
}

/**
 * Runs `fn` inside an `invoke_agent {name}` span (child of the active context:
 * a team span, or the tool span set by withRunParent). The LangChain runs that
 * `fn` starts nest under it. Errors are rethrown unchanged; an abort is not an
 * error (same rule as the chat stream).
 */
export async function withAgentSpan<T>(info: AgentSpanInfo, fn: () => Promise<T>): Promise<T> {
  if (!state) return fn();
  let span: Span;
  let ctx: Context;
  try {
    const parent = context.active();
    const userId = info.userId ?? parent.getValue(USER_ID_KEY);
    // Cached value only (never waits on Recordare; unknown → looked up in the background).
    const ownerId = typeof userId === 'string' ? recordareOwnerOf(userId) : undefined;
    span = state.handler.tracer.startSpan(`invoke_agent ${info.name}`, {
      kind: SpanKind.INTERNAL,
      attributes: {
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.agent.name': info.name,
        ...(info.id ? { 'gen_ai.agent.id': info.id } : {}),
        ...(info.conversationId ? { 'gen_ai.conversation.id': info.conversationId } : {}),
        ...(typeof userId === 'string' ? { 'user.id': userId } : {}),
        ...(ownerId ? { 'recordare.owner_id': ownerId } : {}),
      },
    }, parent);
    ctx = trace.setSpan(typeof userId === 'string' ? withUserContext(parent, userId) : parent, span);
  } catch {
    return fn(); // tracing failed: run untraced
  }
  try {
    return await context.with(ctx, fn);
  } catch (err: any) {
    if (err?.name !== 'AbortError') {
      try { span.setAttribute('error.type', errorType(err)); span.setStatus({ code: SpanStatusCode.ERROR }); } catch { /* ignore */ }
    }
    throw err;
  } finally {
    try { span.end(); } catch { /* ignore */ }
  }
}

/**
 * Runs `fn` with the span of a live LangChain run (e.g. the `execute_tool` span
 * of an agent-as-tool) as the active context, so an agent invoked from inside a
 * tool nests under that tool span. Pass-through when off or the run is unknown.
 */
export function withRunParent<T>(runId: string | undefined, fn: () => Promise<T>): Promise<T> {
  const ctx = state?.handler.contextForRun(runId);
  return ctx ? context.with(ctx, fn) : fn();
}

/**
 * Runs `fn` with `userId` (and its Recordare owner id, when known) in the OTel
 * context, so spans started inside it (e.g. a voice span) carry `user.id`.
 * Pass-through when off or without a user.
 */
export function withTraceUser<T>(userId: string | null | undefined, fn: () => Promise<T>): Promise<T> {
  if (!state || !userId) return fn();
  let ctx: Context;
  try { ctx = withUserContext(context.active(), userId); } catch { return fn(); }
  return context.with(ctx, fn);
}

// ── Voice (speech-to-text / text-to-speech) ───────────────────────────────────

export interface VoiceSpanInfo {
  /** `voice.operation`: speech-to-text or text-to-speech. */
  operation: 'transcription' | 'speech';
  /** gen_ai.request.model: the STT / TTS model (or voice id), when known. */
  model?: string | null;
  /** gen_ai.provider.name: local engine (`whisper`, `piper`) or cloud provider, when known. */
  provider?: string | null;
  /** True when the engine is a remote service (span kind CLIENT, else INTERNAL). */
  remote: boolean;
  /** voice.audio_seconds: input audio length (STT), when cheaply known. */
  audioSeconds?: number;
  /** voice.characters: TTS input length (a count, never the text). */
  characters?: number;
}

/**
 * Runs one speech-to-text / text-to-speech call inside a `transcription {model}`
 * / `speech {model}` span, child of the active context (e.g. an agent run).
 * `info` is built lazily (only when tracing is on); `resultAudioSeconds` reads
 * the output audio length from the result (TTS). METADATA ONLY: the transcript,
 * the text to speak and the audio never reach the span. Errors are rethrown
 * unchanged (span status ERROR + `error.type`); a tracing failure never reaches
 * the voice path.
 */
export async function withVoiceSpan<T>(
  info: () => VoiceSpanInfo,
  fn: () => Promise<T>,
  resultAudioSeconds?: (result: T) => number | undefined,
): Promise<T> {
  if (!state) return fn();
  let span: Span;
  try {
    const i = info();
    const parent = context.active();
    const userId = parent.getValue(USER_ID_KEY) ?? getLlmCallContext().userId;
    const ownerFromCtx = parent.getValue(OWNER_ID_KEY);
    const ownerId = typeof ownerFromCtx === 'string' ? ownerFromCtx : recordareOwnerOf(userId);
    const attributes: Attributes = { 'voice.operation': i.operation };
    if (i.model) attributes['gen_ai.request.model'] = i.model;
    if (i.provider) attributes['gen_ai.provider.name'] = i.provider;
    if (validSeconds(i.audioSeconds)) attributes['voice.audio_seconds'] = i.audioSeconds;
    if (typeof i.characters === 'number' && Number.isFinite(i.characters)) attributes['voice.characters'] = i.characters;
    if (typeof userId === 'string') attributes['user.id'] = userId;
    if (ownerId) attributes['recordare.owner_id'] = ownerId;
    span = state.handler.tracer.startSpan(i.model ? `${i.operation} ${i.model}` : i.operation, {
      kind: i.remote ? SpanKind.CLIENT : SpanKind.INTERNAL,
      attributes,
    }, parent);
  } catch {
    return fn(); // tracing failed: run untraced
  }
  try {
    const result = await fn();
    try {
      const secs = resultAudioSeconds?.(result);
      if (validSeconds(secs)) span.setAttribute('voice.audio_seconds', secs);
    } catch { /* ignore */ }
    return result;
  } catch (err: any) {
    try { span.setAttribute('error.type', errorType(err)); span.setStatus({ code: SpanStatusCode.ERROR }); } catch { /* ignore */ }
    throw err;
  } finally {
    try { span.end(); } catch { /* ignore */ }
  }
}

function validSeconds(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/**
 * Duration in seconds of a PCM RIFF/WAVE buffer, read from its header chunks
 * only (no decoding); undefined for any other format or a malformed header.
 * Never throws.
 */
export function wavDurationSeconds(buf: Buffer | null | undefined): number | undefined {
  try {
    if (!buf || buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return undefined;
    let pos = 12;
    let byteRate = 0;
    while (pos + 8 <= buf.length) {
      const id = buf.toString('ascii', pos, pos + 4);
      const size = buf.readUInt32LE(pos + 4);
      const body = pos + 8;
      if (id === 'fmt ' && body + 12 <= buf.length) {
        byteRate = buf.readUInt32LE(body + 8);
      } else if (id === 'data') {
        if (!byteRate) return undefined;
        // Streamed encoders may write 0 / 0xFFFFFFFF: take what is there.
        const bytes = size === 0 || size === 0xffffffff ? buf.length - body : Math.min(size, buf.length - body);
        return Math.round((bytes / byteRate) * 1000) / 1000;
      }
      pos = body + size + (size % 2);
    }
    return undefined;
  } catch {
    return undefined;
  }
}
