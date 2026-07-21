import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A-MEM F2 (AMEM_DESIGN.md): full-text leg of the hybrid retrieval. Generated
 * tsvector over content + context + keywords ('simple' config: no stemming —
 * right call for mixed it/en and for exact proper names) + GIN index.
 * The column is intentionally NOT mapped in the entity (queried raw).
 *
 * name = 'UserMemoryFts1785300000070'
 */
export class UserMemoryFts1785300000070 implements MigrationInterface {
  name = 'UserMemoryFts1785300000070';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "user_memory" ADD COLUMN IF NOT EXISTS "tsv" tsvector
      GENERATED ALWAYS AS (
        to_tsvector('simple',
          coalesce("content", '') || ' ' || coalesce("context", '') || ' ' || coalesce("keywords"::text, ''))
      ) STORED
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_user_memory_tsv" ON "user_memory" USING GIN ("tsv")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_user_memory_tsv"`);
    await queryRunner.query(`ALTER TABLE "user_memory" DROP COLUMN IF EXISTS "tsv"`);
  }
}
