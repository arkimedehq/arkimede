import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Extends the scope of data_sources from (personal|shared) to (personal|team|org).
 * Same schema as CustomToolScopeTeam: enum→varchar, shared→org, teamId + FK,
 * partial unique index for org/team.
 *
 * name = 'DataSourceScopeTeam1782400000040'
 */
export class DataSourceScopeTeam1782400000040 implements MigrationInterface {
  name = 'DataSourceScopeTeam1782400000040';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_data_sources_scope"`);

    await queryRunner.query(`ALTER TABLE data_sources ALTER COLUMN scope DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE data_sources ALTER COLUMN scope TYPE VARCHAR(20)`);
    await queryRunner.query(`ALTER TABLE data_sources ALTER COLUMN scope SET DEFAULT 'personal'`);

    await queryRunner.query(`UPDATE data_sources SET scope = 'org' WHERE scope = 'shared'`);
    await queryRunner.query(`DROP TYPE IF EXISTS data_sources_scope_enum`);

    await queryRunner.query(`ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS "teamId" uuid`);
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'fk_data_sources_team'
        ) THEN
          ALTER TABLE data_sources
            ADD CONSTRAINT fk_data_sources_team FOREIGN KEY ("teamId")
            REFERENCES teams(id) ON DELETE SET NULL;
        END IF;
      END $$
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_data_sources_scope" ON data_sources (scope)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_data_sources_team ON data_sources ("teamId")`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_data_sources_org_name"
        ON data_sources (name) WHERE scope = 'org'
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_data_sources_team_name"
        ON data_sources ("teamId", name) WHERE scope = 'team'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_data_sources_org_name"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_data_sources_team_name"`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_data_sources_team`);
    await queryRunner.query(`ALTER TABLE data_sources DROP CONSTRAINT IF EXISTS fk_data_sources_team`);
    await queryRunner.query(`ALTER TABLE data_sources DROP COLUMN IF EXISTS "teamId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_data_sources_scope"`);

    await queryRunner.query(`UPDATE data_sources SET scope = 'shared' WHERE scope = 'org'`);
    await queryRunner.query(`UPDATE data_sources SET scope = 'personal' WHERE scope = 'team'`);
    await queryRunner.query(`ALTER TABLE data_sources ALTER COLUMN scope DROP DEFAULT`);
    await queryRunner.query(`CREATE TYPE data_sources_scope_enum AS ENUM ('personal', 'shared')`);
    await queryRunner.query(`ALTER TABLE data_sources ALTER COLUMN scope TYPE data_sources_scope_enum USING scope::data_sources_scope_enum`);
    await queryRunner.query(`ALTER TABLE data_sources ALTER COLUMN scope SET DEFAULT 'personal'`);
    await queryRunner.query(`CREATE INDEX "IDX_data_sources_scope" ON data_sources (scope)`);
  }
}
