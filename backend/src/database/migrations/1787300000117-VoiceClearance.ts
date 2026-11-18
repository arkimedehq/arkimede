// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Sensitive actions by voice only for a recognised voice (voice-id/voice-clearance.ts): app_config.voiceClearance —
 * the policy (off, threshold, people, protected tools and entities) — and scheduled_tasks.voiceClearance — who spoke
 * when an automation was asked for by voice, so its runs are checked as that turn was. Null = off / not by voice.
 *
 * name = 'VoiceClearance1787300000117'
 */
export class VoiceClearance1787300000117 implements MigrationInterface {
  name = 'VoiceClearance1787300000117';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "voiceClearance" jsonb DEFAULT NULL`);
    await queryRunner.query(`ALTER TABLE "scheduled_tasks" ADD COLUMN IF NOT EXISTS "voiceClearance" jsonb DEFAULT NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "scheduled_tasks" DROP COLUMN IF EXISTS "voiceClearance"`);
    await queryRunner.query(`ALTER TABLE "app_config" DROP COLUMN IF EXISTS "voiceClearance"`);
  }
}
