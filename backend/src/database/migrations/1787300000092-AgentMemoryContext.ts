// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * agents.memoryContext: before each answer the agent gets the user's memories relevant to the message from Recordare
 * (a fenced `<memory-context>` block at the end of the system prompt). Per agent, off by default: useful where latency
 * matters (voice), measured in Recordare (WORK_PLAN 5.7). New migration; IF NOT EXISTS → idempotent.
 */
export class AgentMemoryContext1787300000092 implements MigrationInterface {
  name = 'AgentMemoryContext1787300000092';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "memoryContext" boolean NOT NULL DEFAULT false`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "agents" DROP COLUMN IF EXISTS "memoryContext"`);
  }
}
