// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the MCP anti-SSRF policy to app_config, mirroring the DataSource one:
 *   - mcpAllowPrivateHosts (default true — self-hosted MCP servers live on
 *     LAN/localhost; metadata/link-local stays always blocked in code)
 *   - mcpHostAllowlist (host/IP/CIDR entries allowed even when hardened)
 *
 * Before this policy, http/sse MCP servers were hard-blocked on any private
 * host by the strict ssrf-guard default.
 *
 * New migration (not editing an applied one). IF NOT EXISTS → idempotent.
 */
export class McpSsrfPolicy1786100000079 implements MigrationInterface {
  name = 'McpSsrfPolicy1786100000079';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "mcpAllowPrivateHosts" boolean NOT NULL DEFAULT true`,
    );
    await queryRunner.query(
      `ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "mcpHostAllowlist" jsonb NOT NULL DEFAULT '[]'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "app_config" DROP COLUMN IF EXISTS "mcpAllowPrivateHosts"`);
    await queryRunner.query(`ALTER TABLE "app_config" DROP COLUMN IF EXISTS "mcpHostAllowlist"`);
  }
}
