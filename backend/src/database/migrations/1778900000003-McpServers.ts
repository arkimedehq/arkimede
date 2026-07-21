import { MigrationInterface, QueryRunner } from 'typeorm';

export class McpServers1778900000003 implements MigrationInterface {
  name = 'McpServers1778900000003';

  async up(queryRunner: QueryRunner): Promise<void> {
    // Transport enum
    await queryRunner.query(`
      CREATE TYPE "public"."mcp_servers_transport_enum"
      AS ENUM('http', 'sse', 'local')
    `);

    // mcp_servers table
    await queryRunner.query(`
      CREATE TABLE "mcp_servers" (
        "id"          uuid            NOT NULL DEFAULT uuid_generate_v4(),
        "userId"      uuid            NOT NULL,
        "name"        varchar(128)    NOT NULL,
        "description" text,
        "transport"   "public"."mcp_servers_transport_enum" NOT NULL,
        "url"         varchar(2048),
        "command"     varchar(512),
        "args"        jsonb,
        "headers"     jsonb,
        "env"         jsonb,
        "enabled"     boolean         NOT NULL DEFAULT true,
        "createdAt"   TIMESTAMP       NOT NULL DEFAULT now(),
        "updatedAt"   TIMESTAMP       NOT NULL DEFAULT now(),
        CONSTRAINT "PK_mcp_servers" PRIMARY KEY ("id"),
        CONSTRAINT "FK_mcp_servers_user"
          FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`CREATE INDEX "IDX_mcp_servers_userId" ON "mcp_servers" ("userId")`);
    await queryRunner.query(`CREATE INDEX "IDX_mcp_servers_enabled" ON "mcp_servers" ("userId", "enabled")`);

    // mcp_server_secrets table
    await queryRunner.query(`
      CREATE TABLE "mcp_server_secrets" (
        "id"             uuid         NOT NULL DEFAULT uuid_generate_v4(),
        "serverId"       uuid         NOT NULL,
        "keyName"        varchar(64)  NOT NULL,
        "encryptedValue" text         NOT NULL,
        CONSTRAINT "PK_mcp_server_secrets" PRIMARY KEY ("id"),
        CONSTRAINT "FK_mcp_server_secrets_server"
          FOREIGN KEY ("serverId") REFERENCES "mcp_servers"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`CREATE INDEX "IDX_mcp_server_secrets_serverId" ON "mcp_server_secrets" ("serverId")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "mcp_server_secrets"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "mcp_servers"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."mcp_servers_transport_enum"`);
  }
}
