/**
 * @file postgres.driver.ts
 *
 * PostgreSQL driver (package `pg`). Shared pools per connection string.
 * `BEGIN READ ONLY` transaction for read-only tools.
 */
import { Pool } from 'pg';
import {
  SqlDriver, SqlExecuteOptions, SqlExecuteResult,
  IntrospectTable, IntrospectColumn, IntrospectRelation,
} from './sql-driver.interface';
import { namedToPositional } from './param-binding';
import { addLimit } from './sql-syntax';

// Pools cached per connection string (includes credentials — never log the key).
const pools = new Map<string, Pool>();

function getPool(connStr: string): Pool {
  if (!pools.has(connStr)) {
    pools.set(connStr, new Pool({ connectionString: connStr, max: 3 }));
  }
  return pools.get(connStr)!;
}

async function query(
  connStr: string,
  timeout: number,
  sql: string,
  values?: unknown[],
): Promise<Record<string, unknown>[]> {
  const client = await getPool(connStr).connect();
  try {
    await client.query(`SET statement_timeout = ${timeout}`);
    const res = await client.query(sql, values);
    return res.rows ?? [];
  } finally {
    client.release();
  }
}

export const postgresDriver: SqlDriver = {
  engine: 'postgres',
  scheme: 'postgresql://user:pass@host:5432/db',
  syntaxHint: 'Use PostgreSQL syntax (LIMIT n, ILIKE, $1 placeholder).',

  async testConnection(connStr, timeout = 5000) {
    await query(connStr, timeout, 'SELECT 1');
  },

  applyRowLimit(sql, maxRows) {
    return addLimit(sql, maxRows);
  },

  async execute(connStr, opts: SqlExecuteOptions): Promise<SqlExecuteResult> {
    const client = await getPool(connStr).connect();
    try {
      await client.query(`SET statement_timeout = ${opts.timeout}`);
      await client.query(opts.readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
      try {
        const res = opts.rawQuery
          ? await client.query(opts.sql)
          : await (() => {
              const { sql, values } = namedToPositional(opts.sql, opts.params);
              return client.query(sql, values);
            })();
        await client.query('COMMIT');
        return { rows: res.rows ?? [], affected: res.rowCount ?? (res.rows?.length ?? 0) };
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      }
    } finally {
      client.release();
    }
  },

  async fetchTables(connStr, timeout): Promise<IntrospectTable[]> {
    const rows = await query(connStr, timeout,
      `SELECT t.table_name AS name,
              COALESCE(obj_description(c.oid, 'pg_class'), '') AS comment
         FROM information_schema.tables t
         LEFT JOIN pg_class c ON c.relname = t.table_name AND c.relkind = 'r'
        WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
        ORDER BY t.table_name`);
    return rows.map((r) => ({ name: String(r.name), comment: String(r.comment ?? '') }));
  },

  async fetchAllColumns(connStr, timeout): Promise<IntrospectColumn[]> {
    const rows = await query(connStr, timeout,
      `SELECT col.table_name  AS "tableName",
              col.column_name  AS name,
              col.data_type    AS type,
              col.is_nullable   AS nullable,
              COALESCE(pgd.description, '') AS comment
         FROM information_schema.columns col
         LEFT JOIN pg_catalog.pg_statio_all_tables st
                ON st.schemaname = 'public' AND st.relname = col.table_name
         LEFT JOIN pg_catalog.pg_description pgd
                ON pgd.objoid = st.relid AND pgd.objsubid = col.ordinal_position
        WHERE col.table_schema = 'public'
        ORDER BY col.table_name, col.ordinal_position`);
    return rows.map((r) => ({
      tableName: String(r.tableName),
      name:      String(r.name),
      type:      String(r.type ?? ''),
      comment:   String(r.comment ?? ''),
      nullable:  r.nullable === 'YES',
    }));
  },

  async fetchColumns(connStr, timeout, names): Promise<IntrospectColumn[]> {
    const out: IntrospectColumn[] = [];
    for (const tableName of names) {
      const rows = await query(connStr, timeout,
        `SELECT col.column_name AS name, col.data_type AS type,
                COALESCE(pgd.description, '') AS comment
           FROM information_schema.columns col
           LEFT JOIN pg_catalog.pg_statio_all_tables st
                  ON st.schemaname = 'public' AND st.relname = $1
           LEFT JOIN pg_catalog.pg_description pgd
                  ON pgd.objoid = st.relid AND pgd.objsubid = col.ordinal_position
          WHERE col.table_schema = 'public' AND col.table_name = $1
          ORDER BY col.ordinal_position`, [tableName]);
      for (const r of rows) {
        out.push({
          tableName, name: String(r.name), type: String(r.type ?? ''),
          comment: String(r.comment ?? ''),
        });
      }
    }
    return out;
  },

  async fetchRelations(connStr, timeout): Promise<IntrospectRelation[]> {
    const rows = await query(connStr, timeout,
      `SELECT tc.table_name   AS "fromTable",
              kcu.column_name  AS "fromCol",
              ccu.table_name   AS "toTable",
              ccu.column_name  AS "toCol"
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
              ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
         JOIN information_schema.constraint_column_usage ccu
              ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
        ORDER BY tc.table_name, kcu.column_name`);
    return rows.map((r) => ({
      fromTable: String(r.fromTable), fromCol: String(r.fromCol),
      toTable:   String(r.toTable),   toCol:   String(r.toCol),
    }));
  },
};
