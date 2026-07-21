import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds skills.grantedNetworks (Phase 3): reserved Docker networks (LAN/VPN/subnets)
 * granted per-skill by an admin. Each entry is a catalog id (see SKILL_NETWORK_CATALOG)
 * resolved to an operator-provisioned Docker network at invocation. Default [] = only
 * the baseline internal BE network. Separate from networkDomains (author-declared egress).
 */
export class SkillGrantedNetworks1785700000074 implements MigrationInterface {
  name = 'SkillGrantedNetworks1785700000074';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "grantedNetworks" jsonb NOT NULL DEFAULT '[]'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "skills" DROP COLUMN IF EXISTS "grantedNetworks"`);
  }
}
