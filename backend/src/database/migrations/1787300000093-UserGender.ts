// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * users.gender: the user's grammatical gender (masculine | feminine | neutral), null = not set (masculine).
 * Recordare uses it for the first person of the user's memory in gendered languages (its D50, `PATCH /me {gender}`).
 *
 * New migration (not editing an applied one). IF NOT EXISTS → idempotent.
 */
export class UserGender1787300000093 implements MigrationInterface {
  name = 'UserGender1787300000093';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "gender" varchar(10) NULL`);
    await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "CHK_users_gender"`);
    await queryRunner.query(
      `ALTER TABLE "users" ADD CONSTRAINT "CHK_users_gender" CHECK ("gender" IN ('masculine', 'feminine', 'neutral'))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "CHK_users_gender"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "gender"`);
  }
}
