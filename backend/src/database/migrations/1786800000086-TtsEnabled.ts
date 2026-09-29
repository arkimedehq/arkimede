// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Text-to-speech global toggle (read-aloud button, speech route, Wyoming TTS).
 *   - ttsEnabled (default true: TTS was always on before this column existed)
 *
 * New migration (not editing an applied one). IF NOT EXISTS → idempotent.
 */
export class TtsEnabled1786800000086 implements MigrationInterface {
  name = 'TtsEnabled1786800000086';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "ttsEnabled" boolean NOT NULL DEFAULT true`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "app_config" DROP COLUMN IF EXISTS "ttsEnabled"`);
  }
}
