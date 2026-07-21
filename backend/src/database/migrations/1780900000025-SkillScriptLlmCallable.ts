import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Adds the `llmCallable` column to the `skill_scripts` table.
 *
 * Controls whether the script is exposed to the LLM as a LangGraph DynamicStructuredTool:
 *   true  (default) — previous behavior unchanged: the script is an LLM tool.
 *   false           — script invokable ONLY via the inter-skill bus
 *                     (POST /internal/skills/:id/invoke), invisible to the agent.
 *
 * Default true guarantees backward compatibility: all existing skills
 * keep exposing their scripts to the LLM as before.
 */
export class SkillScriptLlmCallable1780900000025 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'skill_scripts',
      new TableColumn({
        name:    'llmCallable',
        type:    'boolean',
        default: true,
        comment: 'If false, the script is invisible to the LLM and callable only via the inter-skill bus.',
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('skill_scripts', 'llmCallable');
  }
}
