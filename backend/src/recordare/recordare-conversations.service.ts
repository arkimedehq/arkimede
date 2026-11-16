// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file recordare-conversations.service.ts
 *
 * Tells Recordare when a conversation ended (INTEGRATION.md §3: "when a conversation ends on your side, say so"):
 * its extraction then runs at once instead of after Recordare's own idle delay. Arkimede's chats do not close — a
 * voice conversation lapses, an app chat is just left — so a chat whose last message is older than END_IDLE_MS and
 * fully sent (nothing left in the outbox) is ended, once; a later message makes it a conversation again, ended again
 * when it goes quiet. Only the chats of users whose memory is on, from the last week. Never on the request path.
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RecordareHttpError, type RecordareClient } from '@arkimedehq/recordare-client';
import { recordareClient } from './recordare.config';

/** A chat quiet this long has ended. */
export const END_IDLE_MS = 30 * 60_000;
const SWEEP_MS = 5 * 60_000;
const LOOKBACK_MS = 7 * 86_400_000;
const BATCH = 50;

@Injectable()
export class RecordareConversationsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RecordareConversationsService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  client: () => RecordareClient | null = recordareClient;

  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.sweep(), SWEEP_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Ends the quiet conversations; returns how many. */
  async sweep(now = Date.now()): Promise<number> {
    const client = this.client();
    if (!client || this.running) return 0;
    this.running = true;
    let ended = 0;
    try {
      const rows: Array<{ id: string; userId: string }> = await this.ds.query(
        `SELECT c."id", c."userId" FROM "chats" c
           JOIN "users" u ON u."id" = c."userId" AND u."episodicMemoryEnabled" = true
           JOIN LATERAL (SELECT max(m."createdAt") AS "last" FROM "messages" m WHERE m."chatId" = c."id") lm ON true
          WHERE lm."last" IS NOT NULL AND lm."last" < $1 AND lm."last" > $2
            AND (c."memoryEndedAt" IS NULL OR c."memoryEndedAt" < lm."last")
            AND NOT EXISTS (SELECT 1 FROM "recordare_outbox" o WHERE o."chatId" = c."id")
          LIMIT ${BATCH}`,
        [new Date(now - END_IDLE_MS), new Date(now - LOOKBACK_MS)],
      );
      for (const r of rows) {
        try {
          await client.endConversation(r.userId, r.id);
        } catch (err) {
          // A conversation Recordare never had is done; anything else is tried again at the next sweep.
          if (!(err instanceof RecordareHttpError && err.status === 404)) {
            this.logger.warn(`Recordare end of conversation ${r.id} failed: ${(err as Error).message}`);
            continue;
          }
        }
        await this.ds.query(`UPDATE "chats" SET "memoryEndedAt" = $2 WHERE "id" = $1`, [r.id, new Date(now)]);
        ended++;
      }
      if (ended) this.logger.log(`Recordare: ${ended} conversation(s) ended`);
    } catch (err) {
      this.logger.warn(`Recordare end of conversations: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
    return ended;
  }
}
