import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A-MEM F4: shared memory. Notes gain the platform's resource scoping —
 * personal (default, as before) | team (visible to the team's members) |
 * org (visible to everyone; only admins can promote to org). The evolution
 * job never crosses scopes.
 *
 * name = 'UserMemoryScope1785500000072'
 */
export class UserMemoryScope1785500000072 implements MigrationInterface {
  name = 'UserMemoryScope1785500000072';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "user_memory" ADD COLUMN IF NOT EXISTS "scope" varchar(20) NOT NULL DEFAULT 'personal'`);
    await queryRunner.query(`ALTER TABLE "user_memory" ADD COLUMN IF NOT EXISTS "teamId" uuid`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_user_memory_scope" ON "user_memory" ("scope", "teamId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_user_memory_scope"`);
    await queryRunner.query(`ALTER TABLE "user_memory" DROP COLUMN IF EXISTS "teamId"`);
    await queryRunner.query(`ALTER TABLE "user_memory" DROP COLUMN IF EXISTS "scope"`);
  }
}
