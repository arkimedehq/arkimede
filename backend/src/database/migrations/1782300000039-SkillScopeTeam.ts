import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Extends the scope of skills from (personal|shared) to (personal|team|org).
 *
 *  - drops the indexes depending on the scope column
 *  - converts `scope` from enum to varchar(20)
 *  - migrates 'shared' → 'org'
 *  - adds `teamId` (uuid, nullable) FK to teams(id) ON DELETE SET NULL
 *  - recreates the indexes for the new scopes
 *
 * name = 'SkillScopeTeam1782300000039'
 */
export class SkillScopeTeam1782300000039 implements MigrationInterface {
  name = 'SkillScopeTeam1782300000039';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_skills_scope_approved"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_skills_shared_name"`);

    await queryRunner.query(`ALTER TABLE skills ALTER COLUMN scope DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE skills ALTER COLUMN scope TYPE VARCHAR(20)`);
    await queryRunner.query(`ALTER TABLE skills ALTER COLUMN scope SET DEFAULT 'personal'`);

    await queryRunner.query(`UPDATE skills SET scope = 'org' WHERE scope = 'shared'`);
    await queryRunner.query(`DROP TYPE IF EXISTS skills_scope_enum`);

    await queryRunner.query(`ALTER TABLE skills ADD COLUMN IF NOT EXISTS "teamId" uuid`);
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'fk_skills_team'
        ) THEN
          ALTER TABLE skills
            ADD CONSTRAINT fk_skills_team FOREIGN KEY ("teamId")
            REFERENCES teams(id) ON DELETE SET NULL;
        END IF;
      END $$
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_skills_team ON skills ("teamId")`);

    // browse approved org ones
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_skills_scope_approved"
        ON skills (scope, "isApproved") WHERE scope = 'org'
    `);
    // name uniqueness: org global, team per-team
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_skills_org_name"
        ON skills (name) WHERE scope = 'org'
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_skills_team_name"
        ON skills ("teamId", name) WHERE scope = 'team'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_skills_org_name"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_skills_team_name"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_skills_scope_approved"`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_skills_team`);
    await queryRunner.query(`ALTER TABLE skills DROP CONSTRAINT IF EXISTS fk_skills_team`);
    await queryRunner.query(`ALTER TABLE skills DROP COLUMN IF EXISTS "teamId"`);

    await queryRunner.query(`UPDATE skills SET scope = 'shared' WHERE scope = 'org'`);
    await queryRunner.query(`UPDATE skills SET scope = 'personal' WHERE scope = 'team'`);
    await queryRunner.query(`ALTER TABLE skills ALTER COLUMN scope DROP DEFAULT`);
    await queryRunner.query(`CREATE TYPE skills_scope_enum AS ENUM ('personal', 'shared')`);
    await queryRunner.query(`ALTER TABLE skills ALTER COLUMN scope TYPE skills_scope_enum USING scope::skills_scope_enum`);
    await queryRunner.query(`ALTER TABLE skills ALTER COLUMN scope SET DEFAULT 'personal'`);
    await queryRunner.query(`CREATE INDEX "IDX_skills_scope_approved" ON skills (scope, "isApproved") WHERE scope = 'shared'`);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_skills_shared_name" ON skills (name) WHERE scope = 'shared'`);
  }
}
