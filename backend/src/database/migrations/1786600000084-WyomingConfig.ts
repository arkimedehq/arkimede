// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the Wyoming voice-server configuration to app_config:
 *   - wyomingEnabled      (default false: the TCP listener is opt-in)
 *   - wyomingAllowedCidrs (comma-separated IPv4/CIDR allowlist; empty = any client)
 *
 * The listening port is deployment-level (env WYOMING_PORT, mirrored by the
 * docker-compose port mapping) and is therefore NOT stored here.
 *
 * New migration (not editing an applied one). IF NOT EXISTS → idempotent.
 */
export class WyomingConfig1786600000084 implements MigrationInterface {
  name = 'WyomingConfig1786600000084';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "wyomingEnabled" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "wyomingAllowedCidrs" varchar(1000)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "app_config" DROP COLUMN IF EXISTS "wyomingAllowedCidrs"`);
    await queryRunner.query(`ALTER TABLE "app_config" DROP COLUMN IF EXISTS "wyomingEnabled"`);
  }
}
