import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Propagates `loadOnFirst` to the other three tool types: flow, skill, mcp server.
 *
 * Same semantics as custom_tools.loadOnFirst (migration …047): if false, the tools
 * of the resource do not enter the flat context of the main chat and remain
 * usable only via an agent. Default true = behavior unchanged for existing
 * data.
 *
 * name = 'LoadOnFirstAllTools1782900000048'
 */
export class LoadOnFirstAllTools1782900000048 implements MigrationInterface {
  name = 'LoadOnFirstAllTools1782900000048';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE flows ADD COLUMN IF NOT EXISTS "loadOnFirst" boolean NOT NULL DEFAULT true`);
    await queryRunner.query(`ALTER TABLE skills ADD COLUMN IF NOT EXISTS "loadOnFirst" boolean NOT NULL DEFAULT true`);
    await queryRunner.query(`ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS "loadOnFirst" boolean NOT NULL DEFAULT true`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE flows DROP COLUMN IF EXISTS "loadOnFirst"`);
    await queryRunner.query(`ALTER TABLE skills DROP COLUMN IF EXISTS "loadOnFirst"`);
    await queryRunner.query(`ALTER TABLE mcp_servers DROP COLUMN IF EXISTS "loadOnFirst"`);
  }
}
