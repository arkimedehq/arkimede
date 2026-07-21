import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the 'mongo' value to the custom tools' executorType enum (Phase 2:
 * MongoDB document DataSources → 'mongo' tool with find/aggregate).
 *
 * name = 'AddMongoExecutorType1784100000061'
 */
export class AddMongoExecutorType1784100000061 implements MigrationInterface {
  name = 'AddMongoExecutorType1784100000061';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."custom_tools_executortype_enum" ADD VALUE IF NOT EXISTS 'mongo'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // PostgreSQL does not support removing values from an enum (intentional no-op).
  }
}
