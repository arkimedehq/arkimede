import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Feedback loop (👍/👎) with active memory.
 *
 *   - message_feedback                       — user ratings on assistant messages.
 *       rating       up|down
 *       comment      user correction/note (text, nullable)
 *       question     user question that generated the rated answer
 *       answer       rated answer (snippet)
 *       scope        personal|shared (default personal)
 *       isApproved   for shared ones: visible to others only if approved by the admin
 *       vectorId     id of the point in the 'feedback_memory' collection (null if not vectorized)
 *   - app_config.feedbackMemoryEnabled        — global toggle (default OFF).
 *                                               On activation the vector collection is created.
 */
export class MessageFeedback1781600000032 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      CREATE TABLE IF NOT EXISTS "message_feedback" (
        "id"          uuid NOT NULL DEFAULT uuid_generate_v4(),
        "messageId"   uuid NOT NULL,
        "userId"      uuid NOT NULL,
        "rating"      varchar(10) NOT NULL,
        "comment"     text DEFAULT NULL,
        "question"    text DEFAULT NULL,
        "answer"      text DEFAULT NULL,
        "scope"       varchar(20) NOT NULL DEFAULT 'personal',
        "isApproved"  boolean NOT NULL DEFAULT false,
        "vectorId"    uuid DEFAULT NULL,
        "createdAt"   TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_message_feedback" PRIMARY KEY ("id"),
        CONSTRAINT "FK_message_feedback_message" FOREIGN KEY ("messageId")
          REFERENCES "messages"("id") ON DELETE CASCADE,
        CONSTRAINT "UQ_message_feedback_user_message" UNIQUE ("messageId", "userId")
      )
    `);

    await runner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_message_feedback_user" ON "message_feedback" ("userId")`,
    );

    await runner.query(
      `ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "feedbackMemoryEnabled" boolean NOT NULL DEFAULT false`,
    );
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE "app_config" DROP COLUMN IF EXISTS "feedbackMemoryEnabled"`);
    await runner.query(`DROP INDEX IF EXISTS "IDX_message_feedback_user"`);
    await runner.query(`DROP TABLE IF EXISTS "message_feedback"`);
  }
}
