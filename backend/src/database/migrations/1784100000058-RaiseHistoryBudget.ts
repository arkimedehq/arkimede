import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Raises the history budget and enables compaction by default.
 *
 * Rationale (see DATAFLOW_AGENT.md): the 6000-token budget was too low
 * for agentic chats with SQL/RAG tools — a single turn with replayed tool-calls
 * can exceed it, and with compaction off the excess was silently dropped
 * by the trim ("forgetful" model). Reference agentic products use a
 * large fraction of the model's context window (tens of kTokens) and summarize
 * near the limit, not a fixed cap at 6k.
 *
 * - maxHistoryTokens: default 6000 → 30000
 * - historyCompactionEnabled: default false → true
 * - also updates the existing row ONLY if it still has the old defaults
 *   (a value customized by the admin is not touched)
 *
 * name = 'RaiseHistoryBudget1784100000058'
 */
export class RaiseHistoryBudget1784100000058 implements MigrationInterface {
  name = 'RaiseHistoryBudget1784100000058';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "app_config"
        ALTER COLUMN "maxHistoryTokens" SET DEFAULT 30000,
        ALTER COLUMN "historyCompactionEnabled" SET DEFAULT true
    `);
    await queryRunner.query(`
      UPDATE "app_config" SET "maxHistoryTokens" = 30000 WHERE "maxHistoryTokens" = 6000
    `);
    await queryRunner.query(`
      UPDATE "app_config" SET "historyCompactionEnabled" = true WHERE "historyCompactionEnabled" = false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "app_config"
        ALTER COLUMN "maxHistoryTokens" SET DEFAULT 6000,
        ALTER COLUMN "historyCompactionEnabled" SET DEFAULT false
    `);
  }
}
