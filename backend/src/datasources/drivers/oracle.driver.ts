/**
 * @file oracle.driver.ts
 *
 * Oracle driver (optional package `oracledb`, lazy-loaded). Uses "thin" mode by
 * default (no Instant Client required for common cases).
 *
 * Custom connection string: `oracle://user:pass@host:1521/service`, translated into
 * the native parameters { user, password, connectString: "host:1521/service" }.
 *
 * Read-only: `SET TRANSACTION READ ONLY` for read-only tools; writes use autoCommit.
 * Oracle binds `:name` named params natively.
 */
import {
  SqlDriver, SqlExecuteOptions, SqlExecuteResult,
  IntrospectTable, IntrospectColumn, IntrospectRelation,
} from './sql-driver.interface';
import { extractNamedParams } from './param-binding';
import { addFetchFirst } from './sql-syntax';
import { loadOptional } from './optional-module';

const pools = new Map<string, Promise<any>>();

function oracledb(): any {
  return loadOptional('oracledb', 'oracle');
}

/** Translates `oracle://user:pass@host:port/service` into oracledb parameters. */
function parseConn(connStr: string): { user: string; password: string; connectString: string } {
  const u = new URL(connStr);
  const port = u.port || '1521';
  const service = u.pathname.replace(/^\//, '');
  return {
    user:          decodeURIComponent(u.username),
    password:      decodeURIComponent(u.password),
    connectString: `${u.hostname}:${port}/${service}`,
  };
}

function getPool(connStr: string): Promise<any> {
  if (!pools.has(connStr)) {
    const odb = oracledb();
    const cfg = parseConn(connStr);
    pools.set(connStr, odb.createPool({ ...cfg, poolMin: 0, poolMax: 3 }).catch((e: any) => {
      pools.delete(connStr);
      throw e;
    }));
  }
  return pools.get(connStr)!;
}

/** Runs a read-only query (introspection/ping) returning rows as objects. */
async function query(connStr: string, timeout: number, sql: string, binds: Record<string, unknown> = {}): Promise<Record<string, unknown>[]> {
  const odb = oracledb();
  const pool = await getPool(connStr);
  const conn = await pool.getConnection();
  try {
    conn.callTimeout = timeout;
    const res = await conn.execute(sql, binds, { outFormat: odb.OUT_FORMAT_OBJECT });
    return (res.rows ?? []) as Record<string, unknown>[];
  } finally {
    await conn.close().catch(() => {});
  }
}

export const oracleDriver: SqlDriver = {
  engine: 'oracle',
  scheme: 'oracle://user:pass@host:1521/service',
  syntaxHint: 'Use Oracle syntax: to limit rows use FETCH FIRST n ROWS ONLY (or ROWNUM); no LIMIT. Uppercase identifiers.',

  async testConnection(connStr, timeout = 5000) {
    await query(connStr, timeout, 'SELECT 1 AS OK FROM DUAL');
  },

  applyRowLimit(sql, maxRows) {
    return addFetchFirst(sql, maxRows);
  },

  async execute(connStr, opts: SqlExecuteOptions): Promise<SqlExecuteResult> {
    const odb = oracledb();
    const pool = await getPool(connStr);
    const conn = await pool.getConnection();
    try {
      conn.callTimeout = opts.timeout;
      if (opts.readOnly) await conn.execute('SET TRANSACTION READ ONLY');
      const binds = opts.rawQuery ? {} : extractNamedParams(opts.sql, opts.params);
      const res = await conn.execute(opts.sql, binds, {
        outFormat: odb.OUT_FORMAT_OBJECT,
        autoCommit: !opts.readOnly,
      });
      if (opts.readOnly) await conn.commit().catch(() => {});
      const rows = (res.rows ?? []) as Record<string, unknown>[];
      return { rows, affected: res.rowsAffected ?? rows.length };
    } catch (e) {
      await conn.rollback().catch(() => {});
      throw e;
    } finally {
      await conn.close().catch(() => {});
    }
  },

  async fetchTables(connStr, timeout): Promise<IntrospectTable[]> {
    const rows = await query(connStr, timeout,
      `SELECT t.table_name AS "name", c.comments AS "comment"
         FROM user_tables t
         LEFT JOIN user_tab_comments c
                ON c.table_name = t.table_name AND c.table_type = 'TABLE'
        ORDER BY t.table_name`);
    return rows.map((r) => ({ name: String(r.name), comment: String(r.comment ?? '') }));
  },

  async fetchAllColumns(connStr, timeout): Promise<IntrospectColumn[]> {
    const rows = await query(connStr, timeout,
      `SELECT col.table_name AS "tableName", col.column_name AS "name",
              col.data_type ||
                CASE WHEN col.data_type IN ('VARCHAR2','CHAR','NVARCHAR2','NCHAR')
                     THEN '(' || col.data_length || ')' ELSE '' END AS "type",
              col.nullable AS "nullable", cc.comments AS "comment"
         FROM user_tab_columns col
         LEFT JOIN user_col_comments cc
                ON cc.table_name = col.table_name AND cc.column_name = col.column_name
        ORDER BY col.table_name, col.column_id`);
    return rows.map((r) => ({
      tableName: String(r.tableName), name: String(r.name),
      type: String(r.type ?? ''), comment: String(r.comment ?? ''),
      nullable: r.nullable === 'Y',
    }));
  },

  async fetchColumns(connStr, timeout, names): Promise<IntrospectColumn[]> {
    const out: IntrospectColumn[] = [];
    for (const tableName of names) {
      const rows = await query(connStr, timeout,
        `SELECT col.column_name AS "name",
                col.data_type ||
                  CASE WHEN col.data_type IN ('VARCHAR2','CHAR','NVARCHAR2','NCHAR')
                       THEN '(' || col.data_length || ')' ELSE '' END AS "type",
                cc.comments AS "comment"
           FROM user_tab_columns col
           LEFT JOIN user_col_comments cc
                  ON cc.table_name = col.table_name AND cc.column_name = col.column_name
          WHERE UPPER(col.table_name) = UPPER(:t)
          ORDER BY col.column_id`, { t: tableName });
      for (const r of rows) {
        out.push({ tableName, name: String(r.name), type: String(r.type ?? ''), comment: String(r.comment ?? '') });
      }
    }
    return out;
  },

  async fetchRelations(connStr, timeout): Promise<IntrospectRelation[]> {
    const rows = await query(connStr, timeout,
      `SELECT a.table_name AS "fromTable", acc.column_name AS "fromCol",
              cpk.table_name AS "toTable", pcc.column_name AS "toCol"
         FROM user_constraints a
         JOIN user_cons_columns acc ON acc.constraint_name = a.constraint_name
         JOIN user_constraints cpk ON cpk.constraint_name = a.r_constraint_name
         JOIN user_cons_columns pcc ON pcc.constraint_name = cpk.constraint_name AND pcc.position = acc.position
        WHERE a.constraint_type = 'R'
        ORDER BY a.table_name, acc.column_name`);
    return rows.map((r) => ({
      fromTable: String(r.fromTable), fromCol: String(r.fromCol),
      toTable:   String(r.toTable),   toCol:   String(r.toCol),
    }));
  },
};
