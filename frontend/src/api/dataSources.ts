import api from './client';

/** Relational engines (Phase 1). */
export type SqlEngine = 'postgres' | 'mysql' | 'mariadb' | 'mssql' | 'oracle' | 'sqlite';
/** Document engines (Phase 2). */
export type DocumentEngine = 'mongodb';
/** Key-value engines (Phase 3). */
export type KeyValueEngine = 'redis';
/** Network file-share engines (Phase 4). */
export type FileShareEngine = 'smb' | 'sftp' | 'webdav';
/** All supported DataSource engines. */
export type DataSourceEngine = SqlEngine | DocumentEngine | KeyValueEngine | FileShareEngine;

export const SQL_ENGINES: SqlEngine[] = ['postgres', 'mysql', 'mariadb', 'mssql', 'oracle', 'sqlite'];
export const FILESHARE_ENGINES: FileShareEngine[] = ['smb', 'sftp', 'webdav'];
export const DATASOURCE_ENGINES: DataSourceEngine[] = [...SQL_ENGINES, 'mongodb', 'redis', ...FILESHARE_ENGINES];

/** Family of an engine (to filter tools by type). */
export function engineFamily(engine: DataSourceEngine): 'relational' | 'document' | 'keyvalue' | 'fileshare' {
  if (engine === 'mongodb') return 'document';
  if (engine === 'redis') return 'keyvalue';
  if (engine === 'smb' || engine === 'sftp' || engine === 'webdav') return 'fileshare';
  return 'relational';
}

export interface SchemaManifestColumn {
  name: string;
  type: string;
  comment: string;
  /** If true the column is denied: hidden from the injected schema + blocked in the SQL guard. */
  deny?: boolean;
}

export interface SchemaManifestTable {
  name: string;
  comment: string;
  deny: boolean;
  columns: SchemaManifestColumn[];
}

export interface SchemaManifestRelation {
  from: string;
  to: string;
  label?: string;
}

export interface SchemaManifest {
  generatedAt: string;
  dialect: SqlEngine;
  relations: SchemaManifestRelation[];
  tables: SchemaManifestTable[];
}

// ── Document manifest (MongoDB) ────────────────────────────────────────────

export interface DocumentField {
  path: string;
  types: string[];
  frequency: number;
  comment: string;
  deny?: boolean;
}

export interface DocumentCollection {
  name: string;
  comment: string;
  deny: boolean;
  fields: DocumentField[];
}

export interface DocumentManifest {
  generatedAt: string;
  engine: DocumentEngine;
  collections: DocumentCollection[];
}

/** Discriminates a DocumentManifest (Mongo) from a SchemaManifest (SQL). */
export function isDocumentManifest(m: unknown): m is DocumentManifest {
  return !!m && typeof m === 'object' && Array.isArray((m as any).collections);
}

// ── Keyspace manifest (Redis) ──────────────────────────────────────────────────

export interface KeyPattern {
  pattern: string;
  type: string;
  count: number;
  comment: string;
  deny: boolean;
  sampleKeys?: string[];
}

export interface KeyspaceManifest {
  generatedAt: string;
  engine: KeyValueEngine;
  patterns: KeyPattern[];
}

/** Discriminates a KeyspaceManifest (Redis). */
export function isKeyspaceManifest(m: unknown): m is KeyspaceManifest {
  return !!m && typeof m === 'object' && Array.isArray((m as any).patterns);
}

export interface DataSource {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  engine: DataSourceEngine;
  schemaHints: string | null;
  prefetchRelations: boolean;
  schemaManifest: SchemaManifest | DocumentManifest | KeyspaceManifest | null;
  scope: 'personal' | 'team' | 'org';
  teamId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDataSourcePayload {
  name: string;
  description?: string;
  engine?: DataSourceEngine;
  connectionString: string;
  schemaHints?: string;
  prefetchRelations?: boolean;
  scope?: 'personal' | 'team' | 'org';
  teamId?: string | null;
}

export interface UpdateDataSourcePayload extends Partial<CreateDataSourcePayload> {}

export interface TestConnectionResult {
  ok: boolean;
  latencyMs: number;
  message?: string;
}

export const dataSourcesApi = {
  list: () =>
    api.get<DataSource[]>('/data-sources').then((r) => r.data),

  get: (id: string) =>
    api.get<DataSource>(`/data-sources/${id}`).then((r) => r.data),

  create: (payload: CreateDataSourcePayload) =>
    api.post<DataSource>('/data-sources', payload).then((r) => r.data),

  update: (id: string, payload: UpdateDataSourcePayload) =>
    api.put<DataSource>(`/data-sources/${id}`, payload).then((r) => r.data),

  remove: (id: string) =>
    api.delete<void>(`/data-sources/${id}`).then((r) => r.data),

  /** Introspects the live schema → base manifest. */
  introspect: (id: string) =>
    api.post<DataSource>(`/data-sources/${id}/introspect`).then((r) => r.data),

  /** Enriches the manifest with AI (comments + relations). Model optional. */
  enrich: (id: string, llmConfigId?: string) =>
    api.post<DataSource>(`/data-sources/${id}/enrich`, llmConfigId ? { llmConfigId } : {}).then((r) => r.data),

  /** Saves the hand-edited manifest. */
  saveManifest: (id: string, manifest: SchemaManifest | DocumentManifest | KeyspaceManifest) =>
    api.put<DataSource>(`/data-sources/${id}/manifest`, { manifest }).then((r) => r.data),

  /** Clears the introspection (empties the manifest → SQL tools revert to live). */
  clearManifest: (id: string) =>
    api.delete<DataSource>(`/data-sources/${id}/manifest`).then((r) => r.data),

  /** PRE-save connection test: tries the provided connection string + engine. */
  testConnection: (connectionString: string, engine: DataSourceEngine) =>
    api.post<TestConnectionResult>('/data-sources/test', { connectionString, engine }).then((r) => r.data),

  /** Connection test on a saved DataSource. */
  testConnectionById: (id: string) =>
    api.post<TestConnectionResult>(`/data-sources/${id}/test`).then((r) => r.data),

  /** PRE-save browse of a file-share: lists the folders (provided connString + engine). */
  browse: (connectionString: string, engine: DataSourceEngine, path = '') =>
    api.post<BrowseResult>('/data-sources/browse', { connectionString, engine, path }).then((r) => r.data),

  /** Browse on a saved file-share. */
  browseById: (id: string, path = '') =>
    api.post<BrowseResult>(`/data-sources/${id}/browse`, { path }).then((r) => r.data),

  /** Sets the base path of a saved file-share (appends the navigated path). */
  setBase: (id: string, path = '') =>
    api.post<DataSource>(`/data-sources/${id}/browse-base`, { path }).then((r) => r.data),
};

/** Entry of a file-share folder (dir or file), returned by the browse. */
export interface FileEntry {
  name: string;
  path: string;            // relative to the share base (forward-slash)
  type: 'file' | 'dir';
  size?: number;
  mtime?: string;
}

export interface BrowseResult {
  path: string;
  entries: FileEntry[];
}
