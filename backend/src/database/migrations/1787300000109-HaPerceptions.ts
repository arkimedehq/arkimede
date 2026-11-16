// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * app_config.haPerceptionsEnabled (boolean, default false) and haPerceptionEntities (jsonb, default null): the chosen
 * Home Assistant entities' events (a sensor on, the doorbell, a door opened, an alarm) are sent to the memory as
 * perceptions (Recordare `perceive`). Off by default: nothing is sent.
 *
 * name = 'HaPerceptions1787300000109'
 */
export class HaPerceptions1787300000109 implements MigrationInterface {
  name = 'HaPerceptions1787300000109';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "haPerceptionsEnabled" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(`ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "haPerceptionEntities" jsonb`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "app_config" DROP COLUMN IF EXISTS "haPerceptionEntities"`);
    await queryRunner.query(`ALTER TABLE "app_config" DROP COLUMN IF EXISTS "haPerceptionsEnabled"`);
  }
}
