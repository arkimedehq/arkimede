import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `nix_deps` column to the `skills` table.
 *
 * Contains the names of the nixpkgs packages declared in skill.yaml
 * under `dependencies.system.nix` (e.g. ["cowsay", "imagemagick"]).
 * Identical structure to `python_deps` and `js_deps`.
 */
export class AddNixDeps1780300000019 implements MigrationInterface {
  name = 'AddNixDeps1780300000019';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "skills"
      ADD COLUMN IF NOT EXISTS "nixDeps" jsonb NOT NULL DEFAULT '[]'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "skills"
      DROP COLUMN IF EXISTS "nixDeps"
    `);
  }
}
