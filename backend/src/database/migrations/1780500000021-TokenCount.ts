import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the per-message token count (messages) and
 * the per-user showTokenCount UI preference (users).
 */
export class TokenCount1780500000021 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    // Input/output tokens for each assistant message
    await runner.query(`
      ALTER TABLE messages
        ADD COLUMN IF NOT EXISTS "inputTokens"  integer,
        ADD COLUMN IF NOT EXISTS "outputTokens" integer
    `);

    // UI preference: show/hide token count
    await runner.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS "showTokenCount" boolean NOT NULL DEFAULT false
    `);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE messages DROP COLUMN IF EXISTS "inputTokens"`);
    await runner.query(`ALTER TABLE messages DROP COLUMN IF EXISTS "outputTokens"`);
    await runner.query(`ALTER TABLE users    DROP COLUMN IF EXISTS "showTokenCount"`);
  }
}