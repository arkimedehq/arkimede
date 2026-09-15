// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Wyoming conversation agent ("handle" program): the user identity the voice
 * hub acts as, and the optional agent whose instructions/tools/model apply.
 *   - wyomingHandleUserId  (null = conversation not exposed, STT/TTS only)
 *   - wyomingHandleAgentId (null = standard pipeline of that user)
 *
 * New migration (not editing an applied one). IF NOT EXISTS → idempotent.
 */
export class WyomingHandle1786700000085 implements MigrationInterface {
  name = 'WyomingHandle1786700000085';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "wyomingHandleUserId" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "wyomingHandleAgentId" uuid`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "app_config" DROP COLUMN IF EXISTS "wyomingHandleAgentId"`);
    await queryRunner.query(`ALTER TABLE "app_config" DROP COLUMN IF EXISTS "wyomingHandleUserId"`);
  }
}
