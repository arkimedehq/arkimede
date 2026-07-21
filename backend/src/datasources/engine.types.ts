/**
 * @file engine.types.ts
 *
 * DataSource "engine/family" model.
 *
 * Each DataSource has an `engine` (the concrete DBMS) that belongs to a `family`:
 *   - relational → SQL (Postgres, MySQL, MariaDB, SQL Server, Oracle, SQLite)
 *   - document   → MongoDB        (Phase 2 — not yet implemented)
 *   - keyvalue   → Redis          (Phase 3 — not yet implemented)
 *
 * The DataSource layer (entity, CRUD, encryption, connection test) is unified for
 * all families; the query layer diverges per family (`sql` tool for the relational
 * ones; `mongo`/`redis` tools in the future). This file is the source of truth
 * for the types, imported by entity, manifest, driver and custom-tool.types — it
 * depends on nothing else (no cycles).
 */

/** Supported relational DBMS (Phase 1). */
export type SqlEngine = 'postgres' | 'mysql' | 'mariadb' | 'mssql' | 'oracle' | 'sqlite';

/** Document engines (Phase 2). */
export type DocumentEngine = 'mongodb';

/** Key-value engines (Phase 3). */
export type KeyValueEngine = 'redis';

/**
 * File-share engines (Phase 4): file operations.
 *   - smb/sftp/webdav → remote network shares (via protocol, user-configurable)
 *   - local           → the backend's local filesystem (e.g. SKILLS_OUTPUT_DIR);
 *                       NOT user-creatable, auto-provisioned by the system.
 */
export type FileShareEngine = 'smb' | 'sftp' | 'webdav' | 'local';

/** All supported DataSource engines. */
export type DataSourceEngine = SqlEngine | DocumentEngine | KeyValueEngine | FileShareEngine;

/** Family of an engine: determines which tool/language queries it. */
export type EngineFamily = 'relational' | 'document' | 'keyvalue' | 'fileshare';

/** Relational engines, in UI presentation order. */
export const SQL_ENGINES: SqlEngine[] = [
  'postgres', 'mysql', 'mariadb', 'mssql', 'oracle', 'sqlite',
];

/** Document engines. */
export const DOCUMENT_ENGINES: DocumentEngine[] = ['mongodb'];

/** Key-value engines. */
export const KEYVALUE_ENGINES: KeyValueEngine[] = ['redis'];

/** Network file-share engines, in UI presentation order (user-creatable). */
export const FILESHARE_ENGINES: FileShareEngine[] = ['smb', 'sftp', 'webdav'];

/** Local file-share engine, managed by the system (not user-creatable). */
export const LOCAL_FILESHARE_ENGINE: FileShareEngine = 'local';

/** All DataSource engines (all families), for validation/UI. */
// NB: `local` is deliberately EXCLUDED — it is not user-creatable (it would point to
// arbitrary backend paths). It is a virtual source managed by the system (see
// InternalDatasourcesController, reserved id 'local').
export const DATASOURCE_ENGINES: DataSourceEngine[] = [
  ...SQL_ENGINES, ...DOCUMENT_ENGINES, ...KEYVALUE_ENGINES, ...FILESHARE_ENGINES,
];

/** Engine → family map. */
const ENGINE_FAMILY: Record<string, EngineFamily> = {
  postgres: 'relational',
  mysql:    'relational',
  mariadb:  'relational',
  mssql:    'relational',
  oracle:   'relational',
  sqlite:   'relational',
  mongodb:  'document',
  redis:    'keyvalue',
  smb:      'fileshare',
  sftp:     'fileshare',
  webdav:   'fileshare',
  local:    'fileshare',
};

/** Family of an engine (default 'relational' for unmapped engines). */
export function engineFamily(engine: string): EngineFamily {
  return ENGINE_FAMILY[engine] ?? 'relational';
}

/** True if the string is a supported relational engine. */
export function isSqlEngine(engine: string): engine is SqlEngine {
  return (SQL_ENGINES as string[]).includes(engine);
}

/** True if the string is a supported document engine. */
export function isDocumentEngine(engine: string): engine is DocumentEngine {
  return (DOCUMENT_ENGINES as string[]).includes(engine);
}

/** True if the string is a supported key-value engine. */
export function isKeyValueEngine(engine: string): engine is KeyValueEngine {
  return (KEYVALUE_ENGINES as string[]).includes(engine);
}

/** True if the string is a supported file-share engine. */
export function isFileShareEngine(engine: string): engine is FileShareEngine {
  return (FILESHARE_ENGINES as string[]).includes(engine);
}

/** True if the string is a supported DataSource engine (any family). */
export function isDataSourceEngine(engine: string): engine is DataSourceEngine {
  return (DATASOURCE_ENGINES as string[]).includes(engine);
}
