import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Call-level LLM serving log (P2-F1 of LLM_SERVING_PLAN.md): one row per model
 * invocation from any caller, with latency/tokens/errors. queuedMs/priority stay
 * null until the request scheduler (P1) fills them. Retention 30d via GC.
 *
 * name = 'LlmCalls1785000000067'
 */
export class LlmCalls1785000000067 implements MigrationInterface {
  name = 'LlmCalls1785000000067';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "llm_calls" (
        "id"               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "createdAt"        timestamptz NOT NULL DEFAULT now(),
        "llmConfigId"      uuid,
        "provider"         varchar(50) NOT NULL,
        "model"            varchar(200),
        "latencyMs"        integer NOT NULL,
        "inputTokens"      integer NOT NULL DEFAULT 0,
        "outputTokens"     integer NOT NULL DEFAULT 0,
        "cacheReadTokens"  integer NOT NULL DEFAULT 0,
        "cacheWriteTokens" integer NOT NULL DEFAULT 0,
        "ok"               boolean NOT NULL DEFAULT true,
        "errorKind"        varchar(200),
        "queuedMs"         integer,
        "priority"         varchar(16),
        "userId"           uuid,
        "origin"           varchar(32)
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_llm_calls_created" ON "llm_calls" ("createdAt")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_llm_calls_config"  ON "llm_calls" ("llmConfigId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "llm_calls"`);
  }
}
