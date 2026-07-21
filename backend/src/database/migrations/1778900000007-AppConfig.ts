import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the app_config table (singleton — a single row with id = 1).
 * Contains the configuration modifiable at runtime by the admin.
 * Seeding of the initial systemPrompt value happens in AppConfigService.onModuleInit().
 */
export class AppConfig1778900000007 implements MigrationInterface {
  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      CREATE TABLE IF NOT EXISTS "app_config" (
        "id"           integer       NOT NULL,
        "systemPrompt" text          NOT NULL DEFAULT '',
        "updatedAt"    timestamptz   NOT NULL DEFAULT now(),
        CONSTRAINT "PK_app_config" PRIMARY KEY ("id")
      )
    `);
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`DROP TABLE IF EXISTS "app_config"`);
  }
}
