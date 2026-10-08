// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Recordare as the users' episodic memory (src/recordare/):
 *   - users.episodicMemoryEnabled: per-user switch (default OFF), separate from
 *     autoMemoryEnabled (A-MEM, unchanged) — gates ingest and the Recordare tools.
 *   - users.recordareOwnerId: the person's ownerId in Recordare (GET api/v1/me),
 *     cached once known; null = not provisioned yet.
 *   - recordare_outbox: persist-then-send queue of ingest operations (messages,
 *     message / conversation deletions). No FK to chats/messages on purpose: a
 *     deletion must outlive the rows it refers to.
 *
 * New migration (not editing an applied one). IF NOT EXISTS → idempotent.
 */
export class RecordareMemory1787200000090 implements MigrationInterface {
  name = 'RecordareMemory1787200000090';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "episodicMemoryEnabled" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "recordareOwnerId" varchar(64) NULL`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "recordare_outbox" (
        "id"            bigserial PRIMARY KEY,
        "userId"        uuid NOT NULL,
        "chatId"        uuid NOT NULL,
        "messageId"     uuid NULL,
        "op"            varchar(30) NOT NULL,
        "attempts"      int NOT NULL DEFAULT 0,
        "nextAttemptAt" timestamptz NOT NULL DEFAULT now(),
        "lastError"     varchar(500) NULL,
        "parkedAt"      timestamptz NULL,
        "createdAt"     timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_recordare_outbox_due" ON "recordare_outbox" ("nextAttemptAt") WHERE "parkedAt" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "recordare_outbox"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "recordareOwnerId"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "episodicMemoryEnabled"`);
  }
}
