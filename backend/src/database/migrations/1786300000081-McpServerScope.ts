// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds visibility scope to MCP servers (mirrors custom tools / skills / agents):
 *   - scope  ('personal' | 'team' | 'org', default 'personal')
 *   - teamId (uuid, set when scope='team')
 *
 * Before this, every MCP server was personal-only, forcing a shared server to
 * be duplicated per user (e.g. a Home Assistant server for a voice account).
 *
 * New migration (not editing an applied one). IF NOT EXISTS → idempotent.
 */
export class McpServerScope1786300000081 implements MigrationInterface {
  name = 'McpServerScope1786300000081';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "scope" varchar(16) NOT NULL DEFAULT 'personal'`,
    );
    await queryRunner.query(
      `ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "teamId" uuid`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_mcp_servers_scope" ON "mcp_servers" ("scope")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_mcp_servers_scope"`);
    await queryRunner.query(`ALTER TABLE "mcp_servers" DROP COLUMN IF EXISTS "teamId"`);
    await queryRunner.query(`ALTER TABLE "mcp_servers" DROP COLUMN IF EXISTS "scope"`);
  }
}
