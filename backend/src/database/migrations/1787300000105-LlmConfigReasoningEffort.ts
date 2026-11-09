// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds llm_configs.reasoningEffort (varchar, null): the config's reasoning
 * setting — off | low | medium | high, NULL = the provider's default.
 *
 * name = 'LlmConfigReasoningEffort1787300000105'
 */
export class LlmConfigReasoningEffort1787300000105 implements MigrationInterface {
  name = 'LlmConfigReasoningEffort1787300000105';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "llm_configs" ADD COLUMN IF NOT EXISTS "reasoningEffort" varchar(10)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "llm_configs" DROP COLUMN IF EXISTS "reasoningEffort"`);
  }
}
