import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds app_config.sandboxNetwork ('none' | 'egress' | 'open', default 'none').
 *
 * Separate migration because 1784600000063-SandboxConfig had already been applied on
 * some DBs before the field was introduced: an already-executed migration is not
 * re-run, so the new field goes into a new migration. IF NOT EXISTS
 * makes it idempotent on fresh DBs (where 063 already created it).
 *
 * name = 'SandboxNetwork1784800000065'
 */
export class SandboxNetwork1784800000065 implements MigrationInterface {
  name = 'SandboxNetwork1784800000065';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "sandboxNetwork" varchar(10) NOT NULL DEFAULT 'none'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "app_config" DROP COLUMN IF EXISTS "sandboxNetwork"`);
  }
}
