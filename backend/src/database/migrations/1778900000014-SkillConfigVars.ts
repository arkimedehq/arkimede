import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: adds the variable configuration system for Skills.
 *
 * Changes:
 *   1. Column `configSpec` (JSONB) in the `skills` table — spec declared in skill.yaml
 *   2. New table `skill_config_vars` — values set by the user for each instance
 */
export class SkillConfigVars1778900000014 implements MigrationInterface {
  name = 'SkillConfigVars1778900000014';

  async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Add configSpec column to the skills table
    await queryRunner.query(`
      ALTER TABLE skills
      ADD COLUMN IF NOT EXISTS "configSpec" JSONB DEFAULT NULL
    `);

    // 2. Create the skill_config_vars table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS skill_config_vars (
        id          UUID          NOT NULL DEFAULT gen_random_uuid(),
        "skillId"   UUID          NOT NULL,
        key         VARCHAR(128)  NOT NULL,
        value       TEXT,
        "isSecret"  BOOLEAN       NOT NULL DEFAULT false,
        "createdAt" TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

        CONSTRAINT PK_skill_config_vars PRIMARY KEY (id),
        CONSTRAINT FK_skill_config_vars_skill
          FOREIGN KEY ("skillId") REFERENCES skills(id) ON DELETE CASCADE,
        CONSTRAINT UQ_skill_config_vars_skill_key
          UNIQUE ("skillId", key)
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS IDX_skill_config_vars_skill
      ON skill_config_vars ("skillId")
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS IDX_skill_config_vars_skill`);
    await queryRunner.query(`DROP TABLE IF EXISTS skill_config_vars`);
    await queryRunner.query(`ALTER TABLE skills DROP COLUMN IF EXISTS "configSpec"`);
  }
}
