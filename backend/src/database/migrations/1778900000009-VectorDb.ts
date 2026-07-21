import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the tables for managing the vector database:
 *
 * - vector_db_config  → singleton configuration (Qdrant URL)
 * - vector_collections → available collections, only one can be default
 */
export class VectorDb1778900000009 implements MigrationInterface {
  async up(qr: QueryRunner): Promise<void> {
    // ── Singleton configuration of the vector DB ─────────────────────────────
    await qr.query(`
      CREATE TABLE IF NOT EXISTS "vector_db_config" (
        "id"        integer       NOT NULL,
        "qdrantUrl" varchar(500)  NOT NULL DEFAULT 'http://localhost:6333',
        "updatedAt" timestamptz   NOT NULL DEFAULT now(),
        CONSTRAINT "PK_vector_db_config" PRIMARY KEY ("id")
      )
    `);

    // Inserts the singleton row with the default URL if it does not exist
    await qr.query(`
      INSERT INTO "vector_db_config" ("id", "qdrantUrl")
      VALUES (1, 'http://localhost:6333')
      ON CONFLICT ("id") DO NOTHING
    `);

    // ── Collections ──────────────────────────────────────────────────────────
    await qr.query(`
      CREATE TABLE IF NOT EXISTS "vector_collections" (
        "id"          uuid          NOT NULL DEFAULT gen_random_uuid(),
        "name"        varchar(100)  NOT NULL,
        "description" text          NULL,
        "isDefault"   boolean       NOT NULL DEFAULT false,
        "createdAt"   timestamptz   NOT NULL DEFAULT now(),
        "updatedAt"   timestamptz   NOT NULL DEFAULT now(),
        CONSTRAINT "PK_vector_collections"   PRIMARY KEY ("id"),
        CONSTRAINT "UQ_vector_collections_name" UNIQUE ("name")
      )
    `);
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`DROP TABLE IF EXISTS "vector_collections"`);
    await qr.query(`DROP TABLE IF EXISTS "vector_db_config"`);
  }
}
