// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Personal and shared extensions (specs/EXTENSION_AUDIENCE.md):
 *   - skills.audience, plugins.audience ('shared' unless declared: every existing extension stays as it is);
 *   - custom_tools.personal, mcp_servers.personal (the "Personal" option, off);
 *   - plugins: one copy per (name, owner) instead of one per name — each user has their own copy of a personal plugin;
 *   - plugins.memoryUserId goes: a plugin's memory is always its owner's (only personal plugins write to a memory).
 *
 * name = 'ExtensionAudience1787300000113'
 */
export class ExtensionAudience1787300000113 implements MigrationInterface {
  name = 'ExtensionAudience1787300000113';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "audience" varchar(16) NOT NULL DEFAULT 'shared'`);
    await queryRunner.query(`ALTER TABLE "plugins" ADD COLUMN IF NOT EXISTS "audience" varchar(16) NOT NULL DEFAULT 'shared'`);
    await queryRunner.query(`ALTER TABLE "custom_tools" ADD COLUMN IF NOT EXISTS "personal" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(`ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "personal" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(`ALTER TABLE "plugins" DROP CONSTRAINT IF EXISTS "plugins_name_key"`);
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'UQ_plugins_name_owner') THEN
          ALTER TABLE "plugins" ADD CONSTRAINT "UQ_plugins_name_owner" UNIQUE ("name", "ownerId");
        END IF;
      END $$`);
    await queryRunner.query(`ALTER TABLE "plugins" DROP COLUMN IF EXISTS "memoryUserId"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "plugins" ADD COLUMN IF NOT EXISTS "memoryUserId" uuid REFERENCES "users"("id") ON DELETE SET NULL`);
    await queryRunner.query(`ALTER TABLE "plugins" DROP CONSTRAINT IF EXISTS "UQ_plugins_name_owner"`);
    await queryRunner.query(`ALTER TABLE "plugins" ADD CONSTRAINT "plugins_name_key" UNIQUE ("name")`);
    for (const [t, c] of [['mcp_servers', 'personal'], ['custom_tools', 'personal'], ['plugins', 'audience'], ['skills', 'audience']]) {
      await queryRunner.query(`ALTER TABLE "${t}" DROP COLUMN IF EXISTS "${c}"`);
    }
  }
}
