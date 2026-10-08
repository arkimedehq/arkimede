// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file recordare-outbox.service.ts
 *
 * Send side of the Recordare outbox: a background worker drains `recordare_outbox`
 * (filled by recordare-outbox.ts) and calls Recordare's ingest API (§2) through the
 * shared client library:
 *   - `message` rows of a chat → one `POST api/v1/ingest/messages` (≤500 items per
 *     request), built from the CURRENT message rows (a message deleted meanwhile is
 *     simply dropped — its deletion row follows);
 *   - `delete_message` → `DELETE api/v1/ingest/conversations/{chat}/messages/{id}`;
 *   - `delete_conversation` → `DELETE api/v1/ingest/conversations/{chat}`.
 * 404 on a deletion counts as done. Idempotent by design: Recordare dedups on the
 * message externalId (= Arkimede message id), so a resend never duplicates.
 *
 * Failures follow the library's delivery policy (afterFailure): exponential back-off
 * with jitter, Recordare's Retry-After honoured; after the last attempt, or at once
 * on a request Recordare will never accept (400/413/422), the row is parked
 * (parkedAt) with a warning in the log. Nothing here runs on the request path: a
 * Recordare outage never fails or slows a chat.
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { APP_NAME } from '../config/app.config';
import { afterFailure, type RecordareClient } from './client';
import { recordareClient } from './recordare.config';
import { IngestChat, IngestMessage, buildIngestBody } from './recordare-ingest.mapper';
import type { OutboxOp } from './recordare-outbox';
import { RecordareIdentityService } from './recordare-identity.service';

const POLL_MS = Number(process.env.RECORDARE_OUTBOX_POLL_MS) || 3_000;
const BATCH_ROWS = 500;

interface OutboxRow {
  id: string;
  userId: string;
  chatId: string;
  messageId: string | null;
  op: OutboxOp;
  attempts: number;
}

export interface DrainResult { sent: number; retried: number; parked: number; dropped: number }

@Injectable()
export class RecordareOutboxService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RecordareOutboxService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly identity: RecordareIdentityService,
  ) {}

  onModuleInit(): void {
    if (!recordareClient()) return;
    this.timer = setInterval(() => void this.tick(), POLL_MS);
    this.timer.unref();
    this.logger.log('Recordare outbox worker started');
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try { await this.drain(); } catch (err: any) {
      this.logger.warn(`outbox drain failed: ${err?.message ?? err}`);
    } finally { this.running = false; }
  }

  /**
   * Best-effort: sends what is pending for one chat right now, bounded by a
   * timeout (used before a Recordare read, so the conversation is known there).
   * Never throws.
   */
  async flushChat(chatId: string, timeoutMs = 3_000): Promise<void> {
    if (!recordareClient()) return;
    let t: NodeJS.Timeout | undefined;
    await Promise.race([
      this.drain({ chatId }).catch(() => undefined),
      new Promise<void>((r) => { t = setTimeout(r, timeoutMs); }),
    ]);
    if (t) clearTimeout(t);
  }

  /** Processes the due rows (all chats, or one). Exposed for tests and flushChat. */
  async drain(opts: { chatId?: string } = {}): Promise<DrainResult> {
    const result: DrainResult = { sent: 0, retried: 0, parked: 0, dropped: 0 };
    const client = recordareClient();
    if (!client) return result;
    const rows: OutboxRow[] = await this.ds.query(
      `SELECT "id", "userId", "chatId", "messageId", "op", "attempts" FROM "recordare_outbox"
        WHERE "parkedAt" IS NULL AND "nextAttemptAt" <= now() ${opts.chatId ? 'AND "chatId" = $2' : ''}
        ORDER BY "id" LIMIT $1`,
      opts.chatId ? [BATCH_ROWS, opts.chatId] : [BATCH_ROWS],
    );
    const byChat = new Map<string, OutboxRow[]>();
    for (const r of rows) byChat.set(r.chatId, [...(byChat.get(r.chatId) ?? []), r]);

    for (const [chatId, chatRows] of byChat) {
      const messageRows = chatRows.filter((r) => r.op === 'message');
      if (messageRows.length) await this.sendMessages(client, chatId, messageRows, result);
      for (const r of chatRows.filter((x) => x.op !== 'message')) await this.sendDeletion(client, r, result);
    }
    return result;
  }

  private async sendMessages(client: RecordareClient, chatId: string, rows: OutboxRow[], result: DrainResult): Promise<void> {
    const [chat]: IngestChat[] = await this.ds.query(
      `SELECT "id", "title", "userId", "externalSource" FROM "chats" WHERE "id" = $1`, [chatId]);
    const ids = rows.map((r) => r.messageId).filter((x): x is string => !!x);
    const messages: IngestMessage[] = chat
      ? await this.ds.query(
        `SELECT "id", "role", "content", "toolCalls", "authorId", "createdAt" FROM "messages"
          WHERE "chatId" = $1 AND "id" = ANY($2::uuid[])`, [chatId, ids])
      : [];
    if (!chat || !messages.length) {
      // Chat or messages deleted meanwhile: nothing to send (deletions have their own rows).
      await this.remove(rows.map((r) => r.id));
      result.dropped += rows.length;
      return;
    }
    const userIds = [...new Set([chat.userId, ...messages.map((m) => m.authorId).filter((x): x is string => !!x)])];
    const users: Array<{ id: string; name: string | null }> = await this.ds.query(
      `SELECT "id", "name" FROM "users" WHERE "id" = ANY($1::uuid[])`, [userIds]);
    const names = new Map(users.filter((u) => u.name).map((u) => [u.id, u.name as string]));
    const body = buildIngestBody(chat, messages.map((m) => ({ ...m, createdAt: new Date(m.createdAt) })), names, APP_NAME);

    try {
      await client.ingest(chat.userId, body);
      await this.remove(rows.map((r) => r.id));
      result.sent += rows.length;
      // Store / name the person on first contact (background, cached afterwards).
      this.identity.cachedOwnerId(chat.userId);
    } catch (err) {
      await this.fail(rows, err, result);
    }
  }

  private async sendDeletion(client: RecordareClient, row: OutboxRow, result: DrainResult): Promise<void> {
    try {
      // Deleting what Recordare never had (404) counts as done.
      if (row.op === 'delete_conversation') await client.deleteConversation(row.userId, row.chatId);
      else await client.deleteMessage(row.userId, row.chatId, row.messageId ?? '');
      await this.remove([row.id]);
      result.sent += 1;
    } catch (err) {
      await this.fail([row], err, result);
    }
  }

  private async remove(ids: string[]): Promise<void> {
    if (ids.length) await this.ds.query(`DELETE FROM "recordare_outbox" WHERE "id" = ANY($1::bigint[])`, [ids]);
  }

  private async fail(rows: OutboxRow[], err: any, result: DrainResult): Promise<void> {
    const message = String(err?.message ?? err).slice(0, 500);
    let permanent = false;
    for (const r of rows) {
      const attempts = r.attempts + 1;
      const next = afterFailure(err, attempts);
      if (next.action === 'park') {
        permanent ||= next.reason === 'rejected';
        await this.ds.query(
          `UPDATE "recordare_outbox" SET "attempts" = $2, "lastError" = $3, "parkedAt" = now() WHERE "id" = $1`,
          [r.id, attempts, message]);
        result.parked += 1;
        this.logger.warn(`outbox row ${r.id} (${r.op}, chat ${r.chatId}) parked after ${attempts} attempt(s): ${message}`);
      } else {
        await this.ds.query(
          `UPDATE "recordare_outbox" SET "attempts" = $2, "lastError" = $3,
                  "nextAttemptAt" = now() + ($4::int * interval '1 millisecond') WHERE "id" = $1`,
          [r.id, attempts, message, next.delayMs]);
        result.retried += 1;
      }
    }
    if (!permanent) this.logger.debug(`outbox: ${rows.length} row(s) will be retried: ${message}`);
  }
}
