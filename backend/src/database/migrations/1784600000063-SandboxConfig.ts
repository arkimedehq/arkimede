import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the sandbox gating fields (arbitrary code/shell execution) to
 * app_config: global master switch + lists of authorized teams/projects.
 * Safe default: disabled, empty lists.
 *
 * name = 'SandboxConfig1784600000063'
 */
export class SandboxConfig1784600000063 implements MigrationInterface {
  name = 'SandboxConfig1784600000063';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "sandboxEnabled" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "sandboxAllowedTeamIds" jsonb NOT NULL DEFAULT '[]'`,
    );
    await queryRunner.query(
      `ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "sandboxAllowedProjectIds" jsonb NOT NULL DEFAULT '[]'`,
    );
    await queryRunner.query(
      `ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "sandboxNetwork" varchar(10) NOT NULL DEFAULT 'none'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "app_config" DROP COLUMN IF EXISTS "sandboxNetwork"`);
    await queryRunner.query(`ALTER TABLE "app_config" DROP COLUMN IF EXISTS "sandboxAllowedProjectIds"`);
    await queryRunner.query(`ALTER TABLE "app_config" DROP COLUMN IF EXISTS "sandboxAllowedTeamIds"`);
    await queryRunner.query(`ALTER TABLE "app_config" DROP COLUMN IF EXISTS "sandboxEnabled"`);
  }
}
