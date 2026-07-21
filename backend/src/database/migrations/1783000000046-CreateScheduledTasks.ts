import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Auto-Scheduling — automations scheduled by the user (also from chat).
 *
 * `scheduled_tasks`: instruction + schedule (cron|scheduled) executed headless
 * by the agent on fire, with delivery via notification.
 *
 * name = 'CreateScheduledTasks1783000000046'
 */
export class CreateScheduledTasks1783000000046 implements MigrationInterface {
  name = 'CreateScheduledTasks1783000000046';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id             uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "userId"       uuid NOT NULL,
        instruction    text NOT NULL,
        title          varchar(160),
        "scheduleType" varchar(16) NOT NULL,
        cron           varchar(120),
        "runAt"        timestamptz,
        timezone       varchar(64),
        "projectId"    uuid,
        enabled        boolean NOT NULL DEFAULT true,
        status         varchar(16) NOT NULL DEFAULT 'active',
        "lastRunAt"    timestamptz,
        "lastResult"   text,
        "createdAt"    timestamp NOT NULL DEFAULT now(),
        CONSTRAINT fk_scheduled_tasks_user FOREIGN KEY ("userId") REFERENCES users (id) ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_user ON scheduled_tasks ("userId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS scheduled_tasks`);
  }
}
