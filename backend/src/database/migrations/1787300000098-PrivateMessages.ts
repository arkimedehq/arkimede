// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Private chats and messages: chats.isPrivate (the chat's switch: messages written
 * while it is on are private) and messages.isPrivate (a person's message they keep
 * between themselves and the assistant). Arkimede's own flag; an episodic memory
 * service, when configured, receives it with the message (recordare-ingest.mapper).
 *
 * New migration (not editing an applied one). IF NOT EXISTS → idempotent.
 */
export class PrivateMessages1787300000098 implements MigrationInterface {
  name = 'PrivateMessages1787300000098';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "chats" ADD COLUMN IF NOT EXISTS "isPrivate" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(`ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "isPrivate" boolean NOT NULL DEFAULT false`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "messages" DROP COLUMN IF EXISTS "isPrivate"`);
    await queryRunner.query(`ALTER TABLE "chats" DROP COLUMN IF EXISTS "isPrivate"`);
  }
}
