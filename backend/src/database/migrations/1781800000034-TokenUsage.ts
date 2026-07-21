import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Token usage dashboard.
 *
 *   - messages.provider / messages.model        — provider and model that generated the
 *                                                 assistant message (to attribute the cost
 *                                                 to the correct price even if the default changes).
 *   - messages.cacheReadTokens / cacheWriteTokens — cache tokens (read/write) reported by the
 *                                                 provider; their semantics and price
 *                                                 multiplier depend on the provider (see pricing.ts).
 *   - llm_configs.inputPricePerM / outputPricePerM — price in $ per 1M tokens (input/output),
 *                                                 settable by the admin. null = price unknown.
 *
 * The columns on messages are populated only by new turns: historical messages have
 * provider/model NULL and in the dashboard fall back to the per-provider fallback (or "n/d").
 */
export class TokenUsage1781800000034 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "provider" varchar(50) DEFAULT NULL`);
    await runner.query(`ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "model" varchar(200) DEFAULT NULL`);
    await runner.query(`ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "cacheReadTokens" integer DEFAULT NULL`);
    await runner.query(`ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "cacheWriteTokens" integer DEFAULT NULL`);

    await runner.query(`ALTER TABLE "llm_configs" ADD COLUMN IF NOT EXISTS "inputPricePerM" numeric(10,4) DEFAULT NULL`);
    await runner.query(`ALTER TABLE "llm_configs" ADD COLUMN IF NOT EXISTS "outputPricePerM" numeric(10,4) DEFAULT NULL`);

    // Index for aggregation queries (filter by date on assistant messages only).
    await runner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_messages_created" ON "messages" ("createdAt")`,
    );
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`DROP INDEX IF EXISTS "IDX_messages_created"`);
    await runner.query(`ALTER TABLE "llm_configs" DROP COLUMN IF EXISTS "outputPricePerM"`);
    await runner.query(`ALTER TABLE "llm_configs" DROP COLUMN IF EXISTS "inputPricePerM"`);
    await runner.query(`ALTER TABLE "messages" DROP COLUMN IF EXISTS "cacheWriteTokens"`);
    await runner.query(`ALTER TABLE "messages" DROP COLUMN IF EXISTS "cacheReadTokens"`);
    await runner.query(`ALTER TABLE "messages" DROP COLUMN IF EXISTS "model"`);
    await runner.query(`ALTER TABLE "messages" DROP COLUMN IF EXISTS "provider"`);
  }
}
