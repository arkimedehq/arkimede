// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the text-to-speech (Piper) configuration columns to app_config,
 * mirroring the transcription* provider pattern:
 *   - ttsProvider (nullable: null = unset → env fallback TTS_PROVIDER)
 *   - ttsModel, ttsApiKey (encrypted), ttsBaseUrl, ttsVoice
 *
 * New migration (not editing an applied one). IF NOT EXISTS → idempotent.
 */
export class TtsConfig1786400000082 implements MigrationInterface {
  name = 'TtsConfig1786400000082';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "ttsProvider" varchar(50)`,
    );
    await queryRunner.query(
      `ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "ttsModel" varchar(200)`,
    );
    await queryRunner.query(
      `ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "ttsApiKey" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "ttsBaseUrl" varchar(500)`,
    );
    await queryRunner.query(
      `ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "ttsVoice" varchar(200)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "app_config" DROP COLUMN IF EXISTS "ttsVoice"`);
    await queryRunner.query(`ALTER TABLE "app_config" DROP COLUMN IF EXISTS "ttsBaseUrl"`);
    await queryRunner.query(`ALTER TABLE "app_config" DROP COLUMN IF EXISTS "ttsApiKey"`);
    await queryRunner.query(`ALTER TABLE "app_config" DROP COLUMN IF EXISTS "ttsModel"`);
    await queryRunner.query(`ALTER TABLE "app_config" DROP COLUMN IF EXISTS "ttsProvider"`);
  }
}
