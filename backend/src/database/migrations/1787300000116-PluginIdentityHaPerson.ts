// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One of a plugin's people linked to a Home Assistant person (plugin_identities.haPerson), with or without an account:
 * the memory, the presence and `say` then know them as that person — as a voice profile's haPerson does. Null for the
 * existing ones (an account's own haPerson keeps applying).
 *
 * name = 'PluginIdentityHaPerson1787300000116'
 */
export class PluginIdentityHaPerson1787300000116 implements MigrationInterface {
  name = 'PluginIdentityHaPerson1787300000116';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "plugin_identities" ADD COLUMN IF NOT EXISTS "haPerson" varchar(255)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "plugin_identities" DROP COLUMN IF EXISTS "haPerson"`);
  }
}
