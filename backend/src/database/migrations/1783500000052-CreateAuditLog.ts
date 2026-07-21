import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * audit_log table (E4): security events for the admin viewer.
 * The tamper-evident copy remains the JSON line on stdout → CloudWatch/S3.
 *
 * name = 'CreateAuditLog1783500000052'
 */
export class CreateAuditLog1783500000052 implements MigrationInterface {
  name = 'CreateAuditLog1783500000052';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "audit_log" (
        "id"        uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "actorId"   uuid,
        "actorName" character varying,
        "actAsId"   uuid,
        "action"    character varying NOT NULL,
        "resource"  character varying,
        "outcome"   character varying NOT NULL,
        "ctx"       jsonb,
        CONSTRAINT "PK_audit_log" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_audit_log_created" ON "audit_log" ("createdAt")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_audit_log_action_created" ON "audit_log" ("action", "createdAt")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "audit_log"`);
  }
}
