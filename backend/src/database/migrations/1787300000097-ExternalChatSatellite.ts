// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * chats.externalSatellite: the satellite that started an external chat (Wyoming
 * `context.satellite_id`, the OpenAI `user` field), so a client listing the chats
 * can show where each one came from (chats/conversation-focus.service.ts).
 *
 * New migration (not editing an applied one). IF NOT EXISTS → idempotent.
 */
export class ExternalChatSatellite1787300000097 implements MigrationInterface {
  name = 'ExternalChatSatellite1787300000097';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "chats" ADD COLUMN IF NOT EXISTS "externalSatellite" varchar(200) NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "chats" DROP COLUMN IF EXISTS "externalSatellite"`);
  }
}
