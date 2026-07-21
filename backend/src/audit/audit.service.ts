import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, FindOptionsWhere, LessThanOrEqual, MoreThanOrEqual, Repository } from 'typeorm';
import { AuditLog } from './audit-log.entity';

export interface AuditEvent {
  actorId?:   string | null;
  actorName?: string | null;
  actAsId?:   string | null;
  action:     string;
  resource?:  string | null;
  outcome:    'ok' | 'denied' | 'error';
  ctx?:       Record<string, unknown> | null;
}

export interface AuditQuery {
  action?:  string;
  outcome?: string;
  actorId?: string;
  from?:    string;
  to?:      string;
  limit?:   number;
}

/**
 * AuditService (E4) — records security events.
 *
 * Dual write: (1) structured JSON row on stdout → CloudWatch (append-only,
 * tamper-evident with S3 Object Lock export); (2) audit_log table for the admin viewer.
 * Best-effort: an audit error must never block the calling operation.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @InjectRepository(AuditLog)
    private readonly repo: Repository<AuditLog>,
  ) {}

  async record(event: AuditEvent): Promise<void> {
    // (1) structured row on stdout (CloudWatch-ready). Never secrets/PII in ctx.
    try {
      process.stdout.write(JSON.stringify({ audit: true, ts: new Date().toISOString(), ...event }) + '\n');
    } catch { /* ignore */ }

    // (2) persistence for the admin viewer
    try {
      await this.repo.save(this.repo.create({
        actorId:   event.actorId   ?? null,
        actorName: event.actorName ?? null,
        actAsId:   event.actAsId   ?? null,
        action:    event.action,
        resource:  event.resource  ?? null,
        outcome:   event.outcome,
        ctx:       event.ctx       ?? null,
      }));
    } catch (err: any) {
      this.logger.warn(`Audit persistence failed (${event.action}): ${err.message}`);
    }
  }

  async list(q: AuditQuery): Promise<AuditLog[]> {
    const where: FindOptionsWhere<AuditLog> = {};
    if (q.action)  where.action  = q.action;
    if (q.outcome) where.outcome = q.outcome;
    if (q.actorId) where.actorId = q.actorId;
    if (q.from && q.to)   where.createdAt = Between(new Date(q.from), new Date(q.to));
    else if (q.from)      where.createdAt = MoreThanOrEqual(new Date(q.from));
    else if (q.to)        where.createdAt = LessThanOrEqual(new Date(q.to));

    return this.repo.find({
      where,
      order: { createdAt: 'DESC' },
      take:  Math.min(q.limit ?? 100, 500),
    });
  }
}
