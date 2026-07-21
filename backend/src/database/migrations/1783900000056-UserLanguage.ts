import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * i18n — per-user language preference.
 *
 * Adds `users.language` (varchar(5), nullable). Values: 'it' | 'en'.
 * null = no preference saved → the frontend detects from the browser (fallback 'en').
 * Drives both the interface language (react-i18next) and the assistant's response
 * language (injected into the system prompt).
 *
 * name = 'UserLanguage1783900000056'
 */
export class UserLanguage1783900000056 implements MigrationInterface {
  name = 'UserLanguage1783900000056';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS "language" varchar(5)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE users DROP COLUMN IF EXISTS "language"`);
  }
}
