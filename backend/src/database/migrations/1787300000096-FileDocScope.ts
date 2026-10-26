// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The visibility of an indexed document recorded on its file (universal | project | personal, as its chunks carry it),
 * so the file panel can show and change it: files.vectorScope, files.vectorProjectId. Null for files indexed before.
 *
 * New migration (not editing an applied one). Guarded → idempotent.
 */
export class FileDocScope1787300000096 implements MigrationInterface {
  name = 'FileDocScope1787300000096';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "vectorScope" varchar(20)`);
    await queryRunner.query(`ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "vectorProjectId" uuid`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "files" DROP COLUMN IF EXISTS "vectorProjectId"`);
    await queryRunner.query(`ALTER TABLE "files" DROP COLUMN IF EXISTS "vectorScope"`);
  }
}
