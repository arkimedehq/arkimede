import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Flows — deterministic graph workflows (Slice 1).
 *
 * `flows`: graph definition (nodes+edges+binding) in jsonb, trigger, scope
 * personal|team|org (like custom tools/skills/data sources).
 * `flow_runs`: execution history (state + per-node timeline) for observability.
 *
 * name = 'CreateFlows1782700000043'
 */
export class CreateFlows1782700000043 implements MigrationInterface {
  name = 'CreateFlows1782700000043';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS flows (
        id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "userId"      uuid NOT NULL,
        name          varchar(120) NOT NULL,
        description   text,
        definition    jsonb NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
        trigger       jsonb NOT NULL DEFAULT '{"type":"manual"}',
        "inputSchema" jsonb NOT NULL DEFAULT '[]',
        "exposeAsTool" boolean NOT NULL DEFAULT false,
        enabled       boolean NOT NULL DEFAULT true,
        scope         varchar(16) NOT NULL DEFAULT 'personal',
        "teamId"      uuid,
        "createdAt"   timestamp NOT NULL DEFAULT now(),
        "updatedAt"   timestamp NOT NULL DEFAULT now(),
        CONSTRAINT fk_flows_user FOREIGN KEY ("userId") REFERENCES users (id) ON DELETE CASCADE,
        CONSTRAINT fk_flows_team FOREIGN KEY ("teamId") REFERENCES teams (id) ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_flows_user ON flows ("userId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_flows_scope ON flows (scope)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_flows_team ON flows ("teamId")`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS flow_runs (
        id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "flowId"      uuid,
        "flowName"    varchar(120),
        "userId"      uuid,
        "projectId"   uuid,
        "triggeredBy" varchar(16) NOT NULL DEFAULT 'manual',
        status        varchar(16) NOT NULL DEFAULT 'running',
        state         jsonb NOT NULL DEFAULT '{"input":{},"nodes":{}}',
        "nodeRuns"    jsonb NOT NULL DEFAULT '[]',
        error         text,
        "startedAt"   timestamp NOT NULL DEFAULT now(),
        "finishedAt"  timestamp,
        CONSTRAINT fk_flow_runs_flow FOREIGN KEY ("flowId") REFERENCES flows (id) ON DELETE SET NULL,
        CONSTRAINT fk_flow_runs_user FOREIGN KEY ("userId") REFERENCES users (id) ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_flow_runs_flow ON flow_runs ("flowId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_flow_runs_user ON flow_runs ("userId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS flow_runs`);
    await queryRunner.query(`DROP TABLE IF EXISTS flows`);
  }
}
