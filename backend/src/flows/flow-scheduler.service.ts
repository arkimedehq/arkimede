/**
 * @file flow-scheduler.service.ts
 *
 * Robust Flow scheduler based on BullMQ (Redis). Handles two trigger types:
 *   - `cron`      → recurring, via BullMQ Job Scheduler (cron pattern + timezone)
 *   - `scheduled` → one-shot "day X at Y", via delayed job (delay = runAt - now)
 *
 * Why BullMQ: the jobs live on Redis → they survive backend restarts,
 * support retry/backoff and (prospectively) distributed workers. The DB remains the
 * source of truth: `syncAll()` at boot realigns Redis to the flow triggers.
 *
 * Degrades gracefully: if Redis is unreachable the scheduler disables itself and
 * logs a warning, without blocking the app boot (the manual/webhook/
 * chat-as-tool triggers keep working).
 */
import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Queue, Worker, Job, ConnectionOptions } from 'bullmq';

import { Flow } from './flow.entity';
import { FlowEngineService } from './flow-engine.service';

const QUEUE_NAME = 'flow-scheduler';
const schedulerId = (flowId: string) => `flow:${flowId}`;
const onceJobId = (flowId: string) => `flow:${flowId}:once`;

@Injectable()
export class FlowSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FlowSchedulerService.name);
  private readonly connection: ConnectionOptions;
  private queue?: Queue;
  private worker?: Worker;
  private enabled = false;

  constructor(
    private readonly config: ConfigService,
    @InjectRepository(Flow) private readonly flowRepo: Repository<Flow>,
    private readonly engine: FlowEngineService,
  ) {
    this.connection = this.parseRedisUrl(this.config.get<string>('REDIS_URL', 'redis://localhost:6379'));
  }

  async onModuleInit(): Promise<void> {
    try {
      this.queue = new Queue(QUEUE_NAME, { connection: this.connection });
      this.worker = new Worker(QUEUE_NAME, (job) => this.process(job), { connection: this.connection });
      this.worker.on('failed', (job, err) => this.logger.error(`Job ${job?.id} failed: ${err?.message}`));
      this.worker.on('error', (err) => this.logger.warn(`Worker error: ${err?.message}`));
      this.enabled = true;
      await this.syncAll();
      this.logger.log('FlowScheduler avviato (BullMQ).');
    } catch (err: any) {
      this.enabled = false;
      this.logger.warn(`FlowScheduler disabled (Redis unreachable?): ${err?.message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close().catch(() => undefined);
    await this.queue?.close().catch(() => undefined);
  }

  // ── Sync (called by FlowsService on create/update/delete) ────────────────

  /** Aligns a flow's jobs to its triggers. Idempotent. */
  async syncFlow(flow: Flow): Promise<void> {
    if (!this.enabled || !this.queue) return;
    await this.removeJobs(flow.id);
    if (!flow.enabled) return;

    const t = flow.trigger;
    if (t?.type === 'cron' && t.cron?.trim()) {
      await this.queue.upsertJobScheduler(
        schedulerId(flow.id),
        { pattern: t.cron.trim(), tz: t.timezone || undefined },
        { name: 'run', data: { flowId: flow.id }, opts: { removeOnComplete: 50, removeOnFail: 50 } },
      );
      this.logger.log(`Cron registrato per flow ${flow.id}: "${t.cron}"`);
    } else if (t?.type === 'scheduled' && t.runAt && !t.firedAt) {
      const delay = new Date(t.runAt).getTime() - Date.now();
      if (delay > 0) {
        await this.queue.add('run', { flowId: flow.id }, {
          delay, jobId: onceJobId(flow.id), removeOnComplete: true, removeOnFail: 50,
        });
        this.logger.log(`One-shot registrato per flow ${flow.id} tra ${Math.round(delay / 1000)}s`);
      }
    }
  }

  /** Removes all jobs (cron scheduler + one-shot) of a flow. */
  async removeJobs(flowId: string): Promise<void> {
    if (!this.queue) return;
    await this.queue.removeJobScheduler(schedulerId(flowId)).catch(() => undefined);
    const once = await this.queue.getJob(onceJobId(flowId)).catch(() => undefined);
    await once?.remove().catch(() => undefined);
  }

  // ── Worker ─────────────────────────────────────────────────────────────────

  private async process(job: Job): Promise<void> {
    const { flowId } = job.data as { flowId: string };
    const flow = await this.flowRepo.findOne({ where: { id: flowId } });
    if (!flow || !flow.enabled) return;

    const triggeredBy = flow.trigger?.type === 'scheduled' ? 'scheduled' : 'cron';
    await this.engine.run(flow, flow.userId, {}, { triggeredBy });

    // One-shot: mark firedAt so it is not re-registered after a restart.
    if (flow.trigger?.type === 'scheduled') {
      flow.trigger = { ...flow.trigger, firedAt: new Date().toISOString() };
      await this.flowRepo.save(flow);
    }
  }

  // ── Boot ─────────────────────────────────────────────────────────────────

  /** Realigns Redis to the flow triggers in the DB (source of truth). */
  private async syncAll(): Promise<void> {
    const flows = await this.flowRepo.find({ where: { enabled: true } });
    let n = 0;
    for (const f of flows) {
      if (f.trigger?.type === 'cron' || f.trigger?.type === 'scheduled') {
        await this.syncFlow(f);
        n++;
      }
    }
    if (n) this.logger.log(`Sincronizzati ${n} flow schedulati al boot.`);
  }

  private parseRedisUrl(url: string): ConnectionOptions {
    try {
      const u = new URL(url);
      return {
        host: u.hostname || 'localhost',
        port: Number(u.port || 6379),
        ...(u.password ? { password: u.password } : {}),
        ...(u.username ? { username: u.username } : {}),
      };
    } catch {
      return { host: 'localhost', port: 6379 };
    }
  }
}
