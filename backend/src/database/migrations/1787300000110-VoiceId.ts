// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Voice recognition (voice-id/): voice_profiles — the voices the house knows (a name, optionally a Home Assistant
 * person and an Arkimede user, the encrypted voiceprint samples) — and app_config.voiceIdEnabled (default off: no
 * voiceprint is computed, every turn as before).
 *
 * name = 'VoiceId1787300000110'
 */
export class VoiceId1787300000110 implements MigrationInterface {
  name = 'VoiceId1787300000110';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "voice_profiles" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "name" varchar(100) NOT NULL,
        "haPerson" varchar(200),
        "userId" uuid REFERENCES "users"("id") ON DELETE SET NULL,
        "samples" text,
        "sampleCount" int NOT NULL DEFAULT 0,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(`ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "voiceIdEnabled" boolean NOT NULL DEFAULT false`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "app_config" DROP COLUMN IF EXISTS "voiceIdEnabled"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "voice_profiles"`);
  }
}
