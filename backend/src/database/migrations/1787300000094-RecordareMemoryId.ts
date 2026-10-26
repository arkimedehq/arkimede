// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * users.recordareOwnerId → users.recordareMemoryId: Recordare names a memory a memory, not an owner (its WORK_PLAN
 * 8.10; `GET api/v1/me` returns `memoryId`). Rename only, the stored ids stay.
 *
 * New migration (not editing an applied one). Guarded → idempotent.
 */
export class RecordareMemoryId1787300000094 implements MigrationInterface {
  name = 'RecordareMemoryId1787300000094';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.rename(queryRunner, 'recordareOwnerId', 'recordareMemoryId');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.rename(queryRunner, 'recordareMemoryId', 'recordareOwnerId');
  }

  private async rename(queryRunner: QueryRunner, from: string, to: string): Promise<void> {
    const [found] = await queryRunner.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = $1`, [from]);
    if (found) await queryRunner.query(`ALTER TABLE "users" RENAME COLUMN "${from}" TO "${to}"`);
  }
}
