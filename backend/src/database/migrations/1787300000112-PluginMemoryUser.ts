// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * plugins.memoryUserId (uuid, null): whose memory an organization or team plugin's perceptions and presences go to —
 * the user the admin chose; null = none chosen (those services answer unavailable).
 *
 * name = 'PluginMemoryUser1787300000112'
 */
export class PluginMemoryUser1787300000112 implements MigrationInterface {
  name = 'PluginMemoryUser1787300000112';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "plugins" ADD COLUMN IF NOT EXISTS "memoryUserId" uuid REFERENCES "users"("id") ON DELETE SET NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "plugins" DROP COLUMN IF EXISTS "memoryUserId"`);
  }
}
