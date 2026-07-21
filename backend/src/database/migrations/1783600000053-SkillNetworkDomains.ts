import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds skills.networkDomains (C1): allowed egress domains, from
 * skill.yaml → `network:`. Default [] = no egress.
 *
 * name = 'SkillNetworkDomains1783600000053'
 */
export class SkillNetworkDomains1783600000053 implements MigrationInterface {
  name = 'SkillNetworkDomains1783600000053';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "networkDomains" jsonb NOT NULL DEFAULT '[]'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "skills" DROP COLUMN IF EXISTS "networkDomains"`);
  }
}
