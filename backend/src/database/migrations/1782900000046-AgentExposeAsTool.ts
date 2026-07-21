import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Agent/Team as a tool (hierarchical delegation).
 *
 * Adds `agents.exposeAsTool` and `agent_teams.exposeAsTool`: if true, the resource
 * is exposed as a DynamicStructuredTool (`agent_<slug>` / `team_<slug>`) and the
 * main model can delegate a task to it without seeing its internal tools. Mirror of
 * `flows.exposeAsTool`.
 *
 * name = 'AgentExposeAsTool1782900000046'
 */
export class AgentExposeAsTool1782900000046 implements MigrationInterface {
  name = 'AgentExposeAsTool1782900000046';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS "exposeAsTool" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(`ALTER TABLE agent_teams ADD COLUMN IF NOT EXISTS "exposeAsTool" boolean NOT NULL DEFAULT false`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE agents DROP COLUMN IF EXISTS "exposeAsTool"`);
    await queryRunner.query(`ALTER TABLE agent_teams DROP COLUMN IF EXISTS "exposeAsTool"`);
  }
}
