import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Reconciliation of the Flow chat-delivery schema.
 *
 * Migration `1783400000050` had been applied in an initial version that created
 * `flows.deliverToChat` (bool) + `flows.deliverChatId` (uuid + FK). The design then
 * moved to the `chat` NODE with runtime state in `flows.deliverChats` (jsonb, a map
 * title→chatId). Since `…050` was already registered (TypeORM tracks by name),
 * it was not re-run: this migration brings the schema to its final state.
 *
 * Idempotent (IF EXISTS / IF NOT EXISTS): it converges both on DBs with the old columns and
 * on fresh DBs where `…050` has already created `deliverChats`.
 *
 * name = 'FlowChatDeliveryFix1783400000051'
 */
export class FlowChatDeliveryFix1783400000051 implements MigrationInterface {
  name = 'FlowChatDeliveryFix1783400000051';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE flows DROP CONSTRAINT IF EXISTS "FK_flows_deliver_chat"`);
    await queryRunner.query(`ALTER TABLE flows DROP COLUMN IF EXISTS "deliverChatId"`);
    await queryRunner.query(`ALTER TABLE flows DROP COLUMN IF EXISTS "deliverToChat"`);
    await queryRunner.query(`ALTER TABLE flows ADD COLUMN IF NOT EXISTS "deliverChats" jsonb NOT NULL DEFAULT '{}'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Best-effort restore of the old columns (without FK).
    await queryRunner.query(`ALTER TABLE flows DROP COLUMN IF EXISTS "deliverChats"`);
    await queryRunner.query(`ALTER TABLE flows ADD COLUMN IF NOT EXISTS "deliverToChat" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(`ALTER TABLE flows ADD COLUMN IF NOT EXISTS "deliverChatId" uuid`);
  }
}
