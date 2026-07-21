import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * History compaction trigger threshold, configurable by the admin.
 *
 *   - app_config.historyCompactionThreshold  — % of maxHistoryTokens beyond which
 *                                              compaction is triggered (default 80)
 *
 * Migration separate from HistoryCompaction1781400000030 because that one may
 * already have been executed before this field was introduced.
 */
export class HistoryCompactionThreshold1781500000031 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(
      `ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "historyCompactionThreshold" int NOT NULL DEFAULT 80`,
    );
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE "app_config" DROP COLUMN IF EXISTS "historyCompactionThreshold"`);
  }
}
