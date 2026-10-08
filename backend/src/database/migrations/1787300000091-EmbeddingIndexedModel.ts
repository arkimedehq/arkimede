// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * app_config.embeddingIndexedModel: identity (`provider|model|dims`) of the embedding
 * model that produced the stored vectors. Recorded by the re-embed job and on an
 * empty vector store; compared at start-up with the active model (vector-db/
 * embedding-model.check.ts) to warn when they differ. NULL = unknown (installs
 * indexed before this column existed).
 *
 * New migration (not editing an applied one). IF NOT EXISTS → idempotent.
 */
export class EmbeddingIndexedModel1787300000091 implements MigrationInterface {
  name = 'EmbeddingIndexedModel1787300000091';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "app_config" ADD COLUMN IF NOT EXISTS "embeddingIndexedModel" varchar(300) NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "app_config" DROP COLUMN IF EXISTS "embeddingIndexedModel"`);
  }
}
