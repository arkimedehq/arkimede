// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file invocations.service.ts
 *
 * Persistence for the external-invocation log (see invocation.entity.ts).
 *
 * record() is strictly best-effort: it must NEVER make the logged request fail
 * (a DB hiccup is logged and swallowed). Retention: rows older than
 * INVOCATION_LOG_RETENTION_DAYS (default 30, 0 = keep forever) are deleted at
 * boot and then periodically.
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, Repository } from 'typeorm';
import { AgentInvocation, InvocationToolCall } from './invocation.entity';
import { User } from '../users/users.entity';

/** Caps applied at write time — the log stores previews, never full payloads. */
const PREVIEW_MAX_CHARS   = 4000;
const TOOL_VALUE_MAX      = 2048;
const MAX_TOOL_CALLS      = 50;
const RETENTION_SWEEP_MS  = 6 * 60 * 60 * 1000; // every 6h

export interface RecordInvocationInput {
  userId:        string | null;
  origin:        string;
  route:         'chat' | 'transcription' | 'speech';
  model?:        string | null;
  apiKeyPrefix?: string | null;
  inputPreview?:  string | null;
  outputPreview?: string | null;
  toolCalls?:    InvocationToolCall[] | null;
  inputTokens?:  number | null;
  outputTokens?: number | null;
  durationMs?:   number | null;
  status:        'ok' | 'error';
  error?:        string | null;
}

export interface ListInvocationsOptions {
  /** Admin only: list every user's invocations instead of own. */
  all?:    boolean;
  origin?: string;
  route?:  string;
  limit?:  number;
  offset?: number;
}

/** Truncates a preview string to the storage cap. */
export function truncatePreview(val: string | null | undefined, max = PREVIEW_MAX_CHARS): string | null {
  if (!val) return null;
  return val.length > max ? val.slice(0, max) + `… [truncated — ${val.length} total characters]` : val;
}

/** Truncates an arbitrary tool input/output value for the log (~2KB). */
export function truncateToolValue(val: any, max = TOOL_VALUE_MAX): any {
  if (val === undefined || val === null) return val;
  let str: string;
  try { str = typeof val === 'string' ? val : JSON.stringify(val); }
  catch { str = String(val); }
  if (str.length > max) {
    return str.slice(0, max) + `… [truncated — ${str.length} total characters]`;
  }
  return val; // within the limit: preserve the original shape (object/string)
}

/** Shapes a raw tool-call record list for storage (caps count and value sizes). */
export function shapeToolCalls(calls: InvocationToolCall[] | null | undefined): InvocationToolCall[] | null {
  if (!calls?.length) return null;
  return calls.slice(0, MAX_TOOL_CALLS).map((c) => ({
    name: c.name,
    ...(c.input !== undefined ? { input: truncateToolValue(c.input) } : {}),
    ...(c.output !== undefined ? { output: truncateToolValue(c.output) } : {}),
    ...(c.ok !== undefined ? { ok: c.ok } : {}),
    ...(c.durationMs !== undefined ? { durationMs: c.durationMs } : {}),
  }));
}

@Injectable()
export class InvocationsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InvocationsService.name);
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    @InjectRepository(AgentInvocation)
    private readonly repo: Repository<AgentInvocation>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly env: ConfigService,
  ) {}

  onModuleInit(): void {
    void this.sweepExpired();
    this.sweepTimer = setInterval(() => void this.sweepExpired(), RETENTION_SWEEP_MS);
    this.sweepTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  /** Persists one invocation. Best-effort: never throws to the caller. */
  async record(entry: RecordInvocationInput): Promise<void> {
    try {
      await this.repo.insert({
        userId:        entry.userId,
        origin:        entry.origin,
        route:         entry.route,
        model:         entry.model ?? null,
        apiKeyPrefix:  entry.apiKeyPrefix ?? null,
        inputPreview:  truncatePreview(entry.inputPreview),
        outputPreview: truncatePreview(entry.outputPreview),
        toolCalls:     shapeToolCalls(entry.toolCalls),
        inputTokens:   entry.inputTokens ?? null,
        outputTokens:  entry.outputTokens ?? null,
        durationMs:    entry.durationMs ?? null,
        status:        entry.status,
        error:         truncatePreview(entry.error ?? null, 1000),
      });
    } catch (err: any) {
      this.logger.warn(`Invocation log write failed (ignored): ${err?.message ?? err}`);
    }
  }

  /** Lists invocations: own by default; every user's with `all` (admin-gated by the controller). */
  async findAll(
    userId: string,
    opts: ListInvocationsOptions = {},
  ): Promise<{ items: (AgentInvocation & { userEmail?: string | null })[]; total: number }> {
    const limit  = Math.min(Math.max(opts.limit ?? 50, 1), 100);
    const offset = Math.max(opts.offset ?? 0, 0);
    const where: Record<string, any> = {};
    if (!opts.all) where.userId = userId;
    if (opts.origin) where.origin = opts.origin;
    if (opts.route)  where.route  = opts.route;

    const [items, total] = await this.repo.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      take: limit,
      skip: offset,
    });

    // Admin all-users view: resolve caller emails (one query, no entity relation).
    let emails = new Map<string, string>();
    if (opts.all) {
      const ids = [...new Set(items.map((i) => i.userId).filter((v): v is string => !!v))];
      if (ids.length) {
        const users = await this.userRepo.find({ where: { id: In(ids) }, select: { id: true, email: true } });
        emails = new Map(users.map((u) => [u.id, u.email]));
      }
    }
    return {
      items: items.map((i) => ({ ...i, userEmail: i.userId ? emails.get(i.userId) ?? null : null })),
      total,
    };
  }

  /** Deletes rows older than the configured retention (0/empty = keep forever). */
  private async sweepExpired(): Promise<void> {
    const days = Number(this.env.get<string>('INVOCATION_LOG_RETENTION_DAYS', '30'));
    if (!Number.isFinite(days) || days <= 0) return;
    try {
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const res = await this.repo.delete({ createdAt: LessThan(cutoff) });
      if (res.affected) this.logger.log(`Invocation log retention: deleted ${res.affected} rows older than ${days}d`);
    } catch (err: any) {
      this.logger.warn(`Invocation log retention sweep failed: ${err?.message ?? err}`);
    }
  }
}
