import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: adds the `scope` column to the custom_tools table.
 *
 * scope = 'personal' (default) → tool visible only to the creator
 * scope = 'shared'             → tool visible to everyone; creation reserved to admins
 *
 * Also includes a partial unique index on (name) WHERE scope = 'shared'
 * to guarantee that no two shared tools with the same name exist,
 * regardless of who created them.
 */
export class CustomToolScope1778900000002 implements MigrationInterface {
  name = 'CustomToolScope1778900000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Create the enum type
    await queryRunner.query(`
      CREATE TYPE "public"."custom_tools_scope_enum"
      AS ENUM('personal', 'shared')
    `);

    // Adds the column with DEFAULT 'personal' → backfills all existing records
    await queryRunner.query(`
      ALTER TABLE "custom_tools"
      ADD COLUMN "scope" "public"."custom_tools_scope_enum"
        NOT NULL DEFAULT 'personal'
    `);

    // Partial unique index: no duplicates among shared tools (name globally unique)
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_custom_tools_shared_name"
      ON "custom_tools" ("name")
      WHERE "scope" = 'shared'
    `);

    // Index for frequent query: all enabled shared ones
    await queryRunner.query(`
      CREATE INDEX "IDX_custom_tools_scope_enabled"
      ON "custom_tools" ("scope", "enabled")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_custom_tools_scope_enabled"`);
    await queryRunner.query(`DROP INDEX "UQ_custom_tools_shared_name"`);
    await queryRunner.query(`ALTER TABLE "custom_tools" DROP COLUMN "scope"`);
    await queryRunner.query(`DROP TYPE "public"."custom_tools_scope_enum"`);
  }
}
