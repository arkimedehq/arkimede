/**
 * @file param-binding.ts
 *
 * Shared helpers for binding the `:name` named params used in SQL templates
 * (Mode A). Each driver translates them into its own dialect:
 *   - Postgres → positional $1, $2 (namedToPositional)
 *   - MySQL/MariaDB → object with only the referenced keys (mysql2 namedPlaceholders)
 *   - SQL Server → @name + request.input(name, value) (namedToAt)
 *   - Oracle → native `:name` (object with only the referenced keys)
 *   - SQLite → `:name`/`@name` (object with only the referenced keys)
 */

const PARAM_RE = /:([a-zA-Z_][a-zA-Z0-9_]*)/g;

/**
 * Converts `:name` named params into positional `$1, $2…` for PostgreSQL.
 * A param used multiple times is bound to the same index.
 */
export function namedToPositional(
  query: string,
  args: Record<string, unknown>,
): { sql: string; values: unknown[] } {
  const values: unknown[] = [];
  const paramMap = new Map<string, number>();

  const sql = query.replace(PARAM_RE, (_, name: string) => {
    if (!paramMap.has(name)) {
      paramMap.set(name, values.length + 1);
      values.push(args[name] ?? null);
    }
    return `$${paramMap.get(name)}`;
  });

  return { sql, values };
}

/**
 * Extracts only the keys present as named params in the query — the object binders
 * (mysql2 / oracledb / better-sqlite3) want only the keys actually used.
 */
export function extractNamedParams(
  query: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const [, name] of query.matchAll(PARAM_RE)) {
    if (name in args) params[name] = args[name];
  }
  return params;
}

/**
 * Translates `:name` → `@name` (SQL Server syntax) and returns the list of referenced
 * params with their values, to be registered via request.input().
 */
export function namedToAt(
  query: string,
  args: Record<string, unknown>,
): { sql: string; params: Record<string, unknown> } {
  const params: Record<string, unknown> = {};
  const sql = query.replace(PARAM_RE, (_, name: string) => {
    if (name in args) params[name] = args[name];
    return `@${name}`;
  });
  return { sql, params };
}
