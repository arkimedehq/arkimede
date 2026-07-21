import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Delivery of automation results to chat + unread chats.
 *
 * - `scheduled_tasks.chatId` (uuid null): chat where the result is delivered. Set
 *   to the ORIGIN chat (where the user requested the automation); fallback to a
 *   dedicated chat created on the first run if missing/deleted. ON DELETE SET NULL.
 * - `chats.unread` (bool): the chat has content not yet seen (e.g. an automation
 *   result just delivered). Cleared when the user opens the chat.
 *
 * name = 'ScheduledTaskChatDelivery1783300000049'
 */
export class ScheduledTaskChatDelivery1783300000049 implements MigrationInterface {
  name = 'ScheduledTaskChatDelivery1783300000049';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS "chatId" uuid`);
    await queryRunner.query(`
      ALTER TABLE scheduled_tasks
      ADD CONSTRAINT "FK_scheduled_tasks_chat"
      FOREIGN KEY ("chatId") REFERENCES chats(id) ON DELETE SET NULL
    `);
    await queryRunner.query(`ALTER TABLE chats ADD COLUMN IF NOT EXISTS "unread" boolean NOT NULL DEFAULT false`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE chats DROP COLUMN IF EXISTS "unread"`);
    await queryRunner.query(`ALTER TABLE scheduled_tasks DROP CONSTRAINT IF EXISTS "FK_scheduled_tasks_chat"`);
    await queryRunner.query(`ALTER TABLE scheduled_tasks DROP COLUMN IF EXISTS "chatId"`);
  }
}
