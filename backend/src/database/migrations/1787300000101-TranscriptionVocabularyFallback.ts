// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Voice transcription: a vocabulary and a local fallback.
 *   - transcriptionVocabularyEnabled — pass the expected words to the model as its prompt (default off)
 *   - transcriptionVocabulary        — the admin's own words (places, rooms, devices), one per line or comma-separated
 *   - transcriptionFallbackModel     — a model of the bundled service used when a cloud provider fails (null = none)
 * Idempotent.
 */
export class TranscriptionVocabularyFallback1787300000101 implements MigrationInterface {
  name = 'TranscriptionVocabularyFallback1787300000101';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "transcriptionVocabularyEnabled" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(`ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "transcriptionVocabulary" text`);
    await queryRunner.query(`ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "transcriptionFallbackModel" varchar(200)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "app_config" DROP COLUMN IF EXISTS "transcriptionFallbackModel"`);
    await queryRunner.query(`ALTER TABLE "app_config" DROP COLUMN IF EXISTS "transcriptionVocabulary"`);
    await queryRunner.query(`ALTER TABLE "app_config" DROP COLUMN IF EXISTS "transcriptionVocabularyEnabled"`);
  }
}
