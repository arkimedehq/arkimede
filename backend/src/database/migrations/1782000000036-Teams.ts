import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the tables for teams and memberships.
 *
 *  teams              — organization groups (unique name)
 *  team_memberships   — user↔team relation with role (owner|member)
 *
 * ON DELETE CASCADE: deleting a team or a user removes the related
 * memberships. Uniqueness constraint (teamId, userId) to avoid duplicates.
 *
 * name = 'Teams1782000000036'
 */
export class Teams1782000000036 implements MigrationInterface {
  name = 'Teams1782000000036';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS teams (
        id          uuid NOT NULL DEFAULT uuid_generate_v4(),
        name        varchar NOT NULL,
        description varchar,
        color       varchar(20),
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT pk_teams PRIMARY KEY (id),
        CONSTRAINT uq_teams_name UNIQUE (name)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS team_memberships (
        id          uuid NOT NULL DEFAULT uuid_generate_v4(),
        "teamId"    uuid NOT NULL,
        "userId"    uuid NOT NULL,
        role        varchar(20) NOT NULL DEFAULT 'member',
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT pk_team_memberships PRIMARY KEY (id),
        CONSTRAINT uq_team_membership UNIQUE ("teamId", "userId"),
        CONSTRAINT fk_membership_team FOREIGN KEY ("teamId")
          REFERENCES teams (id) ON DELETE CASCADE,
        CONSTRAINT fk_membership_user FOREIGN KEY ("userId")
          REFERENCES users (id) ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_membership_team ON team_memberships ("teamId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_membership_user ON team_memberships ("userId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS team_memberships`);
    await queryRunner.query(`DROP TABLE IF EXISTS teams`);
  }
}
