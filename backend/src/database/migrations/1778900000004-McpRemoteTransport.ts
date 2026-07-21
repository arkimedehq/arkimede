/**
 * @migration McpRemoteTransport1778900000004
 *
 * Adds the 'remote' transport to the mcp_servers_transport_enum enum and migrates
 * existing records with transport='local' to transport='remote'.
 *
 * Rationale:
 *   - 'local'  (new)     → stdio process started directly by the NestJS backend
 *   - 'remote' (ex-local) → stdio process on the user's machine, proxied
 *                           via Electron bridge (McpBridgeGateway)
 *
 * PostgreSQL does not support ALTER TYPE ... ADD VALUE inside a transaction,
 * so adding the value is performed outside the transaction via
 * queryRunner.query() + 'COMMIT'.
 */
import { MigrationInterface, QueryRunner } from 'typeorm';

export class McpRemoteTransport1778900000004 implements MigrationInterface {
  name = 'McpRemoteTransport1778900000004';

  async up(queryRunner: QueryRunner): Promise<void> {
    // ALTER TYPE not supported inside a transaction on PostgreSQL —
    // explicit commit before adding the value
    await queryRunner.query(`COMMIT`);
    await queryRunner.query(`
      ALTER TYPE "public"."mcp_servers_transport_enum"
      ADD VALUE IF NOT EXISTS 'remote'
    `);

    // Resume the transaction for the subsequent operations
    await queryRunner.query(`BEGIN`);

    // Migrate existing records: 'local' (ex-bridge) → 'remote'
    await queryRunner.query(`
      UPDATE "mcp_servers"
      SET "transport" = 'remote'
      WHERE "transport" = 'local'
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Restore the records 'remote' → 'local'
    await queryRunner.query(`
      UPDATE "mcp_servers"
      SET "transport" = 'local'
      WHERE "transport" = 'remote'
    `);

    // PostgreSQL does not support DROP VALUE from an enum —
    // the value 'remote' stays in the enum but is no longer used
    // (acceptable for a rollback)
  }
}
