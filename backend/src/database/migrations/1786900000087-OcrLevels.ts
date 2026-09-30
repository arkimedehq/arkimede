// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Document OCR levels (ocr/ocr.service.ts):
 *   - ocrDefaultLevel (default 'fast': local Tesseract via the ocr-service)
 *   - ocrMaxLevel     (default 'vision': every level allowed)
 *
 * New migration (not editing an applied one). IF NOT EXISTS → idempotent.
 */
export class OcrLevels1786900000087 implements MigrationInterface {
  name = 'OcrLevels1786900000087';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "ocrDefaultLevel" varchar(20) NOT NULL DEFAULT 'fast'`,
    );
    await queryRunner.query(
      `ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "ocrMaxLevel" varchar(20) NOT NULL DEFAULT 'vision'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "app_config" DROP COLUMN IF EXISTS "ocrMaxLevel"`);
    await queryRunner.query(`ALTER TABLE "app_config" DROP COLUMN IF EXISTS "ocrDefaultLevel"`);
  }
}
