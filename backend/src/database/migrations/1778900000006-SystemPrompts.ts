import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the systemPrompt field to users and projects.
 *
 * Stacking logic in the final prompt:
 *   SYSTEM_PROMPT (base, hard-coded) + user.systemPrompt + project.systemPrompt
 *
 * Both fields are nullable: if absent the behavior is identical to before.
 */
export class SystemPrompts1778900000006 implements MigrationInterface {
  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      ALTER TABLE "users"
        ADD COLUMN IF NOT EXISTS "systemPrompt" text DEFAULT NULL;
    `);
    await qr.query(`
      ALTER TABLE "projects"
        ADD COLUMN IF NOT EXISTS "systemPrompt" text DEFAULT NULL;
    `);
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`ALTER TABLE "users"    DROP COLUMN IF EXISTS "systemPrompt";`);
    await qr.query(`ALTER TABLE "projects" DROP COLUMN IF EXISTS "systemPrompt";`);
  }
}
