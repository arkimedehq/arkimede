import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Persistent user memory (auto-memory).
 *
 *   - user_memory                       — durable facts about the user, valid across chats/sessions.
 *       userId         owner (FK users CASCADE)
 *       content        the fact (text)
 *       status         pending|confirmed (default pending) — pending ones await user confirmation
 *       sourceChatId   chat it was extracted from (uuid, nullable)
 *   - users.autoMemoryEnabled           — per-user toggle (default OFF): automatic extraction at end of turn.
 *   - users.memoryThreshold             — per-user override of the threshold (n. of messages); null = use the global default.
 *   - chats.memoryUpToMessageId         — last message already analyzed for extraction (twin of summaryUpToMessageId).
 *   - app_config.autoMemoryThreshold    — global default of the extraction threshold (n. of new messages).
 *
 * `confirmed` facts are injected into the system prompt ("what I know about the user" block)
 * only if the user has enabled automatic memory.
 */
export class UserMemory1781700000033 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      CREATE TABLE IF NOT EXISTS "user_memory" (
        "id"            uuid NOT NULL DEFAULT uuid_generate_v4(),
        "userId"        uuid NOT NULL,
        "content"       text NOT NULL,
        "status"        varchar(20) NOT NULL DEFAULT 'pending',
        "sourceChatId"  uuid DEFAULT NULL,
        "createdAt"     TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt"     TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_user_memory" PRIMARY KEY ("id"),
        CONSTRAINT "FK_user_memory_user" FOREIGN KEY ("userId")
          REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);

    await runner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_user_memory_user" ON "user_memory" ("userId")`,
    );

    await runner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "autoMemoryEnabled" boolean NOT NULL DEFAULT false`,
    );
    await runner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "memoryThreshold" integer DEFAULT NULL`,
    );
    await runner.query(
      `ALTER TABLE "chats" ADD COLUMN IF NOT EXISTS "memoryUpToMessageId" uuid DEFAULT NULL`,
    );
    await runner.query(
      `ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "autoMemoryThreshold" integer NOT NULL DEFAULT 6`,
    );
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE "app_config" DROP COLUMN IF EXISTS "autoMemoryThreshold"`);
    await runner.query(`ALTER TABLE "chats" DROP COLUMN IF EXISTS "memoryUpToMessageId"`);
    await runner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "memoryThreshold"`);
    await runner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "autoMemoryEnabled"`);
    await runner.query(`DROP INDEX IF EXISTS "IDX_user_memory_user"`);
    await runner.query(`DROP TABLE IF EXISTS "user_memory"`);
  }
}
