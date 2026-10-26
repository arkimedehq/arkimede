// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The A-MEM toggle split and the copies of Recordare notes (Recordare D34):
 *   - users.sharedMemoryEnabled — use the team / org notes, apart from the personal memory (autoMemoryEnabled:
 *     extraction + use of the personal notes). Starts equal to autoMemoryEnabled, so nobody's memory changes today;
 *   - users.recordareCopyCategories — the rule: Recordare notes of these categories are copied into the personal A-MEM;
 *   - users.recordareNotesCursor — how far the user's Recordare notes change feed has been followed;
 *   - user_memory.recordareNoteId — the Recordare note a copy follows (updated, corrected, removed with it).
 *
 * New migration (not editing an applied one). Guarded → idempotent.
 */
export class MemoryToggleSplit1787300000095 implements MigrationInterface {
  name = 'MemoryToggleSplit1787300000095';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const [had] = await queryRunner.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'sharedMemoryEnabled'`);
    await queryRunner.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "sharedMemoryEnabled" boolean NOT NULL DEFAULT false`);
    if (!had) await queryRunner.query(`UPDATE "users" SET "sharedMemoryEnabled" = "autoMemoryEnabled"`);
    await queryRunner.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "recordareCopyCategories" jsonb NOT NULL DEFAULT '[]'`);
    await queryRunner.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "recordareNotesCursor" bigint NOT NULL DEFAULT 0`);
    await queryRunner.query(`ALTER TABLE "user_memory" ADD COLUMN IF NOT EXISTS "recordareNoteId" uuid`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_user_memory_recordare_note" ON "user_memory" ("userId", "recordareNoteId") WHERE "recordareNoteId" IS NOT NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_user_memory_recordare_note"`);
    await queryRunner.query(`ALTER TABLE "user_memory" DROP COLUMN IF EXISTS "recordareNoteId"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "recordareNotesCursor"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "recordareCopyCategories"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "sharedMemoryEnabled"`);
  }
}
