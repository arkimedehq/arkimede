import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `status` column to the users table.
 *
 * Values: 'active' | 'disabled'. Default 'active' so that all existing
 * users remain enabled. Index to quickly filter the active ones
 * in admin lists.
 *
 * name = 'UserStatus1781900000035'
 */
export class UserStatus1781900000035 implements MigrationInterface {
  name = 'UserStatus1781900000035';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active'
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_users_status ON users (status)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_users_status`);
    await queryRunner.query(`ALTER TABLE users DROP COLUMN IF EXISTS status`);
  }
}
