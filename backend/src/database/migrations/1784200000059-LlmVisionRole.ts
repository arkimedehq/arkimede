import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the "vision" role to the multi-record LLM configs.
 *
 * `llm_configs.isVision` designates the model to use for tasks that require
 * multimodal capabilities (today: image OCR for RAG indexing in
 * FilesService). Same pattern as `isDefault`/`isSummarizer`: only one at a
 * time, fallback to the default if none is designated.
 *
 * Replaces the old OCR hardcoded on Anthropic (claude-haiku via direct
 * SDK + ANTHROPIC_API_KEY from env) with the cross-provider LangChain pipeline.
 *
 * name = 'LlmVisionRole1784200000059'
 */
export class LlmVisionRole1784200000059 implements MigrationInterface {
  name = 'LlmVisionRole1784200000059';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "llm_configs"
        ADD COLUMN IF NOT EXISTS "isVision" boolean NOT NULL DEFAULT false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "llm_configs" DROP COLUMN IF EXISTS "isVision"
    `);
  }
}
