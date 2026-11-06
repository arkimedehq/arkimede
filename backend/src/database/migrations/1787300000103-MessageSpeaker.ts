// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A message written by someone with no Arkimede account — a contact of the account writing from a messaging channel
 * (Telegram): `messages.speaker` = {channel, externalId, displayName?}. The memory (Recordare) learns who spoke from it.
 * Idempotent.
 */
export class MessageSpeaker1787300000103 implements MigrationInterface {
  name = 'MessageSpeaker1787300000103';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "speaker" jsonb`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "messages" DROP COLUMN IF EXISTS "speaker"`);
  }
}
