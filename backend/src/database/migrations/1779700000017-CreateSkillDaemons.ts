import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the `skill_daemons` table for managing skill daemon processes.
 *
 * A daemon is a long-running process associated with a user and a script
 * with mode='daemon'. The record persists to allow automatic recovery
 * on backend restart.
 */
export class CreateSkillDaemons1779700000017 implements MigrationInterface {
  name = 'CreateSkillDaemons1779700000017';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "skill_daemons" (
        "id"             uuid        NOT NULL DEFAULT uuid_generate_v4(),
        "userId"         uuid        NOT NULL,
        "skillId"        uuid        NOT NULL,
        "scriptFilename" varchar(256) NOT NULL,
        "status"         varchar(16) NOT NULL DEFAULT 'starting',
        "pid"            integer     NULL,
        "startedAt"      timestamptz NULL,
        "lastEventAt"    timestamptz NULL,
        "lastError"      text        NULL,
        "createdAt"      timestamptz NOT NULL DEFAULT now(),
        "updatedAt"      timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_skill_daemons" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "skill_daemons"
      ADD CONSTRAINT "FK_sd_user"
      FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
    `);

    await queryRunner.query(`
      ALTER TABLE "skill_daemons"
      ADD CONSTRAINT "FK_sd_skill"
      FOREIGN KEY ("skillId") REFERENCES "skills"("id") ON DELETE CASCADE
    `);

    // Index to quickly find a user's active daemons
    await queryRunner.query(`
      CREATE INDEX "IDX_sd_user_status"
      ON "skill_daemons" ("userId", "status")
    `);

    // Index for boot recovery: all 'running' daemons
    await queryRunner.query(`
      CREATE INDEX "IDX_sd_status"
      ON "skill_daemons" ("status")
      WHERE "status" IN ('running', 'starting')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_sd_status"`);
    await queryRunner.query(`DROP INDEX "IDX_sd_user_status"`);
    await queryRunner.query(`ALTER TABLE "skill_daemons" DROP CONSTRAINT "FK_sd_skill"`);
    await queryRunner.query(`ALTER TABLE "skill_daemons" DROP CONSTRAINT "FK_sd_user"`);
    await queryRunner.query(`DROP TABLE "skill_daemons"`);
  }
}
