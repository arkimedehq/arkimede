import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * File visibility scope (C2): personal|team|org + teamId.
 * Default 'personal' = current behavior (owner + project members).
 *
 * name = 'FileScope1783700000054'
 */
export class FileScope1783700000054 implements MigrationInterface {
  name = 'FileScope1783700000054';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "scope" character varying(20) NOT NULL DEFAULT 'personal'`,
    );
    await queryRunner.query(
      `ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "teamId" uuid`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "files" DROP COLUMN IF EXISTS "teamId"`);
    await queryRunner.query(`ALTER TABLE "files" DROP COLUMN IF EXISTS "scope"`);
  }
}
