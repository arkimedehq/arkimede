import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds skills.kind ('typed' | 'descriptive', default 'typed'): distinguishes
 * skills with typed script manifests (LangGraph tools) from those in the "pure"
 * agentskills.io format (only SKILL.md + scripts/, executed via sandbox). S2.
 *
 * Backfill: existing skills without any registered script become 'descriptive'.
 *
 * name = 'SkillKind1784700000064'
 */
export class SkillKind1784700000064 implements MigrationInterface {
  name = 'SkillKind1784700000064';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "kind" varchar(16) NOT NULL DEFAULT 'typed'`,
    );
    // Backfill: skills without registered scripts → descriptive.
    await queryRunner.query(
      `UPDATE "skills" s SET "kind" = 'descriptive'
         WHERE NOT EXISTS (SELECT 1 FROM "skill_scripts" sc WHERE sc."skillId" = s."id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "skills" DROP COLUMN IF EXISTS "kind"`);
  }
}
