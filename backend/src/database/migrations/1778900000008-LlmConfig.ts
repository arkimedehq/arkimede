import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the LLM configuration columns to the app_config table.
 *
 * Allows the admin to choose the AI provider and model directly
 * from the web interface, without modifying the environment variables.
 *
 * Supported providers: anthropic | openai | gemini | ollama | lmstudio | openai-compatible
 *
 * Note: llmApiKey is stored encrypted with AES-256-CBC (same logic as the custom tool secrets).
 */
export class LlmConfig1778900000008 implements MigrationInterface {
  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      ALTER TABLE "app_config"
        ADD COLUMN IF NOT EXISTS "llmProvider"   VARCHAR(50)  NOT NULL DEFAULT 'anthropic',
        ADD COLUMN IF NOT EXISTS "llmModel"      VARCHAR(100) NULL,
        ADD COLUMN IF NOT EXISTS "llmApiKey"     TEXT         NULL,
        ADD COLUMN IF NOT EXISTS "llmBaseUrl"    VARCHAR(500) NULL,
        ADD COLUMN IF NOT EXISTS "llmMaxTokens"  INTEGER      NULL
    `);
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`
      ALTER TABLE "app_config"
        DROP COLUMN IF EXISTS "llmProvider",
        DROP COLUMN IF EXISTS "llmModel",
        DROP COLUMN IF EXISTS "llmApiKey",
        DROP COLUMN IF EXISTS "llmBaseUrl",
        DROP COLUMN IF EXISTS "llmMaxTokens"
    `);
  }
}
