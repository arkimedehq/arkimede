// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Home Assistant as a native integration (home-assistant/), from the admin's settings:
 *   - haUrl, haToken          — its base URL and a long-lived access token (encrypted)
 *   - haPresenceEnabled       — read who is home / in which room and tell the memory (default off)
 *   - haVoiceEnabled          — speak the memory's initiatives on the voice satellites (default off)
 *   - haToolsEnabled          — the agent's `ha_*` tools over the entities exposed to Assist (default off)
 *   - haToolsUserIds          — who may use them (null = every user)
 *   - users.haPerson          — the user's Home Assistant person (`person.x`)
 * Idempotent.
 */
export class HomeAssistant1787300000104 implements MigrationInterface {
  name = 'HomeAssistant1787300000104';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "haUrl" varchar(500)`);
    await queryRunner.query(`ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "haToken" text`);
    await queryRunner.query(`ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "haPresenceEnabled" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(`ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "haVoiceEnabled" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(`ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "haToolsEnabled" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(`ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "haToolsUserIds" uuid[]`);
    await queryRunner.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "haPerson" varchar(200)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "haPerson"`);
    for (const c of ['haToolsUserIds', 'haToolsEnabled', 'haVoiceEnabled', 'haPresenceEnabled', 'haToken', 'haUrl']) {
      await queryRunner.query(`ALTER TABLE "app_config" DROP COLUMN IF EXISTS "${c}"`);
    }
  }
}
