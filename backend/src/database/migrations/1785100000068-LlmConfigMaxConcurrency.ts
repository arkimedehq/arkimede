import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds llm_configs.maxConcurrency (int, null): per-config cap on concurrent
 * LLM calls enforced by the in-memory dispatcher (P1 of LLM_SERVING_PLAN.md).
 * NULL = unlimited (pass-through) — the sensible default for cloud providers;
 * set a small value on finite-capacity (self-hosted) configs.
 *
 * name = 'LlmConfigMaxConcurrency1785100000068'
 */
export class LlmConfigMaxConcurrency1785100000068 implements MigrationInterface {
  name = 'LlmConfigMaxConcurrency1785100000068';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "llm_configs" ADD COLUMN IF NOT EXISTS "maxConcurrency" integer`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "llm_configs" DROP COLUMN IF EXISTS "maxConcurrency"`);
  }
}
