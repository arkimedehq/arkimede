// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file embed-ingest.queue.ts
 *
 * Asynchronous queue for indexing files: files of a DataSource (see
 * EmbedService.ingestDatasourceFile) and uploaded files (EmbedService.ingestFileById).
 * Text extraction (PDF/DOCX/OCR — minutes for long scans at the higher OCR levels) + embedding
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
import type { OcrLevel } from '../ocr/ocr.types';
import { EmbedService } from './embed.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationsGateway } from '../notifications/notifications.gateway';

const QUEUE_NAME = 'embed-ingest';

interface EmbedIngestJobBase {
  userId:      string;
  collection?: string;
  scope?:      DocScope;
  projectId?:  string | null;
  ocrLevel?:   OcrLevel | null;
}

/** A file of a DataSource, identified by `(source, path)`. */
export interface DatasourceIngestJob extends EmbedIngestJobBase {
  source: string;
  path:   string;
}

/** An uploaded file (files table), identified by its id. */
export interface UploadIngestJob extends EmbedIngestJobBase {
  fileId:   string;
  filename: string;
}

export type EmbedIngestJob = DatasourceIngestJob | UploadIngestJob;

function jobFilename(data: EmbedIngestJob): string {
  if ('fileId' in data) return data.filename || 'file';
  return basename(String(data.path).replace(/\/+$/, '')) || 'file';
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
    const filename = jobFilename(data);
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
    const { userId, collection, scope, projectId, ocrLevel } = data;
    const filename = jobFilename(data);
    // Identifies the file in the notification payload (upload id or source+path).
    const ref = 'fileId' in data ? { fileId: data.fileId } : { source: data.source, path: data.path };
    try {
      const opts = { scope, projectId, ocrLevel };
      const r = 'fileId' in data
        ? await this.embed.ingestFileById(data.fileId, userId, collection, opts)
        : await this.embed.ingestDatasourceFile(userId, data.source, data.path, collection, opts);
      if (r.chunks > 0) {
        await this.notify(userId, 'embed_ingest_done', {
          title:   `Indexing completed: ${filename}`,
          message: `${r.chunks} blocks indexed into collection "${r.collection}".`,
          filename, chunks: r.chunks, collection: r.collection, ...ref,
        });
      } else {
        await this.notify(userId, 'embed_ingest_failed', {
          title:   `Indexing without text: ${filename}`,
          message: 'No extractable text from the file (unsupported format or empty document).',
          filename, ...ref,
        });
      }
      return r;
    } catch (err: any) {
      await this.notify(userId, 'embed_ingest_failed', {
        title:   `Indexing failed: ${filename}`,
        message: err?.message ?? 'Error during indexing.',
        filename, ...ref,
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
