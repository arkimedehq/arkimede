/**
 * @file embed-ingest.queue.ts
 *
 * Asynchronous queue for indexing files of a DataSource (see
 * EmbedService.ingestDatasourceFile). Text extraction (PDF/DOCX/OCR) + embedding
 * of many chunks can take several seconds: running it synchronously would block the
 * caller (e.g. the skill task, cap 30s) and retries would create duplicates.
 *
 * Here the request is QUEUED (BullMQ + Redis) and processed in the background by a
 * worker; when done the user receives a notification (persisted + WebSocket push).
 *
 * Same pattern as SchedulingService/FlowScheduler: graceful disable if Redis is
 * unreachable (fallback: inline execution, best-effort).
 */
import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker, Job, ConnectionOptions } from 'bullmq';
import { basename } from 'path';
import type { DocScope } from '../custom-tools/custom-tool.types';
import { EmbedService } from './embed.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationsGateway } from '../notifications/notifications.gateway';

const QUEUE_NAME = 'embed-ingest';

export interface EmbedIngestJob {
  userId:     string;
  source:     string;
  path:       string;
  collection?: string;
  scope?:     DocScope;
  projectId?: string | null;
}

export type EnqueueResult =
  | { status: 'queued'; jobId: string; filename: string }
  | { status: 'inline'; chunks: number; collection: string; filename: string };

@Injectable()
export class EmbedIngestQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EmbedIngestQueueService.name);
  private readonly connection: ConnectionOptions;
  private queue?: Queue;
  private worker?: Worker;
  private enabled = false;

  constructor(
    private readonly config: ConfigService,
    private readonly embed: EmbedService,
    private readonly notifications: NotificationsService,
    private readonly gateway: NotificationsGateway,
  ) {
    this.connection = this.parseRedisUrl(this.config.get<string>('REDIS_URL', 'redis://localhost:6379'));
  }

  onModuleInit(): void {
    try {
      this.queue = new Queue(QUEUE_NAME, { connection: this.connection });
      this.worker = new Worker(QUEUE_NAME, (job) => this.process(job), { connection: this.connection });
      this.worker.on('failed', (job, err) => this.logger.error(`Ingest job ${job?.id} failed: ${err?.message}`));
      this.worker.on('error', (err) => this.logger.warn(`Worker error: ${err?.message}`));
      this.enabled = true;
      this.logger.log('EmbedIngestQueue started (BullMQ).');
    } catch (err: any) {
      this.enabled = false;
      this.logger.warn(`EmbedIngestQueue disabled (Redis unreachable?): ${err?.message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close().catch(() => undefined);
    await this.queue?.close().catch(() => undefined);
  }

  /**
   * Queues the indexing and returns immediately. Without Redis (queue disabled)
   * it falls back to inline execution (best-effort, may exceed timeouts on large files).
   * `attempts: 1`: no automatic retry → no double indexing.
   */
  async enqueue(data: EmbedIngestJob): Promise<EnqueueResult> {
    const filename = basename(String(data.path).replace(/\/+$/, '')) || 'file';
    if (this.enabled && this.queue) {
      const job = await this.queue.add('ingest', data, {
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: 100,
      });
      this.logger.log(`Ingest QUEUED job=${job.id} file="${filename}" (worker async).`);
      return { status: 'queued', jobId: String(job.id), filename };
    }
    // Fallback without queue (Redis absent): runs immediately AND notifies anyway.
    this.logger.warn(`Queue not available → INLINE ingest for "${filename}" (timeout risk on large files).`);
    const r = await this.runAndNotify(data);
    return { status: 'inline', chunks: r.chunks, collection: r.collection, filename };
  }

  private async process(job: Job<EmbedIngestJob>): Promise<void> {
    this.logger.log(`Ingest job=${job.id} processing…`);
    await this.runAndNotify(job.data);   // rethrows on error → BullMQ failed (no retry)
  }

  /**
   * Runs the indexing and ALWAYS sends a notification to the user (success /
   * no text / error). Used both by the worker (async) and by the inline fallback,
   * so the user receives the notification in both cases.
   */
  private async runAndNotify(data: EmbedIngestJob): Promise<{ chunks: number; collection: string }> {
    const { userId, source, path, collection, scope, projectId } = data;
    const filename = basename(String(path).replace(/\/+$/, '')) || 'file';
    try {
      const r = await this.embed.ingestDatasourceFile(userId, source, path, collection, { scope, projectId });
      if (r.chunks > 0) {
        await this.notify(userId, 'embed_ingest_done', {
          title:   `Indexing completed: ${filename}`,
          message: `${r.chunks} blocks indexed into collection "${r.collection}".`,
          filename, chunks: r.chunks, collection: r.collection, source, path,
        });
      } else {
        await this.notify(userId, 'embed_ingest_failed', {
          title:   `Indexing without text: ${filename}`,
          message: 'No extractable text from the file (unsupported format or empty document).',
          filename, source, path,
        });
      }
      return r;
    } catch (err: any) {
      await this.notify(userId, 'embed_ingest_failed', {
        title:   `Indexing failed: ${filename}`,
        message: err?.message ?? 'Error during indexing.',
        filename, source, path,
      });
      throw err;
    }
  }

  private async notify(userId: string, eventType: string, payload: Record<string, unknown>): Promise<void> {
    try {
      const notif = await this.notifications.create({ userId, source: 'embed_ingest', eventType, payload });
      this.gateway.emitToUser(userId, 'notification', { id: notif.id, eventType, ...payload });
      this.logger.log(`Ingest notification created id=${notif.id} type=${eventType} userId=${userId}`);
    } catch (err: any) {
      this.logger.error(`Ingest notification NOT sent (${eventType}, userId=${userId}): ${err?.message}`);
    }
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
