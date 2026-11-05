// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Recordare from the admin's settings (Settings → Memory → Recordare), in place of the environment:
 *   - recordareUrl           — the service's base URL (null = RECORDARE_URL)
 *   - recordareApiKey        — the client's API key, encrypted (null = RECORDARE_API_KEY)
 *   - recordareWebhookSecret — the initiatives webhook's whsec_ secret, encrypted (null = RECORDARE_WEBHOOK_SECRET)
 * Idempotent.
 */
export class RecordareConnection1787300000102 implements MigrationInterface {
  name = 'RecordareConnection1787300000102';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "recordareUrl" varchar(500)`);
    await queryRunner.query(`ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "recordareApiKey" text`);
    await queryRunner.query(`ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "recordareWebhookSecret" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "app_config" DROP COLUMN IF EXISTS "recordareWebhookSecret"`);
    await queryRunner.query(`ALTER TABLE "app_config" DROP COLUMN IF EXISTS "recordareApiKey"`);
    await queryRunner.query(`ALTER TABLE "app_config" DROP COLUMN IF EXISTS "recordareUrl"`);
  }
}
