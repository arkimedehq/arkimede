/**
 * @file mysql.driver.ts
 *
 * MySQL and MariaDB driver (package `mysql2`, identical for both: only the
 * connection string scheme changes). Pool with `namedPlaceholders` for `:name`
 * binding. `START TRANSACTION READ ONLY` transaction for read-only tools.
 */
import * as mysql from 'mysql2/promise';
import {
  SqlDriver, SqlExecuteOptions, SqlExecuteResult,
  IntrospectTable, IntrospectColumn, IntrospectRelation,
} from './sql-driver.interface';
import { SqlEngine } from '../engine.types';
import { extractNamedParams } from './param-binding';
import { addLimit } from './sql-syntax';

const pools = new Map<string, mysql.Pool>();

/** mysql2 does not recognize the `mariadb://` scheme → normalize it to `mysql://`. */
function normalize(connStr: string): string {
  return connStr.replace(/^mariadb:/i, 'mysql:');
}

function getPool(connStr: string): mysql.Pool {
  const uri = normalize(connStr);
  if (!pools.has(uri)) {
    pools.set(uri, mysql.createPool({
      uri,
      connectionLimit:   3,
      namedPlaceholders: true,
    }));
  }
  return pools.get(uri)!;
}

async function run(connStr: string, sql: string, params?: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  const [rows] = await getPool(connStr).execute(sql, params as any) as [Record<string, unknown>[], unknown];
  return rows;
}

function makeMysqlDriver(engine: SqlEngine, scheme: string): SqlDriver {
  return {
    engine,
    scheme,
    syntaxHint: 'Use MySQL/MariaDB syntax (LIMIT n, backticks for identifiers).',

    async testConnection(connStr) {
      await run(connStr, 'SELECT 1');
    },

    applyRowLimit(sql, maxRows) {
      return addLimit(sql, maxRows);
    },

    async execute(connStr, opts: SqlExecuteOptions): Promise<SqlExecuteResult> {
      const conn = await getPool(connStr).getConnection();
      try {
        await conn.query(opts.readOnly ? 'START TRANSACTION READ ONLY' : 'START TRANSACTION');
        try {
          const [result] = opts.rawQuery
            ? await conn.execute(opts.sql)
            : await conn.execute(opts.sql, extractNamedParams(opts.sql, opts.params) as Record<string, any>);
          await conn.commit();
          if (Array.isArray(result)) {
            return { rows: result as Record<string, unknown>[], affected: result.length };
          }
          return { rows: [], affected: (result as any)?.affectedRows ?? 0 };
        } catch (e) {
          await conn.rollback().catch(() => {});
          throw e;
        }
      } finally {
        conn.release();
      }
    },

    async fetchTables(connStr): Promise<IntrospectTable[]> {
      const rows = await run(connStr,
        `SELECT TABLE_NAME AS name, COALESCE(TABLE_COMMENT, '') AS comment
           FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
          ORDER BY TABLE_NAME`);
      return rows.map((r) => ({ name: String(r.name), comment: String(r.comment ?? '') }));
    },

    async fetchAllColumns(connStr): Promise<IntrospectColumn[]> {
      const rows = await run(connStr,
        `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS name,
                COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_KEY AS keyType,
                COALESCE(COLUMN_COMMENT, '') AS comment
           FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
          ORDER BY TABLE_NAME, ORDINAL_POSITION`);
      return rows.map((r) => ({
        tableName: String(r.tableName), name: String(r.name),
        type: String(r.type ?? ''), comment: String(r.comment ?? ''),
        nullable: r.nullable === 'YES',
        key: r.keyType ? String(r.keyType) : undefined,
      }));
    },

    async fetchColumns(connStr, _timeout, names): Promise<IntrospectColumn[]> {
      const out: IntrospectColumn[] = [];
      for (const tableName of names) {
        const rows = await run(connStr,
          `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type,
                  COALESCE(COLUMN_COMMENT, '') AS comment
             FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :t
            ORDER BY ORDINAL_POSITION`, { t: tableName });
        for (const r of rows) {
          out.push({ tableName, name: String(r.name), type: String(r.type ?? ''), comment: String(r.comment ?? '') });
        }
      }
      return out;
    },

    async fetchRelations(connStr): Promise<IntrospectRelation[]> {
      const rows = await run(connStr,
        `SELECT TABLE_NAME AS fromTable, COLUMN_NAME AS fromCol,
                REFERENCED_TABLE_NAME AS toTable, REFERENCED_COLUMN_NAME AS toCol
           FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
          WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL
          ORDER BY TABLE_NAME, COLUMN_NAME`);
      return rows.map((r) => ({
        fromTable: String(r.fromTable), fromCol: String(r.fromCol),
        toTable:   String(r.toTable),   toCol:   String(r.toCol),
      }));
    },
  };
}

export const mysqlDriver: SqlDriver = makeMysqlDriver('mysql', 'mysql://user:pass@host:3306/db');
export const mariadbDriver: SqlDriver = makeMysqlDriver('mariadb', 'mariadb://user:pass@host:3306/db');
