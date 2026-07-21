import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Extends the scope of custom_tools from (personal|shared) to (personal|team|org).
 *
 *  - converts the `scope` column from enum to varchar(20)
 *  - migrates the values 'shared' → 'org'
 *  - adds `teamId` (uuid, nullable) with FK to teams(id) ON DELETE SET NULL:
 *    if the team is deleted, the tool remains but loses the reference (it will be
 *    visible only to the owner until it is reassigned/republished)
 *  - drops the old enum type if no longer referenced
 *
 * name = 'CustomToolScopeTeam1782100000037'
 */
export class CustomToolScopeTeam1782100000037 implements MigrationInterface {
  name = 'CustomToolScopeTeam1782100000037';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 0) drop the indexes that depend on the scope column (avoids conflicts with ALTER TYPE)
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_custom_tools_shared_name"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_custom_tools_scope_enabled"`);

    // 1) enum → varchar
    await queryRunner.query(`ALTER TABLE custom_tools ALTER COLUMN scope DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE custom_tools ALTER COLUMN scope TYPE VARCHAR(20)`);
    await queryRunner.query(`ALTER TABLE custom_tools ALTER COLUMN scope SET DEFAULT 'personal'`);

    // 2) migrate the values
    await queryRunner.query(`UPDATE custom_tools SET scope = 'org' WHERE scope = 'shared'`);

    // 3) drop the old enum if it exists and is no longer used
    await queryRunner.query(`DROP TYPE IF EXISTS custom_tools_scope_enum`);

    // 4) teamId + FK + indice
    await queryRunner.query(`ALTER TABLE custom_tools ADD COLUMN IF NOT EXISTS "teamId" uuid`);
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_name = 'fk_custom_tools_team'
        ) THEN
          ALTER TABLE custom_tools
            ADD CONSTRAINT fk_custom_tools_team FOREIGN KEY ("teamId")
            REFERENCES teams(id) ON DELETE SET NULL;
        END IF;
      END $$
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_custom_tools_team ON custom_tools ("teamId")`);

    // 5) partial unique index for the new scopes (defense in depth)
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_custom_tools_org_name"
        ON custom_tools (name) WHERE scope = 'org'
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_custom_tools_team_name"
        ON custom_tools ("teamId", name) WHERE scope = 'team'
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_custom_tools_scope_enabled" ON custom_tools (scope, enabled)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_custom_tools_org_name"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_custom_tools_team_name"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_custom_tools_scope_enabled"`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_custom_tools_team`);
    await queryRunner.query(`ALTER TABLE custom_tools DROP CONSTRAINT IF EXISTS fk_custom_tools_team`);
    await queryRunner.query(`ALTER TABLE custom_tools DROP COLUMN IF EXISTS "teamId"`);
    // restore the values and the type (org → shared; team → personal for safety)
    await queryRunner.query(`UPDATE custom_tools SET scope = 'shared' WHERE scope = 'org'`);
    await queryRunner.query(`UPDATE custom_tools SET scope = 'personal' WHERE scope = 'team'`);
    await queryRunner.query(`ALTER TABLE custom_tools ALTER COLUMN scope DROP DEFAULT`);
    await queryRunner.query(`CREATE TYPE custom_tools_scope_enum AS ENUM ('personal', 'shared')`);
    await queryRunner.query(`
      ALTER TABLE custom_tools
        ALTER COLUMN scope TYPE custom_tools_scope_enum USING scope::custom_tools_scope_enum
    `);
    await queryRunner.query(`ALTER TABLE custom_tools ALTER COLUMN scope SET DEFAULT 'personal'`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_custom_tools_shared_name" ON custom_tools (name) WHERE scope = 'shared'
    `);
    await queryRunner.query(`CREATE INDEX "IDX_custom_tools_scope_enabled" ON custom_tools (scope, enabled)`);
  }
}
