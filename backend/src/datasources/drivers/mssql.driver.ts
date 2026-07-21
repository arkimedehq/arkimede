/**
 * @file mssql.driver.ts
 *
 * Microsoft SQL Server driver (optional package `mssql`, lazy-loaded).
 *
 * Read-only note: SQL Server has no real "READ ONLY" transaction. The primary safety
 * net for read-only tools remains `evaluateSqlPolicy` (whitelist of operations at the
 * SQL parsing level, cross-engine). Writes run in a transaction with rollback on error.
 *
 * Connection string: the `mssql` package accepts both the URL `mssql://user:pass@host:port/db`
 * and the ADO form `Server=host,1433;Database=db;User Id=...;Password=...;Encrypt=true`.
 */
import {
  SqlDriver, SqlExecuteOptions, SqlExecuteResult,
  IntrospectTable, IntrospectColumn, IntrospectRelation,
} from './sql-driver.interface';
import { namedToAt } from './param-binding';
import { addTop } from './sql-syntax';
import { loadOptional } from './optional-module';

// Pools (mssql ConnectionPool) cached and already connected, keyed by connection string.
const pools = new Map<string, Promise<any>>();

function sqlmod(): any {
  return loadOptional('mssql', 'mssql');
}

function getPool(connStr: string): Promise<any> {
  if (!pools.has(connStr)) {
    const pool = new (sqlmod().ConnectionPool)(connStr);
    pools.set(connStr, pool.connect().then(() => pool).catch((e: any) => {
      pools.delete(connStr);   // do not cache a failed pool
      throw e;
    }));
  }
  return pools.get(connStr)!;
}

/** Runs a simple query (introspection/ping) and returns the recordset. */
async function query(connStr: string, sql: string): Promise<Record<string, unknown>[]> {
  const pool = await getPool(connStr);
  const res = await pool.request().query(sql);
  return res.recordset ?? [];
}

/** Builds the readable type from sys.types metadata. */
function colType(dataType: string, maxLen: number): string {
  const t = String(dataType);
  if (/^(var)?char$|^n?(var)?char$|^nchar$|^binary$|^varbinary$/i.test(t) && maxLen) {
    const len = maxLen === -1 ? 'max' : (/^n/i.test(t) ? maxLen / 2 : maxLen);
    return `${t}(${len})`;
  }
  return t;
}

const COLUMNS_SQL = `
  SELECT tab.name AS tableName, col.name AS name, typ.name AS dataType,
         col.max_length AS maxLen, col.is_nullable AS isNullable,
         COALESCE(CAST(ep.value AS NVARCHAR(MAX)), '') AS comment
    FROM sys.columns col
    JOIN sys.tables  tab ON tab.object_id = col.object_id
    JOIN sys.types   typ ON typ.user_type_id = col.user_type_id
    LEFT JOIN sys.extended_properties ep
           ON ep.major_id = col.object_id AND ep.minor_id = col.column_id
          AND ep.name = 'MS_Description'`;

export const mssqlDriver: SqlDriver = {
  engine: 'mssql',
  scheme: 'mssql://user:pass@host:1433/db',
  syntaxHint: 'Use T-SQL (SQL Server) syntax: to limit rows use SELECT TOP (n) … or OFFSET … FETCH NEXT n ROWS ONLY; no LIMIT.',

  async testConnection(connStr) {
    await query(connStr, 'SELECT 1 AS ok');
  },

  applyRowLimit(sql, maxRows) {
    return addTop(sql, maxRows);
  },

  async execute(connStr, opts: SqlExecuteOptions): Promise<SqlExecuteResult> {
    const sql = sqlmod();
    const pool = await getPool(connStr);

    const buildRequest = (r: any) => {
      if (opts.rawQuery) return { req: r, text: opts.sql };
      const { sql: text, params } = namedToAt(opts.sql, opts.params);
      for (const [k, v] of Object.entries(params)) r.input(k, v);
      return { req: r, text };
    };

    if (opts.readOnly) {
      const { req, text } = buildRequest(pool.request());
      const res = await req.query(text);
      const rows = res.recordset ?? [];
      return { rows, affected: rows.length };
    }

    // Write: transaction with rollback on error.
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      const { req, text } = buildRequest(new sql.Request(tx));
      const res = await req.query(text);
      await tx.commit();
      const rows = res.recordset ?? [];
      const affected = Array.isArray(res.rowsAffected)
        ? res.rowsAffected.reduce((a: number, b: number) => a + b, 0)
        : rows.length;
      return { rows, affected };
    } catch (e) {
      await tx.rollback().catch(() => {});
      throw e;
    }
  },

  async fetchTables(connStr): Promise<IntrospectTable[]> {
    const rows = await query(connStr,
      `SELECT t.name AS name, COALESCE(CAST(ep.value AS NVARCHAR(MAX)), '') AS comment
         FROM sys.tables t
         LEFT JOIN sys.extended_properties ep
                ON ep.major_id = t.object_id AND ep.minor_id = 0 AND ep.name = 'MS_Description'
        ORDER BY t.name`);
    return rows.map((r) => ({ name: String(r.name), comment: String(r.comment ?? '') }));
  },

  async fetchAllColumns(connStr): Promise<IntrospectColumn[]> {
    const rows = await query(connStr, `${COLUMNS_SQL} ORDER BY tab.name, col.column_id`);
    return rows.map((r) => ({
      tableName: String(r.tableName), name: String(r.name),
      type: colType(String(r.dataType), Number(r.maxLen)),
      comment: String(r.comment ?? ''), nullable: !!r.isNullable,
    }));
  },

  async fetchColumns(connStr, _timeout, names): Promise<IntrospectColumn[]> {
    const out: IntrospectColumn[] = [];
    const pool = await getPool(connStr);
    for (const tableName of names) {
      const res = await pool.request()
        .input('t', tableName)
        .query(`${COLUMNS_SQL} WHERE tab.name = @t ORDER BY col.column_id`);
      for (const r of res.recordset ?? []) {
        out.push({
          tableName, name: String(r.name),
          type: colType(String(r.dataType), Number(r.maxLen)),
          comment: String(r.comment ?? ''),
        });
      }
    }
    return out;
  },

  async fetchRelations(connStr): Promise<IntrospectRelation[]> {
    const rows = await query(connStr,
      `SELECT tp.name AS fromTable, cp.name AS fromCol, tr.name AS toTable, cr.name AS toCol
         FROM sys.foreign_key_columns fkc
         JOIN sys.tables  tp ON tp.object_id = fkc.parent_object_id
         JOIN sys.columns cp ON cp.object_id = fkc.parent_object_id AND cp.column_id = fkc.parent_column_id
         JOIN sys.tables  tr ON tr.object_id = fkc.referenced_object_id
         JOIN sys.columns cr ON cr.object_id = fkc.referenced_object_id AND cr.column_id = fkc.referenced_column_id
        ORDER BY tp.name, cp.name`);
    return rows.map((r) => ({
      fromTable: String(r.fromTable), fromCol: String(r.fromCol),
      toTable:   String(r.toTable),   toCol:   String(r.toCol),
    }));
  },
};
