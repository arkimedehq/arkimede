import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Chat ↔ Multi-Agent integration (MA-4).
 *
 * Adds `chats.agentTeamId`: if set, the chat is executed with a
 * team of agents instead of the single agent. ON DELETE SET NULL: deleting the
 * team, the chat reverts to single-agent behavior.
 *
 * name = 'ChatAgentTeam1782900000045'
 */
export class ChatAgentTeam1782900000045 implements MigrationInterface {
  name = 'ChatAgentTeam1782900000045';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE chats ADD COLUMN IF NOT EXISTS "agentTeamId" uuid`);
    await queryRunner.query(`
      ALTER TABLE chats
        ADD CONSTRAINT fk_chats_agent_team FOREIGN KEY ("agentTeamId")
        REFERENCES agent_teams (id) ON DELETE SET NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE chats DROP CONSTRAINT IF EXISTS fk_chats_agent_team`);
    await queryRunner.query(`ALTER TABLE chats DROP COLUMN IF EXISTS "agentTeamId"`);
  }
}
