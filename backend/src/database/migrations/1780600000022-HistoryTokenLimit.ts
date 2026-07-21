import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the token limit for the conversation history:
 *   - app_config.maxHistoryTokens  INT NOT NULL DEFAULT 6000  (global admin value)
 *   - users.maxHistoryTokens       INT NULLABLE               (per-user override; null = use global)
 */
export class HistoryTokenLimit1780600000022 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(
      `ALTER TABLE app_config ADD COLUMN IF NOT EXISTS "maxHistoryTokens" integer NOT NULL DEFAULT 6000`,
    );
    await runner.query(
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS "maxHistoryTokens" integer`,
    );
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE app_config DROP COLUMN IF EXISTS "maxHistoryTokens"`);
    await runner.query(`ALTER TABLE users DROP COLUMN IF EXISTS "maxHistoryTokens"`);
  }
}
