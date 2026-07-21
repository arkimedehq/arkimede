import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the DataSource anti-SSRF policy to app_config:
 *   - dataSourceAllowPrivateHosts (boolean, default true) — permissive by default so
 *     self-hosted DBs on LAN/localhost keep working; the cloud metadata endpoint
 *     (169.254.x / IPv6 link-local) is blocked in code regardless.
 *   - dataSourceHostAllowlist (jsonb, default []) — host/CIDR allowed even in strict mode.
 *
 * New migration (not editing an applied one). IF NOT EXISTS → idempotent.
 */
export class DataSourceSsrfPolicy1785800000076 implements MigrationInterface {
  name = 'DataSourceSsrfPolicy1785800000076';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "dataSourceAllowPrivateHosts" boolean NOT NULL DEFAULT true`,
    );
    await queryRunner.query(
      `ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "dataSourceHostAllowlist" jsonb NOT NULL DEFAULT '[]'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "app_config" DROP COLUMN IF EXISTS "dataSourceHostAllowlist"`);
    await queryRunner.query(`ALTER TABLE "app_config" DROP COLUMN IF EXISTS "dataSourceAllowPrivateHosts"`);
  }
}
