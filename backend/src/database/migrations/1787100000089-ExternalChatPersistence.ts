// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Opt-in persistence of conversations coming from external entry points
 * (chats/external-chats.service.ts):
 *   - chats.externalSource / externalKey: which entry point produced the chat and
 *     the conversation key inside it (used to append later turns to the same chat).
 *   - api_keys.persistConversations: per-key toggle for the OpenAI-compatible shim.
 *   - app_config.wyomingPersistConversations: toggle for the Wyoming conversation agent.
 *
 * New migration (not editing an applied one). IF NOT EXISTS → idempotent.
 */
export class ExternalChatPersistence1787100000089 implements MigrationInterface {
  name = 'ExternalChatPersistence1787100000089';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "chats" ADD COLUMN IF NOT EXISTS "externalSource" varchar(20) NULL`);
    await queryRunner.query(`ALTER TABLE "chats" ADD COLUMN IF NOT EXISTS "externalKey" varchar(200) NULL`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_chats_external" ON "chats" ("userId", "externalSource", "externalKey") WHERE "externalSource" IS NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "persistConversations" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "wyomingPersistConversations" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "app_config" DROP COLUMN IF EXISTS "wyomingPersistConversations"`);
    await queryRunner.query(`ALTER TABLE "api_keys" DROP COLUMN IF EXISTS "persistConversations"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_chats_external"`);
    await queryRunner.query(`ALTER TABLE "chats" DROP COLUMN IF EXISTS "externalKey"`);
    await queryRunner.query(`ALTER TABLE "chats" DROP COLUMN IF EXISTS "externalSource"`);
  }
}
