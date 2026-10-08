// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file recordare-outbox.ts
 *
 * Enqueue side of the Recordare outbox (`recordare_outbox`): plain functions on
 * a QueryRunner / EntityManager, no DI, so the message subscriber and the
 * deletion call sites can use them without new module dependencies.
 *
 * Rules:
 *   - no-op when Recordare is not configured (one env check, no query);
 *   - messages are enqueued only for chats whose OWNER has episodicMemoryEnabled
 *     (the gate is part of the INSERT … SELECT: one statement, no extra read);
 *   - deletions are enqueued when the owner has the switch on OR was ever
 *     provisioned in Recordare (recordareOwnerId set), so turning the switch off
 *     does not leave deleted messages behind in Recordare;
 *   - no message is buffered before consent: owners whose Recordare consent is
 *     KNOWN to be off (cached by RecordareIdentityService) are skipped in the
 *     same statement; when unknown, the message is enqueued (Recordare answers
 *     stored:false and the row is dropped);
 *   - error turns saved by the chat (inside withoutRecordareIngest) are skipped;
 *   - an enqueue failure is logged and swallowed: it must never fail the chat.
 *     Inside a transaction it runs under a SAVEPOINT, so a failed INSERT cannot
 *     abort the caller's transaction.
 */
import { AsyncLocalStorage } from 'async_hooks';
import { Logger } from '@nestjs/common';
import type { EntityManager, QueryRunner } from 'typeorm';
import { recordareConfig } from './recordare.config';

export type OutboxOp = 'message' | 'delete_message' | 'delete_conversation';

const logger = new Logger('RecordareOutbox');

const ENQUEUE_MESSAGE_SQL = `
  INSERT INTO "recordare_outbox" ("userId", "chatId", "messageId", "op")
  SELECT c."userId", c."id", $1::uuid, 'message'
    FROM "chats" c JOIN "users" u ON u."id" = c."userId"
   WHERE c."id" = $2 AND u."episodicMemoryEnabled" = true AND NOT (c."userId" = ANY($3::uuid[]))`;

const ENQUEUE_MESSAGE_DELETES_SQL = `
  INSERT INTO "recordare_outbox" ("userId", "chatId", "messageId", "op")
  SELECT c."userId", c."id", m.id, 'delete_message'
    FROM "chats" c JOIN "users" u ON u."id" = c."userId", unnest($2::uuid[]) AS m(id)
   WHERE c."id" = $1 AND (u."episodicMemoryEnabled" = true OR u."recordareOwnerId" IS NOT NULL)`;

const ENQUEUE_CONVERSATION_DELETE_SQL = `
  INSERT INTO "recordare_outbox" ("userId", "chatId", "op")
  SELECT c."userId", c."id", 'delete_conversation'
    FROM "chats" c JOIN "users" u ON u."id" = c."userId"
   WHERE c."id" = $1 AND (u."episodicMemoryEnabled" = true OR u."recordareOwnerId" IS NOT NULL)`;

let savepointSeq = 0;

/** User ids whose Recordare consent is known to be off (registered by RecordareIdentityService). */
let consentOffProvider: () => string[] = () => [];

export function setConsentOffProvider(fn: (() => string[]) | null): void {
  consentOffProvider = fn ?? (() => []);
}

/** Marks message saves that must not reach Recordare (the chat's error turns). */
const skipIngest = new AsyncLocalStorage<true>();

/** Runs `fn` so that the messages it persists are NOT sent to Recordare. */
export function withoutRecordareIngest<T>(fn: () => T): T {
  return skipIngest.run(true, fn);
}

/** Runs one enqueue statement without ever failing the caller (savepoint inside transactions). */
async function enqueueSafely(runner: QueryRunner | EntityManager, sql: string, params: unknown[]): Promise<void> {
  const qr = (runner as EntityManager).queryRunner ?? (runner as QueryRunner);
  const inTx = !!(qr as QueryRunner)?.isTransactionActive;
  const run = (q: string, p?: unknown[]) => runner.query(q, p);
  if (!inTx) {
    try { await run(sql, params); } catch (err: any) { logger.warn(`enqueue failed: ${err?.message ?? err}`); }
    return;
  }
  const sp = `recordare_outbox_${++savepointSeq}`;
  try {
    await run(`SAVEPOINT ${sp}`);
  } catch (err: any) {
    logger.warn(`enqueue skipped (savepoint): ${err?.message ?? err}`);
    return;
  }
  try {
    await run(sql, params);
    await run(`RELEASE SAVEPOINT ${sp}`);
  } catch (err: any) {
    logger.warn(`enqueue failed: ${err?.message ?? err}`);
    await run(`ROLLBACK TO SAVEPOINT ${sp}`).catch(() => undefined);
  }
}

/** A message was persisted (called by the Message subscriber, same transaction). */
export async function enqueueRecordareMessage(
  runner: QueryRunner | EntityManager,
  message: { id?: string; chatId?: string; role?: string },
): Promise<void> {
  if (!recordareConfig() || !message?.id || !message.chatId || message.role === 'system') return;
  if (skipIngest.getStore()) return;
  let consentOff: string[] = [];
  try { consentOff = consentOffProvider(); } catch { /* unknown → enqueue as usual */ }
  await enqueueSafely(runner, ENQUEUE_MESSAGE_SQL, [message.id, message.chatId, consentOff]);
}

/** Messages of a chat were deleted (rewind / truncate). */
export async function enqueueRecordareMessageDeletes(manager: EntityManager, chatId: string, messageIds: string[]): Promise<void> {
  if (!recordareConfig() || !messageIds.length) return;
  await enqueueSafely(manager, ENQUEUE_MESSAGE_DELETES_SQL, [chatId, messageIds]);
}

/** A chat is about to be deleted: call BEFORE deleting it (the owner is read from the chat row). */
export async function enqueueRecordareConversationDelete(manager: EntityManager, chatId: string): Promise<void> {
  if (!recordareConfig()) return;
  await enqueueSafely(manager, ENQUEUE_CONVERSATION_DELETE_SQL, [chatId]);
}
