// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Voice as a delivery channel of the automations: scheduled_tasks.voice — the outcome is also said aloud on a voice
 * satellite of the user where they are confirmed present (VoiceDeliveryService). Off for the existing ones.
 *
 * name = 'AutomationVoice1787300000115'
 */
export class AutomationVoice1787300000115 implements MigrationInterface {
  name = 'AutomationVoice1787300000115';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "scheduled_tasks" ADD COLUMN IF NOT EXISTS "voice" boolean NOT NULL DEFAULT false`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "scheduled_tasks" DROP COLUMN IF EXISTS "voice"`);
  }
}
