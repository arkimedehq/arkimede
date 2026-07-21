import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A-MEM F6 (AMEM_DESIGN.md): episodic conversation search (Hermes-style).
 * Generated tsvector over the message content ('simple' config: no stemming,
 * right for mixed it/en and for exact proper names/codes) + GIN index. Powers
 * the `search_conversations` tool — raw episodic recall ("ne abbiamo parlato
 * settimane fa") that the curated notes do not cover. No LLM in the loop.
 * The column is intentionally NOT mapped in the entity (queried raw).
 *
 * name = 'MessagesFts1785600000073'
 */
export class MessagesFts1785600000073 implements MigrationInterface {
  name = 'MessagesFts1785600000073';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "tsv" tsvector
      GENERATED ALWAYS AS (to_tsvector('simple', coalesce("content", ''))) STORED
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_messages_tsv" ON "messages" USING GIN ("tsv")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_messages_tsv"`);
    await queryRunner.query(`ALTER TABLE "messages" DROP COLUMN IF EXISTS "tsv"`);
  }
}
