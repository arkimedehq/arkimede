import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Micro-task auto-scheduling: tool-subset for headless runs + cost guardrail.
 *
 * - `toolFilter` (jsonb): which tools the headless run loads (default `none`).
 * - `totalTokens` (bigint): cumulative tokens across all runs (accounting + cap).
 *
 * name = 'ScheduledTaskToolsCost1783200000048'
 */
export class ScheduledTaskToolsCost1783200000048 implements MigrationInterface {
  name = 'ScheduledTaskToolsCost1783200000048';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS "toolFilter" jsonb NOT NULL DEFAULT '{"mode":"none"}'`);
    await queryRunner.query(`ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS "totalTokens" bigint NOT NULL DEFAULT 0`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE scheduled_tasks DROP COLUMN IF EXISTS "totalTokens"`);
    await queryRunner.query(`ALTER TABLE scheduled_tasks DROP COLUMN IF EXISTS "toolFilter"`);
  }
}
