// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * app_config.haBusyEnabled (boolean, default false): with Home Assistant's presence on, a person whose phone says they
 * are busy (a call, do-not-disturb, a Focus) is told to the memory as busy (presence impulses `busy`). Off by default:
 * the impulses stay as they were.
 *
 * name = 'HaBusy1787300000107'
 */
export class HaBusy1787300000107 implements MigrationInterface {
  name = 'HaBusy1787300000107';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "haBusyEnabled" boolean NOT NULL DEFAULT false`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "app_config" DROP COLUMN IF EXISTS "haBusyEnabled"`);
  }
}
