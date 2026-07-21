import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds 'node' as a valid value to the language enum of skill_scripts.
 *
 * 'node' indicates that the JS script must be executed as a real Node.js
 * subprocess (with access to Node APIs and npm deps) instead of isolated-vm.
 * name = 'AddNodeLanguage1779600000015'
 */
export class AddNodeLanguage1779600000015 implements MigrationInterface {
  name = 'AddNodeLanguage1779600000015';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // PostgreSQL does not support ALTER TYPE directly within an active transaction.
    // We use the workaround: change the column to text, recreate the enum, reconvert.
    await queryRunner.query(`
      ALTER TABLE skill_scripts
        ALTER COLUMN language TYPE VARCHAR(20)
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_type WHERE typname = 'skill_scripts_language_enum_new'
        ) THEN
          CREATE TYPE skill_scripts_language_enum_new
            AS ENUM ('python', 'javascript', 'node');
        END IF;
      END $$
    `);

    await queryRunner.query(`
      ALTER TABLE skill_scripts
        ALTER COLUMN language TYPE skill_scripts_language_enum_new
          USING language::skill_scripts_language_enum_new
    `);

    // Rename the old type (if it exists) and the new one
    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_type WHERE typname = 'skill_scripts_language_enum'
        ) THEN
          ALTER TYPE skill_scripts_language_enum RENAME TO skill_scripts_language_enum_old;
        END IF;
      END $$
    `);

    await queryRunner.query(`
      ALTER TYPE skill_scripts_language_enum_new
        RENAME TO skill_scripts_language_enum
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_type WHERE typname = 'skill_scripts_language_enum_old'
        ) THEN
          DROP TYPE skill_scripts_language_enum_old;
        END IF;
      END $$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Remove the 'node' records (they cannot go back without data loss)
    await queryRunner.query(`
      DELETE FROM skill_scripts WHERE language = 'node'
    `);

    await queryRunner.query(`
      ALTER TABLE skill_scripts
        ALTER COLUMN language TYPE VARCHAR(20)
    `);

    await queryRunner.query(`
      CREATE TYPE skill_scripts_language_enum_v1
        AS ENUM ('python', 'javascript')
    `);

    await queryRunner.query(`
      ALTER TABLE skill_scripts
        ALTER COLUMN language TYPE skill_scripts_language_enum_v1
          USING language::skill_scripts_language_enum_v1
    `);

    await queryRunner.query(`
      ALTER TYPE skill_scripts_language_enum RENAME TO skill_scripts_language_enum_old2
    `);

    await queryRunner.query(`
      ALTER TYPE skill_scripts_language_enum_v1 RENAME TO skill_scripts_language_enum
    `);

    await queryRunner.query(`DROP TYPE skill_scripts_language_enum_old2`);
  }
}
