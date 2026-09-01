// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the agent_invocations table: log of agent calls coming from outside
 * the chat UI (OpenAI-compat shim: chat completions + audio routes). Chat
 * traffic keeps living in chats/messages; this table only holds truncated
 * previews and is trimmed by a retention sweep.
 *
 * New migration (not editing an applied one). IF NOT EXISTS → idempotent.
 */
export class AgentInvocations1786500000083 implements MigrationInterface {
  name = 'AgentInvocations1786500000083';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "agent_invocations" (
        "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "createdAt"     TIMESTAMP NOT NULL DEFAULT now(),
        "userId"        uuid,
        "origin"        varchar(30) NOT NULL,
        "route"         varchar(30) NOT NULL,
        "model"         varchar(120),
        "apiKeyPrefix"  varchar(40),
        "inputPreview"  text,
        "outputPreview" text,
        "toolCalls"     jsonb,
        "inputTokens"   int,
        "outputTokens"  int,
        "durationMs"    int,
        "status"        varchar(10) NOT NULL DEFAULT 'ok',
        "error"         text
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_agent_invocations_createdAt" ON "agent_invocations" ("createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_agent_invocations_userId" ON "agent_invocations" ("userId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_agent_invocations_userId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_agent_invocations_createdAt"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "agent_invocations"`);
  }
}
