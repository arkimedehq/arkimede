import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds skills.sandboxRuns (int, default 0): counter of SUCCESSFUL sandbox
 * executions attributed to a descriptive skill (input.code referencing
 * `skills/<name>/`). At the threshold the owner gets a "compile to tool"
 * suggestion (notification + badge); the counter resets after compilation.
 *
 * name = 'SkillSandboxRuns1784900000066'
 */
export class SkillSandboxRuns1784900000066 implements MigrationInterface {
  name = 'SkillSandboxRuns1784900000066';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "sandboxRuns" integer NOT NULL DEFAULT 0`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "skills" DROP COLUMN IF EXISTS "sandboxRuns"`);
  }
}
