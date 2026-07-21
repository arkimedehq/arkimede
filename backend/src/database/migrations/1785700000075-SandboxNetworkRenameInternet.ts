import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Network-vocabulary unification: the sandbox network tier value 'egress' is renamed to
 * 'internet' (aligned with skill jobs and the unified none|internal|internet|open model).
 * 'none' and 'open' are unchanged. Idempotent (only touches rows still on 'egress').
 */
export class SandboxNetworkRenameInternet1785700000075 implements MigrationInterface {
  name = 'SandboxNetworkRenameInternet1785700000075';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "app_config" SET "sandboxNetwork" = 'internet' WHERE "sandboxNetwork" = 'egress'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "app_config" SET "sandboxNetwork" = 'egress' WHERE "sandboxNetwork" = 'internet'`,
    );
  }
}
