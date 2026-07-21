import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Delivery of Flow results to chat via the `chat` node (twin of
 * ScheduledTaskChatDelivery).
 *
 * - `flows.deliverChats` (jsonb): runtime state of the `chat` nodes, a map
 *   `chat title → chatId` of the dedicated chat created on the 1st delivery and reused on
 *   subsequent runs. No FK (it is a map): the node checks the chat's existence on each
 *   delivery and recreates it if it has been deleted.
 *
 * name = 'FlowChatDelivery1783400000050'
 */
export class FlowChatDelivery1783400000050 implements MigrationInterface {
  name = 'FlowChatDelivery1783400000050';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE flows ADD COLUMN IF NOT EXISTS "deliverChats" jsonb NOT NULL DEFAULT '{}'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE flows DROP COLUMN IF EXISTS "deliverChats"`);
  }
}
