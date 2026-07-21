import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * loadOnFirst on custom tools (hierarchical delegation — axis orthogonal to exposeAsTool).
 *
 * Adds `custom_tools.loadOnFirst` (default true). If false, the tool is NOT
 * injected into the flat context of the main chat: it remains usable only through an
 * agent that includes it in its own toolFilter. Default true = behavior
 * unchanged for existing tools.
 *
 * name = 'CustomToolLoadOnFirst1782900000047'
 */
export class CustomToolLoadOnFirst1782900000047 implements MigrationInterface {
  name = 'CustomToolLoadOnFirst1782900000047';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE custom_tools ADD COLUMN IF NOT EXISTS "loadOnFirst" boolean NOT NULL DEFAULT true`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE custom_tools DROP COLUMN IF EXISTS "loadOnFirst"`);
  }
}
