import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tokens consumed by the last run of an automation (cost accounting, Option 6).
 *
 * name = 'ScheduledTaskTokens1783100000047'
 */
export class ScheduledTaskTokens1783100000047 implements MigrationInterface {
  name = 'ScheduledTaskTokens1783100000047';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS "lastInputTokens" int`);
    await queryRunner.query(`ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS "lastOutputTokens" int`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE scheduled_tasks DROP COLUMN IF EXISTS "lastOutputTokens"`);
    await queryRunner.query(`ALTER TABLE scheduled_tasks DROP COLUMN IF EXISTS "lastInputTokens"`);
  }
}
