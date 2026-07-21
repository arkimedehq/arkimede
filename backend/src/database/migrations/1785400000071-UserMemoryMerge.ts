import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A-MEM F3: merge proposals. A pending note carrying `mergeOfIds` is a
 * PROPOSAL to fuse those existing notes: on user confirmation the originals
 * are deleted (and deindexed) and the merged note takes their place. Merges
 * are never automatic (conservative-evolution decision).
 *
 * name = 'UserMemoryMerge1785400000071'
 */
export class UserMemoryMerge1785400000071 implements MigrationInterface {
  name = 'UserMemoryMerge1785400000071';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "user_memory" ADD COLUMN IF NOT EXISTS "mergeOfIds" jsonb NOT NULL DEFAULT '[]'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "user_memory" DROP COLUMN IF EXISTS "mergeOfIds"`);
  }
}
