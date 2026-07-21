import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the tool prompt optimization configuration.
 *
 * Two orthogonal axes, configurable globally (app_config) and
 * per single user (users) with the option of individual override.
 *
 * AXIS 1 – Selection (how many tools to inject):
 *   always_inject_all  → all tools, always (backward-compatible default)
 *   top_k_rag          → only the K tools semantically most relevant to the query
 *   auto               → inject_all if n ≤ maxTools, otherwise top_k_rag
 *
 * AXIS 2 – Schema format (how much detail per tool):
 *   full               → full schema (backward-compatible default)
 *   compressed         → only the first sentence of the description; Zod schema unchanged
 *   deferred           → 3 meta-tools (list / get_schema / call dispatcher)
 *
 * Columns added:
 *   app_config.toolLoadingStrategy  — global default Axis 1
 *   app_config.toolLoadingMaxTools  — auto threshold / K for RAG (global default)
 *   app_config.toolSchemaFormat     — global default Axis 2
 *   users.toolLoadingStrategy       — per-user override Axis 1 (null = use global)
 *   users.toolLoadingMaxTools       — per-user override threshold/K    (null = use global)
 *   users.toolSchemaFormat          — per-user override Axis 2 (null = use global)
 */
export class ToolLoadingConfig1780400000020 implements MigrationInterface {
  async up(qr: QueryRunner): Promise<void> {
    // ── app_config: global default ─────────────────────────────────────────
    await qr.query(`
      ALTER TABLE "app_config"
        ADD COLUMN IF NOT EXISTS "toolLoadingStrategy" VARCHAR(30) NOT NULL DEFAULT 'always_inject_all',
        ADD COLUMN IF NOT EXISTS "toolLoadingMaxTools" INTEGER     NOT NULL DEFAULT 15,
        ADD COLUMN IF NOT EXISTS "toolSchemaFormat"    VARCHAR(20) NOT NULL DEFAULT 'full'
    `);

    // ── users: per-user override (nullable → null = use global) ────────────
    await qr.query(`
      ALTER TABLE "users"
        ADD COLUMN IF NOT EXISTS "toolLoadingStrategy" VARCHAR(30) NULL DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS "toolLoadingMaxTools" INTEGER     NULL DEFAULT NULL,
        ADD COLUMN IF NOT EXISTS "toolSchemaFormat"    VARCHAR(20) NULL DEFAULT NULL
    `);
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`
      ALTER TABLE "users"
        DROP COLUMN IF EXISTS "toolSchemaFormat",
        DROP COLUMN IF EXISTS "toolLoadingMaxTools",
        DROP COLUMN IF EXISTS "toolLoadingStrategy"
    `);

    await qr.query(`
      ALTER TABLE "app_config"
        DROP COLUMN IF EXISTS "toolSchemaFormat",
        DROP COLUMN IF EXISTS "toolLoadingMaxTools",
        DROP COLUMN IF EXISTS "toolLoadingStrategy"
    `);
  }
}
