/**
 * @file sql-driver.interface.ts
 *
 * Abstraction of a relational DBMS. Each engine (postgres, mysql/mariadb, mssql,
 * oracle, sqlite) implements this interface, encapsulating what was previously
 * duplicated in `if/else` blocks in `sql-introspect.ts` and `custom-tool.factory.ts`:
 *   - cached pool/connection
 *   - binding of `:name` named params in the native dialect
 *   - read-only transaction (best-effort where the DBMS does not support it)
 *   - introspection queries on the native catalog → NORMALIZED rows
 *   - auto-LIMIT in the dialect syntax (LIMIT / TOP / FETCH FIRST)
 *
 * Introspection rows come back NORMALIZED: manifest assembly and formatting
 * (assemble / renderManifest* / formatAllColumnsCompact) remain SHARED code,
 * written only once.
 *
 * Adding a new relational DBMS = writing a single driver file + registering it in
 * the registry (`index.ts`). Zero changes to the rest.
 */
import { SqlEngine } from '../engine.types';

// ── Normalized introspection rows ──────────────────────────────────────────

/** Table: name + comment (empty if absent). */
export interface IntrospectTable {
  name: string;
  comment: string;
}

/** Column: with owning table, raw type and comment. */
export interface IntrospectColumn {
  tableName: string;
  name: string;
  /** Raw dialect SQL type (e.g. "varchar(255)", "NUMBER", "int"). */
  type: string;
  comment: string;
  /** True if NULLABLE (when the dialect exposes it). */
  nullable?: boolean;
  /** Key marker (e.g. "PRI"/"PK"), when available. */
  key?: string;
}

/** Declared FK relation: from → to (at table.column level). */
export interface IntrospectRelation {
  fromTable: string;
  fromCol: string;
  toTable: string;
  toCol: string;
}

// ── Query execution ────────────────────────────────────────────────────────────

export interface SqlExecuteOptions {
  /** SQL to execute. In template mode uses `:name` named params. */
  sql: string;
  /** Named param values (only the referenced keys are used). */
  params: Record<string, unknown>;
  /** Read-only tool → READ ONLY transaction (best-effort on MSSQL). */
  readOnly: boolean;
  /** Statement timeout in ms. */
  timeout: number;
  /**
   * True = free query (the model provided the SELECT): no param binding, the SQL
   * runs as-is. False = template with named params to bind.
   */
  rawQuery: boolean;
}

export interface SqlExecuteResult {
  /** Resulting rows (empty for writes). */
  rows: Record<string, unknown>[];
  /** Affected rows (for SELECT = rows.length). */
  affected: number;
}

// ── Driver ──────────────────────────────────────────────────────────────────────

export interface SqlDriver {
  /** Engine handled by this driver. */
  readonly engine: SqlEngine;

  /** Example connection string in the driver's format — used for messages/hints. */
  readonly scheme: string;

  /**
   * Syntax note injected into the schema prefetch to guide the model to write correct
   * SQL for this dialect (e.g. Oracle: FETCH FIRST n ROWS ONLY, no LIMIT).
   * Empty string if not needed.
   */
  readonly syntaxHint: string;

  /** Opens a connection and runs a ping (SELECT 1 / equivalent). Throws on failure. */
  testConnection(connStr: string, timeout?: number): Promise<void>;

  /** Executes a query (bound template or free query) in the appropriate transaction. */
  execute(connStr: string, opts: SqlExecuteOptions): Promise<SqlExecuteResult>;

  /** Adds the row limit in the dialect syntax, if not already present. */
  applyRowLimit(sql: string, maxRows: number): string;

  // ── Introspection (normalized rows; assemble/format is shared) ───────────
  fetchTables(connStr: string, timeout: number): Promise<IntrospectTable[]>;
  fetchAllColumns(connStr: string, timeout: number): Promise<IntrospectColumn[]>;
  fetchColumns(connStr: string, timeout: number, names: string[]): Promise<IntrospectColumn[]>;
  fetchRelations(connStr: string, timeout: number): Promise<IntrospectRelation[]>;
}
