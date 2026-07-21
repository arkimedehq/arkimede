/**
 * @file sqlite.driver.ts
 *
 * SQLite driver (optional package `better-sqlite3`, lazy-loaded). The API is
 * synchronous: we wrap the calls in Promises to comply with the interface.
 *
 * Connection string: `sqlite:///abs/path.db`, `sqlite://./rel/path.db`,
 * `sqlite::memory:` or a bare file path. Read-only via `PRAGMA query_only`.
 */
import {
  SqlDriver, SqlExecuteOptions, SqlExecuteResult,
  IntrospectTable, IntrospectColumn, IntrospectRelation,
} from './sql-driver.interface';
import { extractNamedParams } from './param-binding';
import { addLimit } from './sql-syntax';
import { loadOptional } from './optional-module';

const dbs = new Map<string, any>();

/** Extracts the file path from the sqlite connection string. */
function toPath(connStr: string): string {
  if (/^sqlite::memory:$/i.test(connStr) || connStr === ':memory:') return ':memory:';
  let p = connStr.replace(/^sqlite:/i, '');
  p = p.replace(/^\/\//, '');        // sqlite://  → the path remains (incl. any leading /)
  return p || ':memory:';
}

function getDb(connStr: string, timeout: number): any {
  if (!dbs.has(connStr)) {
    const Database = loadOptional('better-sqlite3', 'sqlite');
    const db = new Database(toPath(connStr), { timeout });
    dbs.set(connStr, db);
  }
  return dbs.get(connStr)!;
}

/** Quotes an identifier for PRAGMAs (which do not accept bind params). */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export const sqliteDriver: SqlDriver = {
  engine: 'sqlite',
  scheme: 'sqlite:///path/to/file.db',
  syntaxHint: 'Use SQLite syntax (LIMIT n).',

  async testConnection(connStr, timeout = 5000) {
    getDb(connStr, timeout).prepare('SELECT 1').get();
  },

  applyRowLimit(sql, maxRows) {
    return addLimit(sql, maxRows);
  },

  async execute(connStr, opts: SqlExecuteOptions): Promise<SqlExecuteResult> {
    const db = getDb(connStr, opts.timeout);
    if (opts.readOnly) db.pragma('query_only = true');
    try {
      const stmt = db.prepare(opts.sql);
      const params = opts.rawQuery ? undefined : extractNamedParams(opts.sql, opts.params);
      if (stmt.reader) {
        const rows = (params ? stmt.all(params) : stmt.all()) as Record<string, unknown>[];
        return { rows, affected: rows.length };
      }
      const info = params ? stmt.run(params) : stmt.run();
      return { rows: [], affected: Number(info.changes ?? 0) };
    } finally {
      if (opts.readOnly) db.pragma('query_only = false');
    }
  },

  async fetchTables(connStr, timeout): Promise<IntrospectTable[]> {
    const db = getDb(connStr, timeout);
    const rows = db.prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name`).all() as Array<{ name: string }>;
    return rows.map((r) => ({ name: String(r.name), comment: '' }));
  },

  async fetchAllColumns(connStr, timeout): Promise<IntrospectColumn[]> {
    const tables = await this.fetchTables(connStr, timeout);
    const out: IntrospectColumn[] = [];
    for (const t of tables) {
      for (const c of await this.fetchColumns(connStr, timeout, [t.name])) out.push(c);
    }
    return out;
  },

  async fetchColumns(connStr, timeout, names): Promise<IntrospectColumn[]> {
    const db = getDb(connStr, timeout);
    const out: IntrospectColumn[] = [];
    for (const tableName of names) {
      const rows = db.prepare(`PRAGMA table_info(${quoteIdent(tableName)})`).all() as
        Array<{ name: string; type: string; notnull: number }>;
      for (const r of rows) {
        out.push({
          tableName, name: String(r.name), type: String(r.type ?? ''),
          comment: '', nullable: r.notnull === 0,
        });
      }
    }
    return out;
  },

  async fetchRelations(connStr, timeout): Promise<IntrospectRelation[]> {
    const db = getDb(connStr, timeout);
    const tables = await this.fetchTables(connStr, timeout);
    const out: IntrospectRelation[] = [];
    for (const t of tables) {
      const rows = db.prepare(`PRAGMA foreign_key_list(${quoteIdent(t.name)})`).all() as
        Array<{ table: string; from: string; to: string }>;
      for (const r of rows) {
        out.push({ fromTable: t.name, fromCol: String(r.from), toTable: String(r.table), toCol: String(r.to) });
      }
    }
    return out;
  },
};
