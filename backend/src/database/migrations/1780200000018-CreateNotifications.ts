import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the `notifications` table for persistent user notifications.
 *
 * Generic: supports any source (skill_daemon, system, billing, ...)
 * and any event type.
 *
 * Automatic cleanup via NotificationsService: notifications older than 30 days are
 * deleted periodically (at boot and every 24h).
 */
export class CreateNotifications1780200000018 implements MigrationInterface {
  name = 'CreateNotifications1780200000018';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "notifications" (
        "id"        uuid          NOT NULL DEFAULT uuid_generate_v4(),
        "userId"    uuid          NOT NULL,
        "source"    varchar(32)   NOT NULL DEFAULT 'skill_daemon',
        "sourceId"  uuid          NULL,
        "eventType" varchar(64)   NOT NULL,
        "payload"   jsonb         NOT NULL DEFAULT '{}',
        "read"      boolean       NOT NULL DEFAULT false,
        "createdAt" timestamptz   NOT NULL DEFAULT now(),
        CONSTRAINT "PK_notifications" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "notifications"
      ADD CONSTRAINT "FK_notif_user"
      FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
    `);

    /* Paginated read by userId: ORDER BY createdAt DESC */
    await queryRunner.query(`
      CREATE INDEX "IDX_notif_user_created"
      ON "notifications" ("userId", "createdAt" DESC)
    `);

    /* Periodic cleanup (WHERE createdAt < now() - interval '30 days') */
    await queryRunner.query(`
      CREATE INDEX "IDX_notif_created"
      ON "notifications" ("createdAt")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_notif_created"`);
    await queryRunner.query(`DROP INDEX "IDX_notif_user_created"`);
    await queryRunner.query(`ALTER TABLE "notifications" DROP CONSTRAINT "FK_notif_user"`);
    await queryRunner.query(`DROP TABLE "notifications"`);
  }
}
