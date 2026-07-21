import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Follow-up to CustomToolScopeTeam: ensures the partial unique indexes for the new
 * scopes also on the DBs where migration 037 had already been applied before the
 * indexes were added to its body. Idempotent (IF NOT EXISTS) → no-op on the
 * fresh DBs where 037 has already created them.
 *
 *   UQ_custom_tools_org_name   — unique name among org tools
 *   UQ_custom_tools_team_name  — unique name per (team, name) among team tools
 *
 * name = 'CustomToolScopeIndexes1782200000038'
 */
export class CustomToolScopeIndexes1782200000038 implements MigrationInterface {
  name = 'CustomToolScopeIndexes1782200000038';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_custom_tools_org_name"
        ON custom_tools (name) WHERE scope = 'org'
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_custom_tools_team_name"
        ON custom_tools ("teamId", name) WHERE scope = 'team'
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_custom_tools_scope_enabled"
        ON custom_tools (scope, enabled)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_custom_tools_org_name"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_custom_tools_team_name"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_custom_tools_scope_enabled"`);
  }
}
