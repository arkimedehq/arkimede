import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Shared chat threads (Phase 3 of multi-team projects).
 *
 * Adds `messages.authorId`: the author of the user message. In shared projects
 * multiple collaborators can write in the same chat, so it is necessary to know
 * WHO wrote each turn (assistant messages keep authorId=null).
 *
 * ON DELETE SET NULL: deleting the user, the conversation history remains.
 *
 * name = 'MessageAuthor1782600000042'
 */
export class MessageAuthor1782600000042 implements MigrationInterface {
  name = 'MessageAuthor1782600000042';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS "authorId" uuid`);
    await queryRunner.query(`
      ALTER TABLE messages
        ADD CONSTRAINT fk_messages_author FOREIGN KEY ("authorId")
        REFERENCES users (id) ON DELETE SET NULL
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_messages_author ON messages ("authorId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_messages_author`);
    await queryRunner.query(`ALTER TABLE messages DROP CONSTRAINT IF EXISTS fk_messages_author`);
    await queryRunner.query(`ALTER TABLE messages DROP COLUMN IF EXISTS "authorId"`);
  }
}
