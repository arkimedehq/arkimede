// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds skills.networkMode ('internal' | 'internet' | 'open', nullable).
 *
 * Admin override of the job network tier. Null (default) keeps the derived
 * behavior: 'internet' when the skill declares networkDomains, otherwise the
 * internal baseline. 'open' attaches the full-internet network (no allowlist),
 * still double-gated by the broker's BROKER_ALLOWED_NETWORKS.
 *
 * New migration (not editing an applied one). IF NOT EXISTS → idempotent.
 */
export class SkillNetworkMode1786000000078 implements MigrationInterface {
  name = 'SkillNetworkMode1786000000078';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "networkMode" varchar(16)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "skills" DROP COLUMN IF EXISTS "networkMode"`);
  }
}
