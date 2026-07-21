import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRagExecutorType1778900000012 implements MigrationInterface {
  name = 'AddRagExecutorType1778900000012';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."custom_tools_executortype_enum" ADD VALUE IF NOT EXISTS 'rag'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // PostgreSQL does not support removing values from an enum.
    // To roll back one must recreate the type: a destructive operation,
    // left as an intentional no-op.
  }
}
