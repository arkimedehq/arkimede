import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `mode` column to the `skill_scripts` table.
 *
 * mode: 'task' (default) | 'daemon'
 *   task   — one-shot script invoked by the LLM as a tool (current behavior)
 *   daemon — long-running script started by the user, reports events via PUSH_URL
 */
export class AddScriptMode1779700000016 implements MigrationInterface {
  name = 'AddScriptMode1779700000016';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "skill_scripts"
      ADD COLUMN IF NOT EXISTS "mode" varchar(16) NOT NULL DEFAULT 'task'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "skill_scripts"
      DROP COLUMN IF EXISTS "mode"
    `);
  }
}
