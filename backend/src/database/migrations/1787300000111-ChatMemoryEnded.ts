// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * chats.memoryEndedAt (timestamptz, null): when Recordare was told the conversation ended (its extraction then runs at
 * once). Null for every existing chat: the first sweep ends the quiet ones of the last week.
 *
 * name = 'ChatMemoryEnded1787300000111'
 */
export class ChatMemoryEnded1787300000111 implements MigrationInterface {
  name = 'ChatMemoryEnded1787300000111';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "chats" ADD COLUMN IF NOT EXISTS "memoryEndedAt" timestamptz`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "chats" DROP COLUMN IF EXISTS "memoryEndedAt"`);
  }
}
