// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Host-level scheduled backups (scripts/backup.sh, run by root's cron on the host).
 *
 *   host_backup_config — single row (id = 1): what the admin sets from Settings → Backup
 *     (snapshot schedule as a cron expression, retention, base-backup weekday, WAL archiving
 *     switch, optional network destination with an encrypted connection URL) plus the
 *     live state the host job writes back
 *     (WAL shipping, spool size, archive gap, destination reachability).
 *   host_backup_runs   — one row per nightly/base backup and per alert raised by the job.
 *
 * The host script reads and writes these with psql; the backend only renders them.
 * New migration (not editing an applied one). IF NOT EXISTS → idempotent.
 */
export class HostBackup1787300000099 implements MigrationInterface {
  name = 'HostBackup1787300000099';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "host_backup_config" (
        "id" int PRIMARY KEY DEFAULT 1 CHECK ("id" = 1),
        "schedule" varchar(100) NOT NULL DEFAULT '15 2 * * *',
        "keepDaily" int NOT NULL DEFAULT 7,
        "keepBase" int NOT NULL DEFAULT 4,
        "baseWeekday" int NOT NULL DEFAULT 0,
        "walArchiving" boolean NOT NULL DEFAULT false,
        "destType" varchar(20) NOT NULL DEFAULT 'local',
        "destEncryptedUrl" text,
        "destLabel" text,
        "walAppliedMode" varchar(10),
        "walShippedAt" timestamptz,
        "walLastSegment" varchar(64),
        "walSpoolBytes" bigint,
        "walGapSegment" varchar(64),
        "destReachable" boolean,
        "destCheckedAt" timestamptz,
        "destResolved" text,
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`INSERT INTO "host_backup_config" ("id") VALUES (1) ON CONFLICT DO NOTHING`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "host_backup_runs" (
        "id" bigserial PRIMARY KEY,
        "kind" varchar(20) NOT NULL,
        "status" varchar(20) NOT NULL,
        "startedAt" timestamptz NOT NULL DEFAULT now(),
        "finishedAt" timestamptz,
        "sizeBytes" bigint,
        "location" text,
        "message" text
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_host_backup_runs_started" ON "host_backup_runs" ("startedAt" DESC)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "host_backup_runs"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "host_backup_config"`);
  }
}
