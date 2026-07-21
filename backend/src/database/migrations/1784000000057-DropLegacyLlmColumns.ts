import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tech-debt cleanup: removes the legacy LLM columns from `app_config`.
 *
 * Since migration `LlmConfigs1781300000029` the LLM configuration lives in the
 * multi-record `llm_configs` table (default + summarizer) and the app no longer
 * reads these fields. The 029 has already migrated them into `llm_configs`, so here
 * they can be dropped safely.
 *
 * name = 'DropLegacyLlmColumns1784000000057'
 */
export class DropLegacyLlmColumns1784000000057 implements MigrationInterface {
  name = 'DropLegacyLlmColumns1784000000057';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "app_config"
        DROP COLUMN IF EXISTS "llmProvider",
        DROP COLUMN IF EXISTS "llmModel",
        DROP COLUMN IF EXISTS "llmApiKey",
        DROP COLUMN IF EXISTS "llmBaseUrl",
        DROP COLUMN IF EXISTS "llmMaxTokens"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "app_config"
        ADD COLUMN IF NOT EXISTS "llmProvider"  VARCHAR(50)  NOT NULL DEFAULT 'anthropic',
        ADD COLUMN IF NOT EXISTS "llmModel"     VARCHAR(100) NULL,
        ADD COLUMN IF NOT EXISTS "llmApiKey"    TEXT         NULL,
        ADD COLUMN IF NOT EXISTS "llmBaseUrl"   VARCHAR(500) NULL,
        ADD COLUMN IF NOT EXISTS "llmMaxTokens" INTEGER      NULL
    `);
  }
}
