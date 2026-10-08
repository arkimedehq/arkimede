// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file postgres-collation.check.ts
 *
 * Start-up warning (never blocking) when a database's recorded collation version
 * differs from the C library Postgres runs on — typically an existing data dir
 * created by `postgres:16-alpine` (musl) now served by `pgvector/pgvector:pg16`
 * (glibc). Text sorts differently, so B-tree indexes on text columns may be
 * inconsistent until rebuilt: scripts/postgres-to-pgvector.sh does it.
 *
 * One cheap catalog query (PG ≥ 15: pg_database_collation_actual_version).
 * template0 (no connections) is ignored: initdb leaves its version unset.
 */
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

export const COLLATION_MISMATCH_SQL = `
  SELECT datname, datcollversion AS recorded, pg_database_collation_actual_version(oid) AS actual
    FROM pg_database
   WHERE datlocprovider = 'c' AND datallowconn
     AND datcollversion IS DISTINCT FROM pg_database_collation_actual_version(oid)
   ORDER BY datname`;

@Injectable()
export class PostgresCollationCheck implements OnApplicationBootstrap {
  private readonly logger = new Logger('PostgresCollationCheck');

  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  onApplicationBootstrap(): void {
    void this.check();
  }

  /** Returns the mismatched databases (and logs the warning); [] when fine or not checkable. */
  async check(): Promise<Array<{ datname: string; recorded: string | null; actual: string | null }>> {
    try {
      if (this.ds.options.type !== 'postgres') return [];
      const rows: Array<{ datname: string; recorded: string | null; actual: string | null }> =
        await this.ds.query(COLLATION_MISMATCH_SQL);
      if (rows.length) {
        const list = rows.map((r) => `${r.datname} (recorded ${r.recorded ?? 'none'}, C library ${r.actual ?? 'none'})`).join(', ');
        this.logger.warn(
          `Postgres collation version mismatch: ${list}. The C library differs from the one that built the ` +
          `text indexes (e.g. a data dir created by postgres:16-alpine now running on pgvector/pgvector:pg16): ` +
          `text indexes may be inconsistent. Run ./scripts/postgres-to-pgvector.sh (backup + REINDEX) once.`,
        );
      }
      return rows;
    } catch (err: any) {
      // Older Postgres (no pg_database_collation_actual_version) or no permission: nothing to say.
      this.logger.debug(`collation check skipped: ${err?.message ?? err}`);
      return [];
    }
  }
}
