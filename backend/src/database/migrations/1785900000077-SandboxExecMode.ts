import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds app_config.sandboxExecMode ('hardened' | 'trusted', default 'hardened').
 *
 * hardened = read-only rootfs + non-root + cap-drop ALL (current behavior).
 * trusted  = writable rootfs + root + default caps (runtime apt-get). A security
 * downgrade, additionally gated by BROKER_ALLOW_PRIVILEGED_SANDBOX on the broker.
 *
 * New migration (not editing an applied one). IF NOT EXISTS → idempotent.
 */
export class SandboxExecMode1785900000077 implements MigrationInterface {
  name = 'SandboxExecMode1785900000077';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "sandboxExecMode" varchar(10) NOT NULL DEFAULT 'hardened'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "app_config" DROP COLUMN IF EXISTS "sandboxExecMode"`);
  }
}
