import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * No-op: this migration was created to move 'deferred' from
 * toolSchemaFormat to toolLoadingStrategy. The design was revised:
 * 'deferred' stays in toolSchemaFormat with completely redefined semantics
 * (real tools with minimal description + list in the system prompt + get_tool_instructions on-demand).
 * No DB change needed.
 */
export class DeferredAsStrategy1780700000023 implements MigrationInterface {
  public async up(_queryRunner: QueryRunner): Promise<void> {
    // no-op
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // no-op
  }
}
