import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Extends vector_db_config to support multiple providers.
 *
 * Changes:
 * - RENAME qdrantUrl → url  (generic field for all providers)
 * - ADD provider             (qdrant | pgvector | chroma | astradb)
 * - ADD connectionString     (PostgreSQL connection string for PGVector)
 * - ADD apiKey               (encrypted: Qdrant Cloud key, AstraDB token, Chroma key)
 * - ADD extraConfig          (JSONB: AstraDB keyspace, Chroma tenant, PGVector tablePrefix)
 */
export class VectorDbProvider1778900000011 implements MigrationInterface {
  async up(qr: QueryRunner): Promise<void> {
    // 1. Rename qdrantUrl → url
    await qr.query(`
      ALTER TABLE "vector_db_config"
        RENAME COLUMN "qdrantUrl" TO url
    `);

    // 2. Add the new columns
    await qr.query(`
      ALTER TABLE "vector_db_config"
        ADD COLUMN IF NOT EXISTS provider          VARCHAR(50)   NOT NULL DEFAULT 'qdrant',
        ADD COLUMN IF NOT EXISTS "connectionString" TEXT          NULL,
        ADD COLUMN IF NOT EXISTS "apiKey"           TEXT          NULL,
        ADD COLUMN IF NOT EXISTS "extraConfig"      JSONB         NULL
    `);
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`
      ALTER TABLE "vector_db_config"
        DROP COLUMN IF EXISTS provider,
        DROP COLUMN IF EXISTS "connectionString",
        DROP COLUMN IF EXISTS "apiKey",
        DROP COLUMN IF EXISTS "extraConfig"
    `);

    await qr.query(`
      ALTER TABLE "vector_db_config"
        RENAME COLUMN url TO "qdrantUrl"
    `);
  }
}
