/**
 * @file custom-tool.types.ts
 *
 * Type definitions for the user-defined custom tool system.
 *
 * A custom tool is composed of:
 *   - Metadata (name, description) read by the LLM to decide when to use it
 *   - parameters[]  → dynamically built Zod schema; the LLM fills them in
 *   - executorType  → what the tool actually does when invoked
 *   - executorConfig → configuration specific to the executor type
 *
 * Implemented executor types:
 *   http   → Calls an external REST endpoint
 *   sql    → Runs a parameterized SELECT query on the business system (TODO v2)
 *   prompt → Calls Claude with a custom system prompt (TODO v2)
 */

import { SchemaManifest } from '../datasources/schema-manifest.types';
import { DocumentManifest } from '../datasources/document-manifest.types';
import { KeyspaceManifest } from '../datasources/keyspace-manifest.types';
import { DataSourceEngine } from '../datasources/engine.types';

// ── Tool parameters (LLM input) ───────────────────────────────────────

export type ParameterType = 'string' | 'number' | 'boolean';

export interface ToolParameter {
  /** Parameter name — used as key in the Zod schema and in interpolation */
  name: string;
  /** Primitive type of the parameter */
  type: ParameterType;
  /**
   * LLM-readable description.
   * ⚠️ This is the parameter's "prompt": the more precise, the better the answers.
   * E.g.: "Keywords to search on the web" >> "query"
   */
  description: string;
  /** If true, the LLM is required to provide this parameter */
  required: boolean;
  /** Default value if the LLM does not provide the parameter (optional only) */
  default?: string | number | boolean;
}

// ── Executor: HTTP ────────────────────────────────────────────────────────────

export interface HttpExecutorConfig {
  /** Endpoint URL. Supports {{paramName}} interpolation */
  url: string;
  /** HTTP method */
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /**
   * Additional HTTP headers.
   * Supports interpolation:
   *   {{secret.MY_API_KEY}}  → read from the tool_secrets table (encrypted)
   *   {{env.MY_VAR}}         → read from process.env
   */
  headers?: Record<string, string>;
  /**
   * Query string params (for GET requests).
   * Supports {{paramName}} interpolation.
   * Note: for GET, the tool parameters are also added automatically
   * as query params if not already present.
   */
  queryParams?: Record<string, string>;
  /**
   * Body template for POST/PUT/PATCH requests.
   * Can be:
   *   - JSON object → recursive interpolation over string values
   *   - Raw string → simple interpolation
   * If omitted and method !== GET, the body is serialized { ...args }.
   */
  bodyTemplate?: Record<string, unknown> | string;
  /**
   * Dot-notation path to extract a subset from the JSON response.
   * E.g.: "results"       → data.results
   *       "web.results"   → data.web.results
   * If omitted, returns the entire response (truncated).
   */
  responsePath?: string;
  /** Maximum characters of the response passed to the LLM (default 3000) */
  maxResponseChars?: number;
  /** Timeout in ms for the HTTP call (default 10000) */
  timeoutMs?: number;
}

// ── Executor: SQL ─────────────────────────────────────────────────────────────

/**
 * Data source resolved at runtime by the DataSourcesService.
 * Contains the decrypted connection string + schema metadata from the DataSource entity.
 * Passed from CustomToolsService to buildDynamicTool — never exposed via API.
 */
export interface ResolvedDataSource {
  /** DataSource engine — selects the driver and the family (relational|document). */
  engine: DataSourceEngine;
  /** Plaintext connection string (decrypted from the DataSource) */
  connectionString: string;
  /** Relations and schema notes (from DataSource.schemaHints) */
  schemaHints?: string;
  /** Auto-detect FKs from INFORMATION_SCHEMA (from DataSource.prefetchRelations) */
  prefetchRelations?: boolean;
  /**
   * Enriched schema (from DataSource.schemaManifest): SchemaManifest (SQL) or
   * DocumentManifest (Mongo). When present the prefetch uses it instead of
   * live introspection and the guard applies its `deny` objects.
   */
  schemaManifest?: SchemaManifest | DocumentManifest | KeyspaceManifest | null;
}

/** SQL operations governable per-tool (capability). */
export type SqlOp = 'select' | 'insert' | 'update' | 'delete' | 'ddl' | 'other';

export interface SqlExecutorConfig {
  /**
   * ID of the DataSource configured in the "Data Sources" section.
   * The connection (encrypted URL, schemaHints, prefetchRelations) is
   * resolved at runtime by DataSourcesService — never inline in the tool.
   */
  dataSourceId: string;

  // ── Operation capability (security) ──────────────────────────────────────
  /**
   * Operations allowed for this tool. Default `['select']` (read-only).
   * The parser enforces ONLY the listed operations; `ddl` (create/alter/drop/…)
   * is allowed only if explicitly included.
   * - read-only tool (`['select']`) → query in a READ ONLY transaction.
   * - write tool → transaction with rollback on error.
   */
  operations?: SqlOp[];

  /** Opt-in: reject UPDATE/DELETE without a WHERE clause. Default false. */
  requireWhere?: boolean;

  /**
   * Opt-in: destructive operations (update/delete/ddl) require the argument
   * `confirm=true` (exposed as a boolean tool parameter). Default false.
   */
  confirmDestructive?: boolean;

  // ── Mode A: Parameterized template ──────────────────────────────────────────
  /**
   * SELECT query with named params :paramName, safely bound.
   * Compatible with PostgreSQL and MySQL (mysql2 namedPlaceholders).
   * E.g.: "SELECT nome, email FROM clienti WHERE regione = :regione"
   * Mutually exclusive with queryParam.
   */
  queryTemplate?: string;

  // ── Mode B: Free query / Text-to-SQL ─────────────────────────────────────────
  /**
   * Name of the tool parameter (required: false) that the LLM fills with the SELECT.
   *   - parameter absent → returns schema (prefetch tables/columns)
   *   - parameter present → validates SELECT-only, adds LIMIT, executes
   * ⚠️ The corresponding ToolParameter MUST have required: false.
   */
  queryParam?: string;

  // ── Injected schema (free query, step 1) ────────────────────────────────────
  /**
   * Schema rendering mode. The SOURCE is automatic: curated manifest of the
   * DataSource if present (respects `deny` tables/fields), otherwise LIVE
   * introspection from the DB.
   *   - 'compact' (default) → relations + table names + comments, WITHOUT columns
   *                           (~lightweight). Columns are requested on-demand with
   *                           the `describe_tables` parameter.
   *   - 'full'              → self-contained schema: each table with columns (type+
   *                           comment), FKs annotated inline and localized relations.
   */
  schemaMode?: 'compact' | 'full';

  /** Maximum number of rows in the result (default 50, hard-cap 500) */
  maxRows?: number;

  /**
   * Column projection in the JSON response.
   * If omitted, all columns are returned.
   */
  columns?: string[];

  /** Query timeout in ms (default 10 000) */
  timeoutMs?: number;
}

// ── Executor: Prompt / Sub-agent ─────────────────────────────────────────────

export interface PromptExecutorConfig {
  /**
   * System prompt of the sub-agent.
   * Supports {{paramName}} / {{secret.KEY}} / {{env.VAR}} interpolation.
   */
  systemPrompt: string;
  /**
   * Template of the user message sent to the sub-agent.
   * Supports {{paramName}} / {{secret.KEY}} / {{env.VAR}} interpolation.
   * If omitted, the args are serialized as JSON.
   */
  userPromptTemplate?: string;
  /** ID of the LlmConfig to use. If omitted: uses the default config. */
  llmConfigId?: string;
  /** Maximum number of tokens in the response (override relative to LlmConfig; default: 1024) */
  maxTokens?: number;
  /** Sampling temperature 0–1 (default: 0 — deterministic) */
  temperature?: number;
}

// ── Executor: RAG (Retrieval-Augmented Generation) ───────────────────────────

/**
 * Visibility scope of an indexed DOCUMENT, chosen at embed time:
 *   universal → company base memory, visible to everyone
 *   project   → tied to a project (payload.projectId), visible within that project
 *   personal  → private to the user who uploaded it (payload.userId)
 */
export type DocScope = 'universal' | 'project' | 'personal';

/**
 * RAG SEARCH filter mode (optional override on the tool):
 *   auto (default) → dynamic visibility from context: universal ∪ my-personal ∪ current-project
 *   universal      → only universal documents ("company base" tool)
 *   all            → no filter, the entire collection (cross-project/admin tool)
 */
export type RagSearchScope = 'auto' | 'universal' | 'all';

export interface RagExecutorConfig {
  /**
   * Operating mode of the tool:
   *   'search' (default) → semantic search in the collection
   *   'index'            → embedding and indexing of text into the collection
   */
  mode?: 'search' | 'index';

  /**
   * Name of the collection to operate on (mandatory in both modes).
   * In mode='search': collection to search in.
   * In mode='index':  collection to index the text into.
   * The collection must be compatible with the active embedding model.
   */
  collection: string;

  // ── search mode options ────────────────────────────────────────────────────

  /**
   * Maximum number of chunks returned (default 5).
   * The LLM can override this value via the "limit" parameter.
   */
  limit?: number;

  /**
   * Override of the search filter. Default 'auto' = dynamic visibility from
   * context (universal + user's personal + documents of the current chat's
   * project). The filter is applied NATIVELY on the vector DB (union of
   * per-scope queries), not in post-processing.
   */
  searchScope?: RagSearchScope;

  // ── index mode options ─────────────────────────────────────────────────────

  /**
   * Scope to assign to documents indexed by this tool (mode='index').
   * If omitted, derived from context: 'project' if the chat has a project,
   * otherwise 'personal'.
   */
  indexScope?: DocScope;

  /**
   * Name of the tool parameter that the LLM fills with the text to index.
   * Default: 'text'.
   * Used when the text is generated or known to the LLM (e.g. notes, snippets).
   * Mutually exclusive with fileIdParam: if both present, fileIdParam takes precedence.
   */
  textParam?: string;

  /**
   * Name of the tool parameter that the LLM fills with the fileId of a file
   * already uploaded to the system (visible in the chat as "id: xxx").
   *
   * When set, the tool uses EmbedService.ingestFile() to extract
   * the text natively (pdf-parse, mammoth, OCR, XLSX) instead of relying
   * on the text transcribed by the LLM, which could be incomplete or truncated.
   *
   * Use when the user uploads a file and asks to index it.
   */
  fileIdParam?: string;

  /**
   * Additional tool parameters to save in the vector payload as metadata.
   * E.g.: ['source', 'category'] → the LLM fills these fields and they are
   * persisted in the payload alongside the text chunk.
   * The parameters must be declared in the tool's ToolParameter[].
   */
  metadataParams?: string[];
}

// ── Executor: Mongo (document DataSource) ─────────────────────────────────

/** MongoDB operations governable per-tool (capability). */
export type MongoOp =
  | 'find' | 'aggregate' | 'countDocuments' | 'distinct'
  | 'insertOne' | 'insertMany' | 'updateOne' | 'updateMany' | 'deleteOne' | 'deleteMany';

export interface MongoExecutorConfig {
  /** ID of the DataSource (engine mongodb). Resolved at runtime. */
  dataSourceId: string;

  // ── Capability (security) ──────────────────────────────────────────────────
  /** Allowed operations. Default = read-only (find/aggregate/countDocuments/distinct). */
  operations?: MongoOp[];
  /** Write operations require the argument `confirm=true`. Default false. */
  confirmDestructive?: boolean;

  // ── Mode A: template ────────────────────────────────────────────────────────
  /** Fixed collection (Mode A). If present → template mode. */
  collection?: string;
  /** Template operation (default 'find'). */
  operation?: MongoOp;
  /** JSON filter with named param :param (Mode A, find/update/delete/count). */
  filterTemplate?: string;
  /** JSON pipeline (array) with named param :param (Mode A, aggregate). */
  pipelineTemplate?: string;

  // ── Mode B: free query ──────────────────────────────────────────────────────
  /**
   * Name of the tool parameter that the LLM fills with the operation's JSON spec:
   * { "collection":"…", "op":"find"|"aggregate"|…, "filter":{…} | "pipeline":[…], "limit":N }.
   */
  queryParam?: string;

  // ── Injected schema ────────────────────────────────────────────────────────
  /** 'compact' (default, only collection names) or 'full' (also the sampled fields). */
  schemaMode?: 'compact' | 'full';

  /** Max documents in the result (default 50, hard-cap 500). */
  maxRows?: number;
  /** Field projection (top-level) in the response. */
  projection?: string[];
  /** Operation timeout in ms (default 10 000). */
  timeoutMs?: number;
}

// ── Executor: Redis (key-value DataSource) ────────────────────────────────────

export interface RedisExecutorConfig {
  /** ID of the DataSource (engine redis). Resolved at runtime. */
  dataSourceId: string;

  // ── Capability (security) ──────────────────────────────────────────────────
  /** Enables write commands (SET/DEL/HSET/…). Default false = read-only. */
  allowWrite?: boolean;
  /** Writes require the argument `confirm=true`. Default false. */
  confirmDestructive?: boolean;

  // ── Mode A: template ────────────────────────────────────────────────────────
  /** Fixed command (e.g. "HGETALL"). If present → template mode. */
  command?: string;
  /** JSON arguments (array) with named param :param (Mode A). */
  argsTemplate?: string;

  // ── Mode B: free command ────────────────────────────────────────────────────
  /**
   * Name of the tool parameter that the LLM fills with the JSON spec:
   * { "command":"HGETALL", "args":["user:42"] }.
   */
  queryParam?: string;

  // ── Injected schema ────────────────────────────────────────────────────────
  /** 'compact' (default, only patterns) or 'full' (also sample keys). */
  schemaMode?: 'compact' | 'full';

  /** Cap on returned elements if the reply is an array (default 100, hard-cap 1000). */
  maxRows?: number;
  /** Command timeout in ms (default 10 000). */
  timeoutMs?: number;
}

// ── Union type ────────────────────────────────────────────────────────────────

export type ExecutorType = 'http' | 'sql' | 'prompt' | 'rag' | 'mongo' | 'redis';
export type ExecutorConfig = HttpExecutorConfig | SqlExecutorConfig | PromptExecutorConfig | RagExecutorConfig | MongoExecutorConfig | RedisExecutorConfig;

/**
 * Tool visibility scope:
 *   personal — visible and usable only by the creator
 *   team     — visible to members of team `teamId`; creation/modification by admin or team owner
 *   org      — visible and usable by the whole organization; creation/modification reserved to admins
 */
export type ToolScope = 'personal' | 'team' | 'org';
