// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-automation token cap (scheduling/scheduling.service.ts):
 *   - scheduled_tasks.maxTokensPerRun: NULL = use the global SCHED_MAX_TOKENS_PER_RUN,
 *     0 = no cap, N > 0 = disable the automation when a run exceeds N tokens.
 *
 * New migration (not editing an applied one). IF NOT EXISTS → idempotent.
 */
export class ScheduledTaskTokenCap1787000000088 implements MigrationInterface {
  name = 'ScheduledTaskTokenCap1787000000088';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "scheduled_tasks" ADD COLUMN IF NOT EXISTS "maxTokensPerRun" integer NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "scheduled_tasks" DROP COLUMN IF EXISTS "maxTokensPerRun"`);
  }
}
