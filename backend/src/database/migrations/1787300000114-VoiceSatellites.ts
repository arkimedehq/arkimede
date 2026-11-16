// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Voice satellites per account (specs/VOICE_SATELLITES.md):
 *   - users.voiceAgentId (the agent of the user's voice turns), users.presenceInMyMemory and
 *     users.sharedTurnsInMyMemory (both off);
 *   - app_config: haMemoryUserId (whose memory hears Home Assistant), haDefaultVoiceUserId (the account of an unassigned
 *     satellite), haSatelliteUsers (satellite → account), wyomingConversationEnabled (the handle program on/off);
 *   - the Wyoming conversation user and agent go: an existing install starts from them (the memory, the default account
 *     and that user's voice agent), so nothing changes until the admin changes it.
 *
 * name = 'VoiceSatellites1787300000114'
 */
export class VoiceSatellites1787300000114 implements MigrationInterface {
  name = 'VoiceSatellites1787300000114';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "voiceAgentId" uuid REFERENCES "agents"("id") ON DELETE SET NULL`);
    await queryRunner.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "presenceInMyMemory" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "sharedTurnsInMyMemory" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(`ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "haMemoryUserId" uuid`);
    await queryRunner.query(`ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "haDefaultVoiceUserId" uuid`);
    await queryRunner.query(`ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "haSatelliteUsers" jsonb`);
    await queryRunner.query(`ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "wyomingConversationEnabled" boolean NOT NULL DEFAULT false`);

    const [old] = await queryRunner.query(`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'app_config' AND column_name = 'wyomingHandleUserId'`);
    if (old) {
      await queryRunner.query(`
        UPDATE "app_config" SET
          "wyomingConversationEnabled" = "wyomingHandleUserId" IS NOT NULL,
          "haMemoryUserId"       = COALESCE("haMemoryUserId", "wyomingHandleUserId"),
          "haDefaultVoiceUserId" = COALESCE("haDefaultVoiceUserId", "wyomingHandleUserId")`);
      await queryRunner.query(`
        UPDATE "users" u SET "voiceAgentId" = c."wyomingHandleAgentId"
          FROM "app_config" c
         WHERE u."id" = c."wyomingHandleUserId" AND c."wyomingHandleAgentId" IS NOT NULL AND u."voiceAgentId" IS NULL
           AND EXISTS (SELECT 1 FROM "agents" a WHERE a."id" = c."wyomingHandleAgentId")`);
    }
    await queryRunner.query(`ALTER TABLE "app_config" DROP COLUMN IF EXISTS "wyomingHandleAgentId"`);
    await queryRunner.query(`ALTER TABLE "app_config" DROP COLUMN IF EXISTS "wyomingHandleUserId"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "wyomingHandleUserId" uuid`);
    await queryRunner.query(`ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "wyomingHandleAgentId" uuid`);
    await queryRunner.query(`
      UPDATE "app_config" SET "wyomingHandleUserId" = CASE WHEN "wyomingConversationEnabled" THEN "haDefaultVoiceUserId" END`);
    for (const c of ['wyomingConversationEnabled', 'haSatelliteUsers', 'haDefaultVoiceUserId', 'haMemoryUserId']) {
      await queryRunner.query(`ALTER TABLE "app_config" DROP COLUMN IF EXISTS "${c}"`);
    }
    for (const c of ['sharedTurnsInMyMemory', 'presenceInMyMemory', 'voiceAgentId']) {
      await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "${c}"`);
    }
  }
}
