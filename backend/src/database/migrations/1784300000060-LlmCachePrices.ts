import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-model configurable cache prices on llm_configs.
 *
 * Providers publish absolute prices per 1M tokens for the cache too
 * (e.g. DeepSeek "cache hit", Anthropic "cache writes 5m/1h" and "cache hits").
 * `cacheReadPricePerM` / `cacheWritePricePerM` let the admin
 * enter the exact list price; if null, pricing.ts falls back to the
 * per-provider default multipliers (CACHE_MULT).
 *
 * 6-decimal scale: some cache price lists go below a ten-thousandth
 * of a dollar per 1M tokens (e.g. $0.003625).
 *
 * name = 'LlmCachePrices1784300000060'
 */
export class LlmCachePrices1784300000060 implements MigrationInterface {
  name = 'LlmCachePrices1784300000060';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "llm_configs"
        ADD COLUMN IF NOT EXISTS "cacheReadPricePerM" numeric(12,6),
        ADD COLUMN IF NOT EXISTS "cacheWritePricePerM" numeric(12,6)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "llm_configs"
        DROP COLUMN IF EXISTS "cacheReadPricePerM",
        DROP COLUMN IF EXISTS "cacheWritePricePerM"
    `);
  }
}
