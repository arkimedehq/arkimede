import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Multi-Agent (Level 2) — reusable agents composable into teams.
 *
 * `agents`: agent = systemPrompt + llmConfigId + toolFilter (scope p|t|o).
 * `agent_teams`: team = topology (supervisor|sequential|parallel) + supervisor.
 * `agent_team_members`: join agents↔team with order and role.
 *
 * name = 'CreateAgents1782800000044'
 */
export class CreateAgents1782800000044 implements MigrationInterface {
  name = 'CreateAgents1782800000044';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS agents (
        id             uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "userId"       uuid NOT NULL,
        name           varchar(120) NOT NULL,
        description    text,
        "systemPrompt" text NOT NULL DEFAULT '',
        "llmConfigId"  uuid,
        "toolFilter"   jsonb NOT NULL DEFAULT '{"mode":"all"}',
        "maxIterations" int,
        scope          varchar(16) NOT NULL DEFAULT 'personal',
        "teamId"       uuid,
        "createdAt"    timestamp NOT NULL DEFAULT now(),
        "updatedAt"    timestamp NOT NULL DEFAULT now(),
        CONSTRAINT fk_agents_user FOREIGN KEY ("userId") REFERENCES users (id) ON DELETE CASCADE,
        CONSTRAINT fk_agents_team FOREIGN KEY ("teamId") REFERENCES teams (id) ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_agents_user ON agents ("userId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_agents_scope ON agents (scope)`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS agent_teams (
        id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "userId"            uuid NOT NULL,
        name                varchar(120) NOT NULL,
        description         text,
        topology            varchar(16) NOT NULL DEFAULT 'supervisor',
        "supervisorAgentId" uuid,
        scope               varchar(16) NOT NULL DEFAULT 'personal',
        "teamId"            uuid,
        "createdAt"         timestamp NOT NULL DEFAULT now(),
        "updatedAt"         timestamp NOT NULL DEFAULT now(),
        CONSTRAINT fk_agent_teams_user FOREIGN KEY ("userId") REFERENCES users (id) ON DELETE CASCADE,
        CONSTRAINT fk_agent_teams_team FOREIGN KEY ("teamId") REFERENCES teams (id) ON DELETE SET NULL,
        CONSTRAINT fk_agent_teams_supervisor FOREIGN KEY ("supervisorAgentId") REFERENCES agents (id) ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_agent_teams_user ON agent_teams ("userId")`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS agent_team_members (
        id        uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "teamId"  uuid NOT NULL,
        "agentId" uuid NOT NULL,
        position  int NOT NULL DEFAULT 0,
        role      varchar(80),
        CONSTRAINT fk_atm_team FOREIGN KEY ("teamId") REFERENCES agent_teams (id) ON DELETE CASCADE,
        CONSTRAINT fk_atm_agent FOREIGN KEY ("agentId") REFERENCES agents (id) ON DELETE CASCADE,
        CONSTRAINT uq_atm UNIQUE ("teamId", "agentId")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_atm_team ON agent_team_members ("teamId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS agent_team_members`);
    await queryRunner.query(`DROP TABLE IF EXISTS agent_teams`);
    await queryRunner.query(`DROP TABLE IF EXISTS agents`);
  }
}
