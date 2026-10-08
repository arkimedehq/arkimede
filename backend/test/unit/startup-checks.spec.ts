// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Start-up checks (warnings only, never blocking): Postgres collation-version
 * mismatch (alpine/musl → pgvector/glibc data dir) and embedding model of the
 * stored vectors vs the active one. Mocked queries, no database.
 */
import { describe, it, expect, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { PostgresCollationCheck, COLLATION_MISMATCH_SQL } from '../../src/database/postgres-collation.check';
import { EmbeddingModelCheck, embeddingIdentity } from '../../src/vector-db/embedding-model.check';

function spyWarn() {
  return vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
}

describe('PostgresCollationCheck', () => {
  const ds = (rows: any[] | Error, type = 'postgres') => ({
    options: { type },
    query: vi.fn(async (sql: string) => { if (rows instanceof Error) throw rows; expect(sql).toBe(COLLATION_MISMATCH_SQL); return rows; }),
  }) as any;

  it('warns with the databases and the script when a collation version differs', async () => {
    const warn = spyWarn();
    const rows = [{ datname: 'arkimede', recorded: null, actual: '2.36' }];
    expect(await new PostgresCollationCheck(ds(rows)).check()).toEqual(rows);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toMatch(/arkimede \(recorded none, C library 2\.36\).*postgres-to-pgvector\.sh/s);
    warn.mockRestore();
  });

  it('is silent when versions match, and never throws (old Postgres / no permission / not postgres)', async () => {
    const warn = spyWarn();
    expect(await new PostgresCollationCheck(ds([])).check()).toEqual([]);
    expect(await new PostgresCollationCheck(ds(new Error('function pg_database_collation_actual_version does not exist'))).check()).toEqual([]);
    const sqlite = ds([], 'better-sqlite3');
    expect(await new PostgresCollationCheck(sqlite).check()).toEqual([]);
    expect(sqlite.query).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('the query ignores template0 and non-libc providers, and catches a NULL recorded version', () => {
    expect(COLLATION_MISMATCH_SQL).toMatch(/datlocprovider = 'c'/);
    expect(COLLATION_MISMATCH_SQL).toMatch(/datallowconn/);
    expect(COLLATION_MISMATCH_SQL).toMatch(/IS DISTINCT FROM/); // NULL (musl) vs '2.36' (glibc) counts
  });
});

describe('EmbeddingModelCheck', () => {
  const BGE = { provider: 'internal', model: 'BAAI/bge-m3', vectorSize: 1024, confirmed: true };
  const MXBAI = 'internal|mixedbread-ai/mxbai-embed-large-v1|1024';

  function setup(opts: { active?: any; stored?: string | null; points?: Record<string, number> }) {
    const writes: any[] = [];
    const ds = {
      query: vi.fn(async (sql: string, params: any[]) => {
        if (sql.startsWith('SELECT')) return [{ embeddingIndexedModel: opts.stored ?? null }];
        writes.push(params);
        return [];
      }),
    } as any;
    const embedding = {
      getActive: vi.fn(async () => opts.active ?? BGE),
      invalidateCache: vi.fn(),
    } as any;
    const points = opts.points ?? {};
    const store = {
      listCollections: vi.fn(async () => Object.keys(points)),
      getCollectionInfo: vi.fn(async (n: string) => ({ exists: true, pointsCount: points[n] })),
    } as any;
    return { check: new EmbeddingModelCheck(ds, embedding, store), writes, embedding };
  }

  it('match: same model recorded → silent', async () => {
    const warn = spyWarn();
    const { check } = setup({ stored: embeddingIdentity(BGE) });
    expect(await check.check()).toBe('match');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('mismatch: vectors from another model (same 1024 dims) → clear warning pointing to the re-embed job', async () => {
    const warn = spyWarn();
    const { check, writes } = setup({ stored: MXBAI, points: { docs: 10 } });
    expect(await check.check()).toBe('mismatch');
    expect(String(warn.mock.calls[0][0])).toMatch(/mxbai-embed-large-v1.*BAAI\/bge-m3.*reembed/s);
    expect(writes).toHaveLength(0); // never overwritten by the check
    warn.mockRestore();
  });

  it('unknown with vectors present → warns, does NOT guess (nothing recorded)', async () => {
    const warn = spyWarn();
    const { check, writes } = setup({ stored: null, points: { empty: 0, docs: 3 } });
    expect(await check.check()).toBe('unknown');
    expect(warn).toHaveBeenCalledOnce();
    expect(writes).toHaveLength(0);
    warn.mockRestore();
  });

  it('unknown with an empty store (fresh install) → records the active model, no warning', async () => {
    const warn = spyWarn();
    const { check, writes } = setup({ stored: null, points: { a: 0 } });
    expect(await check.check()).toBe('recorded-fresh');
    expect(writes).toEqual([[embeddingIdentity(BGE), 1]]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('internal service not answering yet (fallback model) → not-ready, no comparison, probe again', async () => {
    const warn = spyWarn();
    const { check, writes, embedding } = setup({ active: { ...BGE, confirmed: false }, stored: MXBAI });
    expect(await check.check()).toBe('not-ready');
    expect(embedding.invalidateCache).toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
    warn.mockRestore();
  });

  it('never throws', async () => {
    const { check, embedding } = setup({});
    embedding.getActive.mockRejectedValueOnce(new Error('down'));
    expect(await check.check()).toBe('error');
  });
});
