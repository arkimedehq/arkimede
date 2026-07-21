import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the llm_configs table (multi-record LLM configurations).
 *
 * Seeds the first row by reading the llm* values from the singleton app_config,
 * preserving provider, model, encrypted apiKey, baseUrl, maxTokens.
 * If app_config is empty, inserts a minimal Anthropic default.
 *
 * The llm* fields remain in app_config but are no longer read by the app.
 */
export class LlmConfigs1781300000029 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      CREATE TABLE IF NOT EXISTS "llm_configs" (
        "id"         uuid         NOT NULL DEFAULT gen_random_uuid(),
        "name"       varchar(100) NOT NULL,
        "provider"   varchar(50)  NOT NULL,
        "model"      varchar(200)          DEFAULT NULL,
        "apiKey"     text                  DEFAULT NULL,
        "baseUrl"    varchar(500)          DEFAULT NULL,
        "maxTokens"  int                   DEFAULT NULL,
        "isDefault"  boolean      NOT NULL DEFAULT false,
        "createdAt"  timestamptz  NOT NULL DEFAULT now(),
        "updatedAt"  timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT "pk_llm_configs" PRIMARY KEY ("id")
      )
    `);

    // Copy the current configuration from app_config if it exists
    await runner.query(`
      INSERT INTO "llm_configs"
        ("name", "provider", "model", "apiKey", "baseUrl", "maxTokens", "isDefault")
      SELECT
        COALESCE("llmProvider", 'anthropic') || ' (migrato)',
        COALESCE("llmProvider", 'anthropic'),
        "llmModel",
        "llmApiKey",
        "llmBaseUrl",
        "llmMaxTokens",
        true
      FROM "app_config"
      WHERE id = 1
    `);

    // Fallback: no app_config row → insert Anthropic default
    await runner.query(`
      INSERT INTO "llm_configs" ("name", "provider", "isDefault")
      SELECT 'Anthropic (default)', 'anthropic', true
      WHERE NOT EXISTS (SELECT 1 FROM "llm_configs")
    `);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`DROP TABLE IF EXISTS "llm_configs"`);
  }
}
