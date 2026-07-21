import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the 'redis' value to the custom tools' executorType enum (Phase 3:
 * Redis key-value DataSources → 'redis' tool with whitelisted commands).
 *
 * name = 'AddRedisExecutorType1784100000062'
 */
export class AddRedisExecutorType1784100000062 implements MigrationInterface {
  name = 'AddRedisExecutorType1784100000062';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."custom_tools_executortype_enum" ADD VALUE IF NOT EXISTS 'redis'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // PostgreSQL does not support removing values from an enum (intentional no-op).
  }
}
