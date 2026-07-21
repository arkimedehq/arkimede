import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Adds `contextNote` to `skill_scripts`.
 *
 * A free-form note editable by the user, injected by the agent service into the
 * description of the LangGraph DynamicStructuredTool. Allows informing
 * the LLM about runtime details not present in the static description
 * (e.g. trained ALS models, available profiles, current dataset).
 */
export class SkillScriptContextNote1781000000026 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'skill_scripts',
      new TableColumn({
        name:     'contextNote',
        type:     'text',
        isNullable: true,
        default:  null,
        comment:  'Free note injected into the LLM tool description. Editable by the user from the skill drawer.',
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('skill_scripts', 'contextNote');
  }
}
