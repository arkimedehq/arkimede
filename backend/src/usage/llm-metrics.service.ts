/**
 * @file llm-metrics.service.ts
 *
 * Call-level serving metrics (P2 of LLM_SERVING_PLAN.md). A LangChain callback
 * handler — attached to EVERY model built by LlmConfigsService.buildModelForConfig —
 * measures latency, tokens and errors per invocation and records them in `llm_calls`.
 * Recording is fire-and-forget: a metrics failure must never affect the LLM call.
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { LLMResult } from '@langchain/core/outputs';
import { LlmCall } from './llm-call.entity';
import { getLlmCallContext, LlmCallContext } from './llm-call-context';
import { LlmDispatcherService } from './llm-dispatcher.service';

const RETENTION_DAYS = 30;
const GC_INTERVAL_MS = 24 * 60 * 60 * 1_000; // 24h

// ── Serving aggregates (P2-F2) ────────────────────────────────────────────────

export interface ServingGroup {
  llmConfigId: string | null;
  configName: string | null;
  provider: string | null;
  model: string | null;
  calls: number;
  errors: number;
  errorRate: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  maxLatencyMs: number;
  /** Null until the P1 scheduler fills queuedMs. */
  avgQueuedMs: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** Mean generation speed: output tokens / total call seconds. */
  tokensPerSecond: number | null;
}

export interface ServingTimelinePoint {
  bucket: string;         // ISO start of the bucket
  calls: number;
  errors: number;
  p95LatencyMs: number;
}

export interface ServingSummary {
  from: string;
  to: string;
  bucket: 'minute' | 'hour' | 'day';
  totals: Omit<ServingGroup, 'llmConfigId' | 'configName' | 'provider' | 'model'>;
  byConfig: ServingGroup[];
  timeline: ServingTimelinePoint[];
}

/** Static facts about the model a handler instance is bound to. */
export interface LlmCallMeta {
  llmConfigId: string | null;
  provider: string;
  model: string | null;
}

/**
 * One handler per built model (models are cached and long-lived); per-run state
 * is keyed by LangChain's runId, so concurrent calls on the same model are safe.
 */
class LlmMetricsCallbackHandler extends BaseCallbackHandler {
  name = 'llm-metrics';
  private readonly starts = new Map<string, { t: number; ctx: LlmCallContext }>();

  constructor(
    private readonly meta: LlmCallMeta,
    private readonly record: (row: Partial<LlmCall>) => void,
  ) { super(); }

  // The call context (queuedMs/priority from the dispatcher, attribution from
  // the caller) is readable HERE because the start callback runs in the same
  // async chain as the call; it is captured per runId for the end/error side.
  private markStart(runId: string): void {
    this.starts.set(runId, { t: Date.now(), ctx: getLlmCallContext() });
  }

  // Chat models fire handleChatModelStart; plain LLMs fire handleLLMStart.
  handleChatModelStart(_llm: unknown, _msgs: unknown, runId: string): void { this.markStart(runId); }
  handleLLMStart(_llm: unknown, _prompts: string[], runId: string): void { this.markStart(runId); }

  private contextFields(ctx: LlmCallContext): Partial<LlmCall> {
    return {
      queuedMs: ctx.queuedMs ?? null,
      priority: ctx.priority ?? null,
      userId:   ctx.userId ?? null,
      origin:   ctx.origin ?? null,
    };
  }

  handleLLMEnd(output: LLMResult, runId: string): void {
    const start = this.starts.get(runId);
    if (start === undefined) return;
    this.starts.delete(runId);
    // usage_metadata is LangChain's cross-provider normalization (same source
    // the agent loop uses for token accounting).
    const msg: any = (output.generations?.[0]?.[0] as any)?.message;
    const u = msg?.usage_metadata ?? {};
    this.record({
      ...this.meta,
      ...this.contextFields(start.ctx),
      latencyMs:        Date.now() - start.t,
      inputTokens:      u.input_tokens  ?? 0,
      outputTokens:     u.output_tokens ?? 0,
      cacheReadTokens:  u.input_token_details?.cache_read     ?? 0,
      cacheWriteTokens: u.input_token_details?.cache_creation ?? 0,
      ok: true,
    });
  }

  handleLLMError(err: unknown, runId: string): void {
    const start = this.starts.get(runId);
    if (start === undefined) return;
    this.starts.delete(runId);
    const e = err as any;
    this.record({
      ...this.meta,
      ...this.contextFields(start.ctx),
      latencyMs: Date.now() - start.t,
      ok: false,
      errorKind: String(e?.name && e.name !== 'Error' ? e.name : e?.message ?? 'unknown').slice(0, 200),
    });
  }
}

@Injectable()
export class LlmMetricsService implements OnModuleInit {
  private readonly logger = new Logger(LlmMetricsService.name);

  constructor(
    @InjectRepository(LlmCall)
    private readonly repo: Repository<LlmCall>,
    private readonly dispatcher: LlmDispatcherService,
  ) {}

  /**
   * Live queue snapshot (P1-F4): active/waiting/max per gated config, with the
   * config display name. Configs without maxConcurrency never appear (pass-through).
   */
  async servingLive(): Promise<Array<{ llmConfigId: string; configName: string | null; active: number; waiting: number; max: number | null }>> {
    const stats = this.dispatcher.stats();
    const ids = Object.keys(stats);
    if (ids.length === 0) return [];
    const rows: Array<{ id: string; name: string }> = await this.repo.query(
      `SELECT id, name FROM llm_configs WHERE id = ANY($1)`, [ids],
    );
    return ids.map((id) => ({
      llmConfigId: id,
      configName:  rows.find((r) => r.id === id)?.name ?? null,
      ...stats[id],
    }));
  }

  onModuleInit(): void {
    void this.gc();
    setInterval(() => void this.gc(), GC_INTERVAL_MS).unref();
  }

  /** Handler to attach to a freshly built model (one per model instance). */
  createHandler(meta: LlmCallMeta): BaseCallbackHandler {
    return new LlmMetricsCallbackHandler(meta, (row) => this.record(row));
  }

  /** Fire-and-forget insert: never throws into the LLM call path. */
  private record(row: Partial<LlmCall>): void {
    void this.repo.insert(row as LlmCall).catch((err) =>
      this.logger.warn(`llm_calls insert failed: ${err?.message ?? err}`),
    );
  }

  /**
   * Serving aggregates over llm_calls (admin): per-config groups, global totals
   * and a time series with an adaptive bucket (≤3h → minute, ≤3d → hour, else day).
   * Defaults to the last 24 hours.
   */
  async servingSummary(range?: { from?: Date; to?: Date }): Promise<ServingSummary> {
    const to   = range?.to   ?? new Date();
    const from = range?.from ?? new Date(to.getTime() - 24 * 60 * 60 * 1_000);
    const spanMs = to.getTime() - from.getTime();
    const bucket: ServingSummary['bucket'] =
      spanMs <= 3 * 60 * 60 * 1_000 ? 'minute'
      : spanMs <= 3 * 24 * 60 * 60 * 1_000 ? 'hour'
      : 'day';

    const groupSelect = `
      count(*)::int                                                            AS "calls",
      (count(*) FILTER (WHERE NOT c."ok"))::int                                AS "errors",
      round(percentile_cont(0.5)  WITHIN GROUP (ORDER BY c."latencyMs"))::int  AS "p50LatencyMs",
      round(percentile_cont(0.95) WITHIN GROUP (ORDER BY c."latencyMs"))::int  AS "p95LatencyMs",
      max(c."latencyMs")::int                                                  AS "maxLatencyMs",
      round(avg(c."queuedMs"))::int                                            AS "avgQueuedMs",
      coalesce(sum(c."inputTokens"), 0)::bigint                                AS "inputTokens",
      coalesce(sum(c."outputTokens"), 0)::bigint                               AS "outputTokens",
      coalesce(sum(c."cacheReadTokens"), 0)::bigint                            AS "cacheReadTokens",
      sum(c."outputTokens")::float / nullif(sum(c."latencyMs")::float / 1000, 0) AS "tokensPerSecond"`;

    const [byConfigRaw, totalsRaw, timelineRaw] = await Promise.all([
      this.repo.query(
        `SELECT c."llmConfigId", cfg."name" AS "configName", c."provider", c."model", ${groupSelect}
           FROM llm_calls c LEFT JOIN llm_configs cfg ON cfg."id" = c."llmConfigId"
          WHERE c."createdAt" >= $1 AND c."createdAt" < $2
          GROUP BY c."llmConfigId", cfg."name", c."provider", c."model"
          ORDER BY "calls" DESC`,
        [from, to],
      ),
      this.repo.query(
        `SELECT ${groupSelect} FROM llm_calls c
          WHERE c."createdAt" >= $1 AND c."createdAt" < $2`,
        [from, to],
      ),
      this.repo.query(
        `SELECT date_trunc('${bucket}', c."createdAt")                            AS "bucket",
                count(*)::int                                                     AS "calls",
                (count(*) FILTER (WHERE NOT c."ok"))::int                         AS "errors",
                round(percentile_cont(0.95) WITHIN GROUP (ORDER BY c."latencyMs"))::int AS "p95LatencyMs"
           FROM llm_calls c
          WHERE c."createdAt" >= $1 AND c."createdAt" < $2
          GROUP BY 1 ORDER BY 1`,
        [from, to],
      ),
    ]);

    const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
    const mapGroup = (r: any) => ({
      calls:           num(r.calls),
      errors:          num(r.errors),
      errorRate:       num(r.calls) ? num(r.errors) / num(r.calls) : 0,
      p50LatencyMs:    num(r.p50LatencyMs),
      p95LatencyMs:    num(r.p95LatencyMs),
      maxLatencyMs:    num(r.maxLatencyMs),
      avgQueuedMs:     r.avgQueuedMs === null || r.avgQueuedMs === undefined ? null : Number(r.avgQueuedMs),
      inputTokens:     num(r.inputTokens),
      outputTokens:    num(r.outputTokens),
      cacheReadTokens: num(r.cacheReadTokens),
      tokensPerSecond: r.tokensPerSecond === null || r.tokensPerSecond === undefined
        ? null : Math.round(Number(r.tokensPerSecond) * 10) / 10,
    });

    return {
      from: from.toISOString(),
      to:   to.toISOString(),
      bucket,
      totals: mapGroup(totalsRaw[0] ?? {}),
      byConfig: byConfigRaw.map((r: any) => ({
        llmConfigId: r.llmConfigId ?? null,
        configName:  r.configName ?? null,
        provider:    r.provider ?? null,
        model:       r.model ?? null,
        ...mapGroup(r),
      })),
      timeline: timelineRaw.map((r: any) => ({
        bucket:       new Date(r.bucket).toISOString(),
        calls:        num(r.calls),
        errors:       num(r.errors),
        p95LatencyMs: num(r.p95LatencyMs),
      })),
    };
  }

  private async gc(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1_000);
      const res = await this.repo.delete({ createdAt: LessThan(cutoff) });
      if (res.affected) this.logger.log(`GC llm_calls: removed ${res.affected} rows older than ${RETENTION_DAYS}d`);
    } catch (err: any) {
      this.logger.warn(`GC llm_calls failed: ${err?.message ?? err}`);
    }
  }
}
