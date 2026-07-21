import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Adds `lastInfoOutput` to `skill_scripts`.
 *
 * Stores the last stdout of the info script (mode='info') after each successful
 * execution. It is injected into the description of the DynamicStructuredTool
 * as a fallback when the user has not written a manual contextNote.
 */
export class SkillScriptLastInfoOutput1781100000027 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'skill_scripts',
      new TableColumn({
        name:       'lastInfoOutput',
        type:       'text',
        isNullable: true,
        default:    null,
        comment:    'Last stdout of the info script, saved automatically after each successful run.',
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('skill_scripts', 'lastInfoOutput');
  }
}
