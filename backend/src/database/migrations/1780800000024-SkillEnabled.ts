import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `enabled` column to the `skills` table.
 *
 * A skill with enabled=false is excluded from LangGraph tool loading
 * and from injection into the system prompt — identical to the behavior of `custom_tools.enabled`.
 *
 * Default TRUE → existing skills remain active without manual intervention.
 */
export class SkillEnabled1780800000024 implements MigrationInterface {
  name = 'SkillEnabled1780800000024';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "skills"
      ADD COLUMN IF NOT EXISTS "enabled" boolean NOT NULL DEFAULT true
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "skills" DROP COLUMN IF EXISTS "enabled"
    `);
  }
}
