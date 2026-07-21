import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Compaction of the conversation history (persisted rolling summary).
 *
 *   - chats.summary               text     — incremental summary of the old turns
 *   - chats.summaryUpToMessageId  uuid     — last message already included in the summary
 *                                            (the following turns are still "fresh")
 *   - chats.summaryTokens         int      — token estimate of the summary (for the budget)
 *   - llm_configs.isSummarizer    boolean  — designates the config to use for generating
 *                                            the summaries (fallback: the isDefault config)
 *   - app_config.historyCompactionEnabled    — global toggle (default OFF: trimming only)
 */
export class HistoryCompaction1781400000030 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(
      `ALTER TABLE "chats" ADD COLUMN IF NOT EXISTS "summary" text DEFAULT NULL`,
    );
    await runner.query(
      `ALTER TABLE "chats" ADD COLUMN IF NOT EXISTS "summaryUpToMessageId" uuid DEFAULT NULL`,
    );
    await runner.query(
      `ALTER TABLE "chats" ADD COLUMN IF NOT EXISTS "summaryTokens" int DEFAULT NULL`,
    );
    await runner.query(
      `ALTER TABLE "llm_configs" ADD COLUMN IF NOT EXISTS "isSummarizer" boolean NOT NULL DEFAULT false`,
    );
    await runner.query(
      `ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "historyCompactionEnabled" boolean NOT NULL DEFAULT false`,
    );
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE "app_config" DROP COLUMN IF EXISTS "historyCompactionEnabled"`);
    await runner.query(`ALTER TABLE "llm_configs" DROP COLUMN IF EXISTS "isSummarizer"`);
    await runner.query(`ALTER TABLE "chats" DROP COLUMN IF EXISTS "summaryTokens"`);
    await runner.query(`ALTER TABLE "chats" DROP COLUMN IF EXISTS "summaryUpToMessageId"`);
    await runner.query(`ALTER TABLE "chats" DROP COLUMN IF EXISTS "summary"`);
  }
}
