// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * agents.actionReplies (boolean, default false): a turn whose last step only runs action tools ends with the reply
 * the model wrote with the calls, with no extra model call (agent/action-replies.ts). Off by default: every existing
 * agent keeps its behavior.
 *
 * name = 'AgentActionReplies1787300000106'
 */
export class AgentActionReplies1787300000106 implements MigrationInterface {
  name = 'AgentActionReplies1787300000106';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "actionReplies" boolean NOT NULL DEFAULT false`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "agents" DROP COLUMN IF EXISTS "actionReplies"`);
  }
}
