// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Long-lived opaque API keys (api_keys): per-user Bearer credentials for
 * service integrations (voice satellites, external clients). Only the SHA-256
 * hash is stored; revocation = row deletion; optional expiry.
 *
 * New migration (not editing an applied one). IF NOT EXISTS → idempotent.
 */
export class ApiKeys1786200000080 implements MigrationInterface {
  name = 'ApiKeys1786200000080';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "api_keys" (
        "id"         uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "userId"     uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "name"       varchar(120) NOT NULL,
        "keyHash"    varchar(64) NOT NULL UNIQUE,
        "prefix"     varchar(16) NOT NULL,
        "expiresAt"  timestamptz,
        "lastUsedAt" timestamptz,
        "createdAt"  timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_api_keys_userId" ON "api_keys" ("userId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "api_keys"`);
  }
}
