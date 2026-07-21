import { MigrationInterface, QueryRunner } from 'typeorm';

export class SkillSourceId1781200000028 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      ALTER TABLE "skills"
      ADD COLUMN IF NOT EXISTS "sourceSkillId" uuid DEFAULT NULL
        REFERENCES "skills"("id") ON DELETE SET NULL
    `);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE "skills" DROP COLUMN IF EXISTS "sourceSkillId"`);
  }
}
