import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: tables for the system of user-defined custom tools.
 *
 * Creates:
 *   custom_tools     — tool definition (metadata + executor config)
 *   tool_secrets     — AES-256-CBC encrypted secrets (API key, token, etc.)
 *
 * Note: the enum executor_type_enum is created before the table
 * and removed in down() for PostgreSQL compatibility.
 */
export class CustomTools1778900000001 implements MigrationInterface {
  name = 'CustomTools1778900000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Enum for the executor type
    await queryRunner.query(`
      CREATE TYPE "public"."custom_tools_executortype_enum"
      AS ENUM('http', 'sql', 'prompt')
    `);

    // Custom tools table
    await queryRunner.query(`
      CREATE TABLE "custom_tools" (
        "id"             uuid            NOT NULL DEFAULT uuid_generate_v4(),
        "userId"         uuid            NOT NULL,
        "name"           varchar(64)     NOT NULL,
        "description"    text            NOT NULL,
        "parameters"     jsonb           NOT NULL DEFAULT '[]',
        "executorType"   "public"."custom_tools_executortype_enum" NOT NULL,
        "executorConfig" jsonb           NOT NULL,
        "enabled"        boolean         NOT NULL DEFAULT true,
        "createdAt"      TIMESTAMP       NOT NULL DEFAULT now(),
        "updatedAt"      TIMESTAMP       NOT NULL DEFAULT now(),
        CONSTRAINT "PK_custom_tools" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_custom_tools_user_name" UNIQUE ("userId", "name")
      )
    `);

    // FK to users
    await queryRunner.query(`
      ALTER TABLE "custom_tools"
      ADD CONSTRAINT "FK_custom_tools_user"
      FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
    `);

    // Encrypted secrets table
    await queryRunner.query(`
      CREATE TABLE "tool_secrets" (
        "id"             uuid        NOT NULL DEFAULT uuid_generate_v4(),
        "toolId"         uuid        NOT NULL,
        "keyName"        varchar(64) NOT NULL,
        "encryptedValue" text        NOT NULL,
        CONSTRAINT "PK_tool_secrets" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_tool_secrets_tool_key" UNIQUE ("toolId", "keyName")
      )
    `);

    // FK to custom_tools (CASCADE: if the tool is deleted, the secrets are too)
    await queryRunner.query(`
      ALTER TABLE "tool_secrets"
      ADD CONSTRAINT "FK_tool_secrets_tool"
      FOREIGN KEY ("toolId") REFERENCES "custom_tools"("id") ON DELETE CASCADE
    `);

    // Index for frequent lookups: enabled tools per user
    await queryRunner.query(`
      CREATE INDEX "IDX_custom_tools_user_enabled"
      ON "custom_tools" ("userId", "enabled")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_custom_tools_user_enabled"`);
    await queryRunner.query(`ALTER TABLE "tool_secrets" DROP CONSTRAINT "FK_tool_secrets_tool"`);
    await queryRunner.query(`ALTER TABLE "custom_tools" DROP CONSTRAINT "FK_custom_tools_user"`);
    await queryRunner.query(`DROP TABLE "tool_secrets"`);
    await queryRunner.query(`DROP TABLE "custom_tools"`);
    await queryRunner.query(`DROP TYPE "public"."custom_tools_executortype_enum"`);
  }
}
