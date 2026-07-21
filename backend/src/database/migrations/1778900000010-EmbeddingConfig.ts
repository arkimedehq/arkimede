import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the embedding configuration fields to the app_config table.
 *
 * Allows the admin to configure the embedding provider, the model,
 * the chunking parameters and the vector size directly from the UI,
 * without having to modify the environment variables.
 *
 * Supported providers: openai | voyage | ollama | lmstudio | openai-compatible
 *
 * Note: embeddingApiKey is stored encrypted with AES-256-CBC.
 */
export class EmbeddingConfig1778900000010 implements MigrationInterface {
  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      ALTER TABLE "app_config"
        ADD COLUMN IF NOT EXISTS "embeddingProvider"    VARCHAR(50)   NOT NULL DEFAULT 'lmstudio',
        ADD COLUMN IF NOT EXISTS "embeddingModel"       VARCHAR(200)  NULL,
        ADD COLUMN IF NOT EXISTS "embeddingApiKey"      TEXT          NULL,
        ADD COLUMN IF NOT EXISTS "embeddingBaseUrl"     VARCHAR(500)  NULL,
        ADD COLUMN IF NOT EXISTS "embeddingVectorSize"  INTEGER       NOT NULL DEFAULT 1024,
        ADD COLUMN IF NOT EXISTS "embeddingQueryPrefix" TEXT          NULL,
        ADD COLUMN IF NOT EXISTS "embeddingChunkSize"   INTEGER       NOT NULL DEFAULT 500,
        ADD COLUMN IF NOT EXISTS "embeddingChunkOverlap" INTEGER      NOT NULL DEFAULT 50
    `);
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`
      ALTER TABLE "app_config"
        DROP COLUMN IF EXISTS "embeddingProvider",
        DROP COLUMN IF EXISTS "embeddingModel",
        DROP COLUMN IF EXISTS "embeddingApiKey",
        DROP COLUMN IF EXISTS "embeddingBaseUrl",
        DROP COLUMN IF EXISTS "embeddingVectorSize",
        DROP COLUMN IF EXISTS "embeddingQueryPrefix",
        DROP COLUMN IF EXISTS "embeddingChunkSize",
        DROP COLUMN IF EXISTS "embeddingChunkOverlap"
    `);
  }
}
