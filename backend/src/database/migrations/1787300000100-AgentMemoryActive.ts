// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * agents.memoryContext becomes "memory active" (the memory-first contract, Recordare D54): every agent has its memory —
 * charter, context before each answer, memory tools — unless it is turned off explicitly. New default true, and the
 * existing agents on (until now the column only opted into the context block). Idempotent.
 */
export class AgentMemoryActive1787300000100 implements MigrationInterface {
  name = 'AgentMemoryActive1787300000100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "agents" ALTER COLUMN "memoryContext" SET DEFAULT true`);
    await queryRunner.query(`UPDATE "agents" SET "memoryContext" = true WHERE "memoryContext" = false`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "agents" ALTER COLUMN "memoryContext" SET DEFAULT false`);
  }
}
