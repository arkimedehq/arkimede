/**
 * @file sql-syntax.ts
 *
 * Syntax helper for auto-LIMIT, different per dialect:
 *   - LIMIT n            → Postgres, MySQL/MariaDB, SQLite
 *   - TOP (n)            → SQL Server
 *   - FETCH FIRST n ...  → Oracle (12c+)
 *
 * Auto-LIMIT applies only to single SELECTs (anti-dump protection).
 */

/** Adds `LIMIT n` if absent (Postgres / MySQL / SQLite). */
export function addLimit(query: string, maxRows: number): string {
  return /\bLIMIT\b/i.test(query) ? query : `${query.replace(/;\s*$/, '')} LIMIT ${maxRows}`;
}

/**
 * Inserts `TOP (n)` after the leading SELECT (SQL Server), if not already present and
 * the query starts with SELECT. Does not touch queries with TOP/OFFSET already set.
 */
export function addTop(query: string, maxRows: number): string {
  if (/\bTOP\b/i.test(query) || /\bOFFSET\b/i.test(query)) return query;
  if (!/^\s*select\b/i.test(query)) return query;
  return query.replace(/^(\s*select\s+)(distinct\s+|all\s+)?/i,
    (_m, sel: string, mod: string = '') => `${sel}${mod}TOP (${maxRows}) `);
}

/**
 * Adds `FETCH FIRST n ROWS ONLY` (Oracle 12c+), if not already present and the query
 * does not use ROWNUM. Oracle SQL must not have a trailing ';'.
 */
export function addFetchFirst(query: string, maxRows: number): string {
  if (/\bFETCH\s+FIRST\b/i.test(query) || /\bROWNUM\b/i.test(query)) return query;
  return `${query.replace(/;\s*$/, '')} FETCH FIRST ${maxRows} ROWS ONLY`;
}
