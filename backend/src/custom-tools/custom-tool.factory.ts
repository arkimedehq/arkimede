/**
 * @file custom-tool.factory.ts
 *
 * Factory that converts a CustomTool record (from the DB) into a LangChain
 * DynamicStructuredTool ready to be passed to the ReAct agent.
 *
 * ── Flow ──────────────────────────────────────────────────────────────────────
 *  1. buildDynamicTool(def, secrets)
 *     ├─ buildZodSchema(def.parameters)       → Zod schema for the LLM
 *     └─ func(args) → executor(config, args, secrets)
 *         └─ executeHttp / executeSql / executePrompt
 *
 * ── Template interpolation ────────────────────────────────────────────────────
 *  All string values in url / headers / queryParams / bodyTemplate
 *  support three namespaces:
 *
 *    {{paramName}}         → value of the parameter provided by the LLM
 *    {{secret.KEY_NAME}}   → secret decrypted from the tool_secrets table
 *    {{env.VAR_NAME}}      → environment variable from process.env
 *
 * ── Response extraction ───────────────────────────────────────────────────────
 *  If HttpExecutorConfig.responsePath is set, it navigates the response JSON
 *  with dot-notation before stringifying it:
 *    "results"       → data.results
 *    "web.results"   → data.web.results
 *
 *  The result is truncated to maxResponseChars (default 3000) so as not to
 *  saturate the LLM's context window.
 */
import {DynamicStructuredTool} from '@langchain/core/tools';
import type { AuditService } from '../audit/audit.service';
import {z} from 'zod';
import {Logger, ForbiddenException} from '@nestjs/common';
import {safeFetch} from '../common/ssrf-guard';
import {v4 as uuidv4} from 'uuid';
import {CustomTool} from './custom-tool.entity';
import {
  ExecutorType,
  HttpExecutorConfig,
  PromptExecutorConfig,
  RagExecutorConfig,
  ResolvedDataSource,
  SqlExecutorConfig,
  SqlOp,
  MongoExecutorConfig,
  RedisExecutorConfig,
  ToolParameter,
  DocScope,
} from './custom-tool.types';
import type {SearchHit, VectorPoint} from '../vector-db/vector-store.types';
import {SchemaManifest, deniedTableNames, deniedColumnRefs, renderManifestCompact, renderManifestFull, renderManifestColumns} from '../datasources/schema-manifest.types';
import {isDocumentManifest, deniedCollectionNames, deniedFieldRefs, renderDocumentManifestCompact, renderDocumentManifestFull, renderDocumentManifestCollections} from '../datasources/document-manifest.types';
import {getDriver, SqlDriver, IntrospectColumn} from '../datasources/drivers';
import {mongoDriver, MONGO_READ_OPS, MongoExecuteSpec, MongoOp} from '../datasources/mongo/mongo.driver';
import {isKeyspaceManifest, deniedPatternForKey, renderKeyspaceManifestCompact, renderKeyspaceManifestFull} from '../datasources/keyspace-manifest.types';
import {redisDriver, classifyRedisCommand} from '../datasources/redis/redis.driver';

/**
 * Runtime dependencies needed by the Prompt executor.
 * Passed as a closure to decouple the factory from NestJS injection.
 */
export interface PromptContext {
  /**
   * Runs an LLM sub-call with the config identified by llmConfigId.
   * If llmConfigId is undefined it uses the default config.
   * Returns the response text or throws on an API error.
   */
  callLlm: (
    system:       string,
    user:         string,
    llmConfigId:  string | undefined,
    maxTokens:    number,
    temperature:  number,
  ) => Promise<string>;
}

/**
 * Runtime dependencies needed by the RAG executor.
 * Passed as a closure to decouple the factory from NestJS injection.
 *
 * embed/search     → used by mode='search'
 * embedDoc/upsert/ensureCollection/chunkText → used by mode='index'
 */
export interface RagContext {
  // ── search mode ───────────────────────────────────────────────────────────
  /** Embedding of a query (uses queryPrefix / inputType='query'). */
  embed:  (text: string) => Promise<number[]>;
  /** Semantic search by vector similarity, with an optional native filter on the payload. */
  search: (collection: string, vector: number[], limit: number, filter?: Record<string, any>) => Promise<SearchHit[]>;

  // ── index mode ────────────────────────────────────────────────────────────
  /** Embedding of a document (uses docPrefix / inputType='document'). */
  embedDoc:         (text: string) => Promise<number[]>;
  /** Inserts/updates vector points in the collection. */
  upsert:           (collection: string, points: VectorPoint[]) => Promise<void>;
  /** Ensures the collection exists with the correct vector dimension. */
  ensureCollection: (name: string) => Promise<void>;
  /** Splits the text into overlapping chunks using the active embedding config. */
  chunkText:        (text: string) => Promise<string[]>;
  /**
   * Indexes a file already present in the system via its ID.
   * Uses EmbedService.ingestFile() which extracts the text natively
   * (pdf-parse, mammoth, OCR, XLSX) — more reliable than the text transcribed by the LLM.
   */
  ingestFile:       (fileId: string, userId: string, collection: string, opts?: { scope?: DocScope; projectId?: string | null }) => Promise<{ chunks: number; collection: string }>;
}

const logger = new Logger('CustomToolFactory');

// The connection pools are managed inside each driver (datasources/drivers/),
// cached per connection string and shared across invocations.

// ── Schema cache ──────────────────────────────────────────────────────────────
// Stores the result of fetchSchema() to avoid repeated round-trips to the DB.
// TTL of 5 minutes: enough for a work session; invalidate if the schema changes.
interface SchemaCacheEntry { schema: string; ts: number }
const schemaCache = new Map<string, SchemaCacheEntry>();
const SCHEMA_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Schema cache key — does not include the plaintext credentials.
 * Uses only host+db (the part after @) + relevant structural options.
 */
function buildSchemaCacheKey(
  connStr:    string,
  config:     SqlExecutorConfig,
  dataSource: ResolvedDataSource,
): string {
  const idx  = connStr.lastIndexOf('@');
  const tail = idx >= 0 ? connStr.slice(idx + 1) : connStr.slice(-40);
  const opts = [
    dataSource.prefetchRelations ? 'pr' : '',
    // The manifest replaces live introspection: its version is part of the key.
    dataSource.schemaManifest ? `m:${dataSource.schemaManifest.generatedAt}` : '',
    // Schema rendering mode (compact/full) and state of the free notes:
    // changing them changes the injected context → they must invalidate the cache.
    `sm:${config.schemaMode ?? 'compact'}`,
    `sh:${dataSource.schemaHints?.length ?? 0}`,
  ].filter(Boolean).join('|');
  return `${tail}::${opts}`;
}

/** Names reserved for built-in tools — cannot be used as custom names */
export const RESERVED_TOOL_NAMES = new Set([
  'generate_pdf',
  'recommend_components',
  'analyze_project_completeness',
]);

// ── Dynamic Zod schema ──────────────────────────────────────────────────────

/**
 * Builds a Zod schema from an array of user-defined ToolParameter.
 * Each parameter becomes a typed field with a description for the LLM.
 */
function buildZodSchema(params: ToolParameter[]): z.ZodObject<z.ZodRawShape> {
  if (!params?.length) return z.object({});

  const shape: z.ZodRawShape = {};

  for (const p of params) {
    let field: z.ZodTypeAny;

    // String → type coercion: in Flows the node inputs always arrive as
    // strings (constants or interpolated bindings), and even an LLM can pass "true"/"42"
    // as text. The preprocess converts before validation; values already of the
    // right type pass through unchanged.
    switch (p.type) {
      case 'number':
        field = z.preprocess((v) => {
          if (typeof v !== 'string' || v.trim() === '') return v;
          const n = Number(v.trim());
          return Number.isNaN(n) ? v : n;
        }, z.number());
        break;
      case 'boolean':
        field = z.preprocess((v) => {
          if (typeof v !== 'string') return v;
          const s = v.trim().toLowerCase();
          if (['true', '1', 'yes', 'on'].includes(s)) return true;
          if (['false', '0', 'no', 'off', ''].includes(s)) return false;
          return v;
        }, z.boolean());
        break;
      default:
        field = z.string();
        break;
    }

    // The default is applied before optional() to preserve the typing
    if (p.default !== undefined) {
      field = (field as any).default(p.default);
    }

    if (!p.required) {
      field = field.optional();
    }

    // describe() is the parameter's "prompt" — the LLM reads it to understand what to enter
    shape[p.name] = field.describe(p.description);
  }

  return z.object(shape);
}

// ── Template interpolation ────────────────────────────────────────────────────

/**
 * Replaces all {{...}} placeholders in a string.
 *
 * Resolution precedence:
 *   1. {{secret.KEY}} → secrets[KEY]
 *   2. {{env.VAR}}    → process.env[VAR]
 *   3. {{param}}      → args[param]
 *
 * If the placeholder is not resolved, it is left unchanged (does not raise an error).
 */
function interpolate(
  template: string,
  args: Record<string, unknown>,
  secrets: Record<string, string>,
): string {
  return template.replace(/\{\{([\w.]+)\}\}/g, (match, path: string) => {
    if (path.startsWith('secret.')) {
      const keyName = path.slice(7);
      return secrets[keyName] ?? match;
    }
    if (path.startsWith('env.')) {
      const varName = path.slice(4);
      return process.env[varName] ?? match;
    }
    const val = args[path];
    return val !== undefined && val !== null ? String(val) : match;
  });
}

/**
 * Recursively applies `interpolate()` to all string values of an object
 * or array. Numeric/boolean values are left unchanged.
 */
function interpolateDeep(
  obj: unknown,
  args: Record<string, unknown>,
  secrets: Record<string, string>,
): unknown {
  if (typeof obj === 'string')  return interpolate(obj, args, secrets);
  if (typeof obj === 'number' || typeof obj === 'boolean' || obj === null) return obj;
  if (Array.isArray(obj))       return obj.map(item => interpolateDeep(item, args, secrets));
  if (typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([k, v]) => [
        k,
        interpolateDeep(v, args, secrets),
      ]),
    );
  }
  return obj;
}

// ── Response extraction ───────────────────────────────────────────────────────

/**
 * Navigates a JSON object via dot-notation.
 * E.g.: extractByPath(data, "web.results") → data.web.results
 */
function extractByPath(data: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((obj, key) => {
    if (obj !== null && typeof obj === 'object') {
      return (obj as Record<string, unknown>)[key];
    }
    return undefined;
  }, data);
}

/**
 * Serializes the response into a string readable by the LLM.
 * Applies extraction and truncation.
 */
function formatResponse(data: unknown, config: HttpExecutorConfig): string {
  const MAX = config.maxResponseChars ?? 3000;

  let extracted: unknown = data;
  if (config.responsePath) {
    const found = extractByPath(data, config.responsePath);
    if (found !== undefined) {
      extracted = found;
      logger.debug(`HTTP: responsePath="${config.responsePath}" extracted`);
    } else {
      logger.warn(`HTTP: responsePath="${config.responsePath}" not found in the response`);
    }
  }

  const text = typeof extracted === 'string'
    ? extracted
    : JSON.stringify(extracted, null, 2);

  if (text.length > MAX) {
    return text.slice(0, MAX) + `\n...[truncated to ${MAX} characters out of ${text.length}]`;
  }
  return text;
}

// ── Executor HTTP ─────────────────────────────────────────────────────────────

/**
 * Executes an HTTP call with the interpolated parameters.
 *
 * For GET requests: the tool parameters are added as a query string
 * if not already covered by config.queryParams.
 *
 * For POST/PUT/PATCH requests: the body is built from bodyTemplate
 * (with interpolation) or, if absent, from JSON.stringify(args).
 *
 * @returns String with the formatted response (or an error message)
 */
async function executeHttp(
  config: HttpExecutorConfig,
  args: Record<string, unknown>,
  secrets: Record<string, string>,
): Promise<string> {
  const t0 = Date.now();

  // ── URL ──────────────────────────────────────────────────────────────────
  let urlObj: URL;
  try {
    urlObj = new URL(interpolate(config.url, args, secrets));
  } catch {
    return `Error: invalid URL "${config.url}"`;
  }

  // Explicit query params (take precedence over the automatic args)
  if (config.queryParams) {
    for (const [k, v] of Object.entries(config.queryParams)) {
      urlObj.searchParams.set(k, interpolate(v, args, secrets));
    }
  }

  // For GET: all args not yet present as a query param
  if (config.method === 'GET') {
    for (const [k, v] of Object.entries(args)) {
      if (v !== undefined && v !== null && !urlObj.searchParams.has(k)) {
        urlObj.searchParams.set(k, String(v));
      }
    }
  }

  // ── Headers ───────────────────────────────────────────────────────────────
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept:         'application/json',
  };
  if (config.headers) {
    for (const [k, v] of Object.entries(config.headers)) {
      headers[k] = interpolate(v, args, secrets);
    }
  }

  // ── Body ─────────────────────────────────────────────────────────────────
  let body: string | undefined;
  if (config.method !== 'GET') {
    if (config.bodyTemplate !== undefined) {
      const resolved = interpolateDeep(config.bodyTemplate, args, secrets);
      body = typeof resolved === 'string' ? resolved : JSON.stringify(resolved);
    } else {
      // Default: serialize all the args
      body = JSON.stringify(args);
    }
  }

  // ── Fetch ─────────────────────────────────────────────────────────────────
  const urlStr = urlObj.toString();
  // Mask the query string in the log so as not to expose API keys passed as query params
  const urlLog = urlObj.origin + urlObj.pathname;
  logger.log(`HTTP ${config.method} ${urlLog}`);

  let response: Response;
  try {
    // safeFetch applies the anti-SSRF guard to the initial URL AND every redirect
    // hop (blocks EC2 metadata / internal IPs even if the URL comes from a binding/LLM).
    response = await safeFetch(urlStr, {
      method:  config.method,
      headers,
      body,
      signal:  AbortSignal.timeout(config.timeoutMs ?? 10_000),
    });
  } catch (err: any) {
    // An SSRF/security block from safeFetch is a ForbiddenException: let it propagate
    // so the caller reports a real failure — the outer wrapper turns it into a string
    // for the ReAct loop but rethrows it for the `/test` dry-run (throwOnError). Only
    // genuine network/timeout errors are downgraded to a ReAct-friendly string here.
    if (err instanceof ForbiddenException) throw err;
    const msg = err?.name === 'TimeoutError'
      ? `Timeout after ${config.timeoutMs ?? 10_000}ms`
      : `Network error: ${err.message}`;
    logger.warn(`HTTP ${config.method} ${urlLog} — ${msg}`);
    return msg;
  }

  const elapsed = Date.now() - t0;

  if (!response.ok) {
    logger.warn(`HTTP ${config.method} ${urlLog} → ${response.status} ${response.statusText} (${elapsed}ms)`);
    let errBody = '';
    try { errBody = await response.text(); } catch { /* ignore */ }
    return `HTTP error ${response.status} ${response.statusText}${errBody ? ': ' + errBody.slice(0, 300) : ''}`;
  }

  // ── Parse response ──────────────────────────────────────────────────────────
  const contentType = response.headers.get('content-type') ?? '';
  let data: unknown;

  if (contentType.includes('application/json')) {
    try {
      data = await response.json();
    } catch {
      const text = await response.text();
      logger.warn(`HTTP: response declared as JSON but not parsable`);
      return text.slice(0, config.maxResponseChars ?? 3000);
    }
  } else {
    data = await response.text();
  }

  logger.log(`HTTP ${config.method} ${urlLog} → ${response.status} (${elapsed}ms)`);
  return formatResponse(data, config);
}

// ── SQL helpers ───────────────────────────────────────────────────────────────
// Pooling, parameter binding, transactions and introspection are in the engine
// driver (datasources/drivers/). Only the formatting of the normalized rows
// into the text injected to the model remains here.

/** Removes SQL comments (block + line). */
function stripSqlComments(q: string): string {
  return q.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
}

const DDL_RE = /^(create|alter|drop|truncate|grant|revoke|comment|rename|vacuum|analyze|reindex|cluster)\b/i;

/**
 * Splits the SQL into statements on top-level ';', ignoring the ';' inside
 * quoted strings (single/double) and dollar-quoting ($tag$...$tag$).
 */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = '', i = 0;
  let quote: string | null = null;
  while (i < sql.length) {
    const c = sql[i];
    if (quote) {
      if (quote.length === 1 && c === quote) {
        if (sql[i + 1] === quote) { buf += c + c; i += 2; continue; } // '' escape
        quote = null; buf += c; i++; continue;
      }
      if (quote.length > 1 && sql.startsWith(quote, i)) { buf += quote; i += quote.length; quote = null; continue; }
      buf += c; i++; continue;
    }
    if (c === "'" || c === '"') { quote = c; buf += c; i++; continue; }
    const dq = sql.slice(i).match(/^\$[A-Za-z0-9_]*\$/);
    if (dq) { quote = dq[0]; buf += dq[0]; i += dq[0].length; continue; }
    if (c === ';') { if (buf.trim()) out.push(buf.trim()); buf = ''; i++; continue; }
    buf += c; i++;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/** Classifies the operation of a single statement. */
function classifyStatement(stmt: string): SqlOp {
  const s = stripSqlComments(stmt).trim();
  if (/^select\b/i.test(s)) return 'select';
  if (/^insert\b/i.test(s)) return 'insert';
  if (/^update\b/i.test(s)) return 'update';
  if (/^delete\b/i.test(s)) return 'delete';
  if (DDL_RE.test(s))        return 'ddl';
  if (/^with\b/i.test(s)) {
    // CTE: the data modification can be inside a CTE → classify by the write verb present
    if (/\bdelete\b/i.test(s)) return 'delete';
    if (/\bupdate\b/i.test(s)) return 'update';
    if (/\binsert\b/i.test(s)) return 'insert';
    return 'select';
  }
  return 'other';
}

/** True if the update/delete statement lacks a WHERE clause. */
function lacksWhere(stmt: string): boolean {
  return !/\bwhere\b/i.test(stripSqlComments(stmt));
}

/** Server filesystem / OS access functions — never legitimate for a data tool. */
const SQL_FS_OS_FUNCS = /\b(pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|lo_import|lo_export|load_file|xp_cmdshell|openrowset|opendatasource|utl_file)\b/i;
/** `SELECT ... INTO OUTFILE|DUMPFILE`: writes a file to the server FS (MySQL). */
const SQL_INTO_FILE = /\binto\b\s+(outfile|dumpfile)\b/i;

/**
 * Side effect hidden inside a statement the verb-classifier calls a `select`:
 *  - 'fs'   → reads/writes the server filesystem or runs OS (blocked always).
 *  - 'into' → `SELECT ... INTO <table>` materializes a table (a write; blocked on
 *             read-only tools).
 * Returns null for a pure read.
 */
function selectSideEffect(stmt: string): 'fs' | 'into' | null {
  const s = stripStringLiterals(stripSqlComments(stmt));
  if (SQL_FS_OS_FUNCS.test(s) || SQL_INTO_FILE.test(s)) return 'fs';
  if (/\binto\b/i.test(s)) return 'into';
  return null;
}

/**
 * Extracts the table names referenced by a statement (best-effort, after
 * FROM/JOIN/INTO/UPDATE). Normalizes: removes quoting, drops the schema (`db.tab`→`tab`)
 * and returns lowercase. Used for enforcing the `deny` tables.
 */
const TABLE_REF_RE = /\b(?:from|join|into|update)\s+([`"\[\]\w.$]+)/gi;
export function referencedTables(query: string): string[] {
  const s = stripSqlComments(query);
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  TABLE_REF_RE.lastIndex = 0;
  while ((m = TABLE_REF_RE.exec(s)) !== null) {
    let name = m[1].replace(/[`"\[\]]/g, '');
    const dot = name.lastIndexOf('.');
    if (dot >= 0) name = name.slice(dot + 1);
    if (name) out.add(name.toLowerCase());
  }
  return [...out];
}

/** Escapes a literal string to build a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Removes single-quoted string literals (`'...'`, with `''` escape), so that a
 * value is not mistaken for a column name when enforcing the `deny` fields.
 * Quoted identifiers (backtick / double quotes) remain: they might be
 * the referenced column itself.
 */
function stripStringLiterals(s: string): string {
  return s.replace(/'(?:[^']|'')*'/g, "''");
}

export interface SqlPolicyResult {
  /** Error message if the policy denies execution; absent if allowed. */
  error?: string;
  /** Read-only tool (`operations === ['select']`) → READ ONLY transaction. */
  isReadOnlyTool: boolean;
  /** Single SELECT → auto-LIMIT applicable. */
  onlySelect: boolean;
}

/**
 * Evaluates the SQL security policy (E1) on a query — a PURE function (no DB),
 * testable in isolation. Classifies the statements, enforces the declared
 * `operations`, the single-statement rule in free mode and the opt-in guardrails.
 */
export function evaluateSqlPolicy(
  config: SqlExecutorConfig,
  query:  string,
  args:   Record<string, unknown>,
  deniedTables:  Set<string> = new Set(),
  deniedColumns: Set<string> = new Set(),   // ref "table.column" lowercase
): SqlPolicyResult {
  const allowedOps     = (config.operations?.length ? config.operations : ['select']) as SqlOp[];
  const isReadOnlyTool = allowedOps.length === 1 && allowedOps[0] === 'select';
  const deny = (error: string): SqlPolicyResult => ({ error, isReadOnlyTool, onlySelect: false });

  const statements = splitStatements(stripSqlComments(query));
  if (statements.length === 0) return deny('Error: empty SQL query.');

  if (config.queryParam && statements.length > 1) {
    return deny('Security error: in free query mode only a single statement per call is allowed.');
  }

  const DESTRUCTIVE: SqlOp[] = ['update', 'delete', 'ddl'];
  for (const stmt of statements) {
    const op = classifyStatement(stmt);
    if (!allowedOps.includes(op)) {
      return deny(`Security error: operation "${op}" not allowed for this tool (allowed: ${allowedOps.join(', ')}).`);
    }
    // A statement the verb-classifier calls `select` can still write or touch the
    // server FS/OS (SELECT INTO, INTO OUTFILE, pg_read_file, xp_cmdshell, …). These
    // slip past the operation allowlist, so gate them explicitly.
    if (op === 'select') {
      const side = selectSideEffect(stmt);
      if (side === 'fs') {
        return deny('Security error: server filesystem/OS access (e.g. INTO OUTFILE, pg_read_file, xp_cmdshell) is not allowed.');
      }
      if (side === 'into' && isReadOnlyTool) {
        return deny('Security error: "SELECT ... INTO" writes a table and is not allowed on a read-only tool.');
      }
    }
    if (config.requireWhere && (op === 'update' || op === 'delete') && lacksWhere(stmt)) {
      return deny(`Security error: ${op.toUpperCase()} without a WHERE clause is not allowed (requireWhere active).`);
    }
    if (config.confirmDestructive && DESTRUCTIVE.includes(op) && args.confirm !== true) {
      return deny(`Destructive operation (${op.toUpperCase()}): requires confirmation. Call the tool again with confirm=true.`);
    }
    if (deniedTables.size) {
      const hit = referencedTables(stmt).find((t) => deniedTables.has(t));
      if (hit) {
        return deny(`Security error: table "${hit}" not accessible (denied in the schema configuration).`);
      }
    }

    // ── `deny` fields (best-effort) ───────────────────────────────────────────
    if (deniedColumns.size) {
      const lc  = stripStringLiterals(stmt).toLowerCase();
      const refd = new Set(referencedTables(stmt));
      const tablesWithDenied = new Set([...deniedColumns].map((r) => r.slice(0, r.indexOf('.'))));

      // 1. Explicit qualified reference "table.column"
      for (const ref of deniedColumns) {
        if (new RegExp(`\\b${escapeRe(ref)}\\b`, 'i').test(lc)) {
          return deny(`Security error: column "${ref}" not accessible (denied in the schema configuration).`);
        }
      }

      // 2/3. For each table cited that has denied columns
      for (const t of refd) {
        if (!tablesWithDenied.has(t)) continue;

        // SELECT * / t.* would leak the denied column
        if (/\bselect\s+\*/i.test(stmt) || /[`"\]\w]\s*\.\s*\*/.test(stmt)) {
          return deny(
            `Security error: "SELECT *" not allowed on "${t}" (contains denied columns). ` +
            `Explicitly list the columns you need.`,
          );
        }

        // Bare reference to the denied column name of this table
        for (const ref of deniedColumns) {
          const dot = ref.indexOf('.');
          if (ref.slice(0, dot) !== t) continue;
          const col = ref.slice(dot + 1);
          if (new RegExp(`\\b${escapeRe(col)}\\b`, 'i').test(lc)) {
            return deny(`Security error: column "${t}.${col}" not accessible (denied in the schema configuration).`);
          }
        }
      }
    }
  }

  const onlySelect = statements.length === 1 && classifyStatement(statements[0]) === 'select';
  return { isReadOnlyTool, onlySelect };
}

/** Serializes JSON rows with an optional column projection and a truncation message. */
function formatSqlRows(
  rows:   Record<string, unknown>[],
  config: SqlExecutorConfig,
): string {
  const maxRows = Math.min(config.maxRows ?? 50, 500);
  let limited   = rows.slice(0, maxRows);

  if (config.columns?.length) {
    limited = limited.map(r =>
      Object.fromEntries(config.columns!.map(c => [c, r[c]])),
    );
  }

  if (!limited.length) return 'No results found.';

  const json   = JSON.stringify(limited, null, 2);
  const suffix = rows.length > maxRows
    ? `\n\n[Limited to ${maxRows} rows out of ${rows.length} total]`
    : '';
  return json + suffix;
}

/**
 * Formats the columns compactly to reduce tokens:
 *   tableName:\n  col1(type) NN [KEY] — comment
 * Consumes the NORMALIZED rows from the drivers (IntrospectColumn[]).
 */
function formatAllColumnsCompact(cols: IntrospectColumn[]): string {
  const byTable = new Map<string, string[]>();
  for (const c of cols) {
    const nullable = c.nullable === false ? ' NN' : '';
    const key      = c.key ? ` [${c.key}]` : '';
    const comment  = c.comment?.trim() ? ` — ${c.comment.trim()}` : '';
    const line     = `${c.name}(${c.type})${nullable}${key}${comment}`;
    if (!byTable.has(c.tableName)) byTable.set(c.tableName, []);
    byTable.get(c.tableName)!.push(line);
  }
  return Array.from(byTable.entries())
    .map(([tbl, lines]) => `${tbl}:\n  ${lines.join('\n  ')}`)
    .join('\n\n');
}

// ── LIVE introspection primitives (delegate to the driver; shared formatting) ─

/** Live: all the DB columns in compact format (full mode). */
async function fetchAllColumns(connStr: string, driver: SqlDriver, timeout: number): Promise<string> {
  return formatAllColumnsCompact(await driver.fetchAllColumns(connStr, timeout));
}

/** Live: table list with comments (step 1 of compact, and the base of full). */
async function liveTableList(connStr: string, driver: SqlDriver, timeout: number): Promise<string> {
  const tables = await driver.fetchTables(connStr, timeout);
  const lines = tables.map((t) => `  ${t.name}${t.comment?.trim() ? ` — ${t.comment.trim()}` : ''}`);
  return `[Available tables (${tables.length})]\n${lines.join('\n')}`;
}

/** Live: FK relations declared in the DB (null if none). */
async function liveRelations(connStr: string, driver: SqlDriver, timeout: number): Promise<string | null> {
  const rels = await driver.fetchRelations(connStr, timeout);
  if (!rels.length) return null;
  const lines = rels.map((r) => `  ${r.fromTable}.${r.fromCol} → ${r.toTable}.${r.toCol}`);
  return `[Relations]\n${lines.join('\n')}`;
}

/** Live: columns (type + comment) of the requested tables — describe on-demand (step 2). */
async function liveColumns(connStr: string, driver: SqlDriver, timeout: number, tableNames: string[]): Promise<string> {
  const sections: string[] = [];
  for (const tableName of tableNames) {
    const cols = await driver.fetchColumns(connStr, timeout, [tableName]);
    if (!cols.length) { sections.push(`### ${tableName}\n  (table not found)`); continue; }
    const colLines = cols.map((c) => {
      const cm = c.comment?.trim() ? ` — ${c.comment.trim()}` : '';
      return `    - ${c.name} (${c.type})${cm}`;
    });
    sections.push(`### ${tableName}\n  columns:\n${colLines.join('\n')}`);
  }
  return sections.join('\n\n');
}

/**
 * Schema pre-fetch injected to the LLM before the query (free-mode).
 *   - With a curated manifest → render compact/full from the manifest (no DB).
 *   - Without a manifest → LIVE introspection: compact (table list + relations) or
 *     full (also all the columns); the columns on-demand via `describe_tables`.
 */
async function fetchSchema(
  connStr:    string,
  driver:     SqlDriver,
  config:     SqlExecutorConfig,
  dataSource: ResolvedDataSource,
  timeout:    number,
): Promise<string> {
  const parts: string[] = [];

  // ── 0. SQL dialect ─────────────────────────────────────────────────────────
  // Tells the model which dialect to use to write correct SQL (LIMIT vs TOP
  // vs FETCH FIRST, quoting, etc.) — previously conveyed only via schemaHints.
  parts.push(`[SQL dialect: ${driver.engine}]${driver.syntaxHint ? ` ${driver.syntaxHint}` : ''}`);

  // ── 1. Free notes from the DataSource ──────────────────────────────────────
  // schemaHints is ONLY a channel for free-text notes (business rules,
  // query suggestions). The structure (tables/columns/relations/deny) does NOT
  // go here: with a manifest present the structure comes only from the manifest,
  // so there is no duplication. Without a manifest, schemaHints + live prefetch.
  if (dataSource.schemaHints?.trim()) {
    parts.push(`[Notes]\n${dataSource.schemaHints.trim()}`);
    logger.log(`SQL prefetch: schemaHints notes injected (${dataSource.schemaHints.length} chars)`);
  }

  // ── Curated manifest: single source of the schema (no live introspection) ─
  // Per-tool mode: 'compact' (default, lightweight, no columns) or 'full'
  // (self-contained with columns + FK + localized relations). Excludes the `deny` ones.
  // The SQL path uses only SchemaManifest: a possible DocumentManifest (Mongo) here
  // does not occur (different engine) → defensive narrow.
  const sqlManifest: SchemaManifest | null =
    (isDocumentManifest(dataSource.schemaManifest) || isKeyspaceManifest(dataSource.schemaManifest))
      ? null : (dataSource.schemaManifest ?? null);
  if (sqlManifest) {
    const mode = config.schemaMode ?? 'compact';
    const rendered = mode === 'full'
      ? renderManifestFull(sqlManifest)
      : renderManifestCompact(sqlManifest);
    parts.push(rendered);
    logger.log(
      `SQL prefetch: schema from manifest (${mode}, ${sqlManifest.tables.length} tables)`,
    );
    return parts.join('\n\n');
  }

  // ── Live (no manifest): schemaMode governs; list_tables always present ──
  const mode = config.schemaMode ?? 'compact';
  parts.push(await liveTableList(connStr, driver, timeout));

  // FK relations declared (if the DataSource has the toggle enabled).
  if (dataSource.prefetchRelations) {
    const rels = await liveRelations(connStr, driver, timeout);
    if (rels) parts.push(rels);
  }

  if (mode === 'full') {
    try {
      parts.push(`[Full column schema]\n${await fetchAllColumns(connStr, driver, timeout)}`);
    } catch (err: any) {
      parts.push(`[Column schema not available: ${err.message}]`);
    }
  } else {
    parts.push(
      'The columns are not listed here. Before writing the query, call the tool ' +
      'with "describe_tables": ["tab1","tab2"] to receive the fields of the tables you need.',
    );
  }

  return parts.join('\n\n');
}

// ── Executor SQL ──────────────────────────────────────────────────────────────

/**
 * Executes the SQL tool in mode A (parameterized template) or B (freeQuery / Text-to-SQL).
 *
 * Mode A — queryTemplate:
 *   Fixed query with named params :paramName. The values are bound safely.
 *   Zero params = query without binding (e.g. list_tables style).
 *
 * Mode B — queryParam:
 *   The LLM provides the full SELECT as the value of the indicated parameter.
 *   If the parameter is absent → returns only the schema prefetch (first step).
 *   If the parameter is present → validates + executes (second step).
 *
 * Security (E1):
 *   - Per-tool capability: `operations` (default ['select']); the parser enforces
 *     only the declared operations (classifies each statement).
 *   - Mode B (free): a single statement per call (anti-injection).
 *   - Read-only tool → READ ONLY transaction (DB guarantee); write tool →
 *     transaction with rollback on error.
 *   - Opt-in guardrails: requireWhere, confirmDestructive.
 *   - LIMIT auto-added only to single SELECTs.
 *   - Params always bound (never string-interpolated).
 *   - connectionString resolved only via {{secret.*}} / {{env.*}}, never from LLM args.
 */
async function executeSql(
  config:     SqlExecutorConfig,
  args:       Record<string, unknown>,
  secrets:    Record<string, string>,
  dataSource: ResolvedDataSource | undefined,
): Promise<string> {
  if (!dataSource) {
    return 'SQL configuration error: data source not found or not accessible. ' +
           'Verify that the selected DataSource exists and is accessible to your account.';
  }
  const t0      = Date.now();
  const connStr = dataSource.connectionString;
  const maxRows = Math.min(config.maxRows ?? 50, 500);
  const timeout = config.timeoutMs ?? 10_000;

  let driver: SqlDriver;
  try {
    driver = getDriver(dataSource.engine);
  } catch (err: any) {
    return `SQL configuration error: ${err.message}`;
  }

  // The SQL tool uses only SchemaManifest (a DocumentManifest does not arrive here:
  // different engine) → narrow once for the schema guards/render.
  const sqlManifest: SchemaManifest | null =
    (isDocumentManifest(dataSource.schemaManifest) || isKeyspaceManifest(dataSource.schemaManifest))
      ? null : (dataSource.schemaManifest ?? null);

  // ── Schema pre-fetch (with cache) ─────────────────────────────────────────
  const prefixParts: string[] = [];

  // Are we about to EXECUTE a query? (template, or free-query with a SELECT provided)
  const submittedQuery = config.queryParam ? args[config.queryParam] : undefined;
  const willExecuteQuery =
    !!config.queryTemplate ||
    (!!config.queryParam && submittedQuery != null && String(submittedQuery).trim() !== '');

  // The schema is injected ONLY when NOT executing a query (step 1 / describe):
  // prepending it to the results would be just noise and wasted tokens (the LLM has
  // already seen it at step 1). In free query without a query → always (otherwise it makes it up).
  const needsPrefetch =
    !willExecuteQuery &&
    (config.queryParam || dataSource.schemaHints || dataSource.schemaManifest);

  if (needsPrefetch) {
    const cacheKey   = buildSchemaCacheKey(connStr, config, dataSource);
    const cached     = schemaCache.get(cacheKey);
    const now        = Date.now();

    if (cached && (now - cached.ts) < SCHEMA_CACHE_TTL_MS) {
      // ✅ Cache HIT — schema already known, no query to the DB
      const ageS = Math.round((now - cached.ts) / 1000);
      logger.log(`SQL schema cache HIT (${ageS}s ago) — skip prefetch DB`);
      prefixParts.push(cached.schema);
    } else {
      // ❌ Cache MISS — run the prefetch and store it
      try {
        const schema = await fetchSchema(connStr, driver, config, dataSource, timeout);
        if (schema) {
          prefixParts.push(schema);
          schemaCache.set(cacheKey, { schema, ts: now });
          logger.log(`SQL schema cache SET (${schema.length} chars)`);
        }
      } catch (err: any) {
        logger.warn(`SQL prefetch schema error: ${err.message}`);
        prefixParts.push(`[Schema not available: ${err.message}]`);
      }
    }
  }

  // ── Determine query ───────────────────────────────────────────────────────
  let query: string | undefined;

  if (config.queryParam) {
    // Mode B: the LLM provides the query
    const submitted = args[config.queryParam];

    if (submitted === undefined || submitted === null || String(submitted).trim() === '') {
      // Step 2 (compact on-demand): if the model asks for the columns of specific
      // tables via describe_tables → returns only those. Source: manifest
      // if present (fields+FK, respects the deny), otherwise LIVE introspection.
      const describe = args['describe_tables'];
      if (Array.isArray(describe) && describe.length) {
        const names = describe.map((x) => String(x));
        logger.log(`SQL describe_tables: ${names.join(', ')}`);
        return sqlManifest
          ? renderManifestColumns(sqlManifest, names)
          : await liveColumns(connStr, driver, timeout, names);
      }

      // First call without a query → returns the schema (step 1) and invites to call again
      const schemaOut = prefixParts.join('\n\n');
      return schemaOut
        ? `${schemaOut}\n\n[Call the tool again with the "${config.queryParam}" parameter ` +
          `filled in with the desired SELECT.]`
        : `Specify a SELECT query in the "${config.queryParam}" parameter.`;
    }

    query = String(submitted).trim();

  } else if (config.queryTemplate) {
    // Mode A: fixed template
    query = config.queryTemplate.trim();

  } else {
    return 'SQL configuration error: specify queryTemplate (Mode A) or queryParam (Mode B).';
  }

  // ── Capability gate (E1): allowed operations, single-statement, guardrails ─
  // The manifest's `deny` tables are blocked even if the agent references them.
  const policy = evaluateSqlPolicy(
    config, query, args,
    deniedTableNames(sqlManifest),
    deniedColumnRefs(sqlManifest),
  );
  if (policy.error) return policy.error;
  const { isReadOnlyTool, onlySelect } = policy;

  // ── Auto-LIMIT (only for a single SELECT) — dialect syntax ──────────────────
  const safeQuery = onlySelect ? driver.applyRowLimit(query, maxRows) : query;
  logger.log(`SQL (${driver.engine})${isReadOnlyTool ? ' [RO]' : ''}: ${safeQuery.replace(/\s+/g, ' ').slice(0, 120)}`);

  // ── Execute via the driver (READ ONLY transaction for read-only tools) ──────
  // rawQuery=true in Mode B (the model's free query): no param binding.
  let rows: Record<string, unknown>[] = [];
  let affected = 0;

  try {
    const res = await driver.execute(connStr, {
      sql:      safeQuery,
      params:   args,
      readOnly: isReadOnlyTool,
      timeout,
      rawQuery: !!config.queryParam,
    });
    rows     = res.rows;
    affected = res.affected;
  } catch (err: any) {
    logger.warn(`SQL (${driver.engine}) query error: ${err.message}`);
    const prefix = prefixParts.length ? prefixParts.join('\n\n') + '\n\n' : '';
    return `${prefix}SQL error: ${err.message}`;
  }

  const elapsed = Date.now() - t0;
  logger.log(`SQL (${driver.engine}): ${onlySelect ? `${rows.length} rows` : `${affected} rows affected`} in ${elapsed}ms`);

  const body = onlySelect
    ? formatSqlRows(rows, config)
    : `Operation completed. Rows affected: ${affected}.`;
  return [...prefixParts, body].join('\n\n');
}

// ── Mongo executor (document DataSource) ────────────────────────────────────────

const MONGO_WRITE_OPS: MongoOp[] = ['insertOne','insertMany','updateOne','updateMany','deleteOne','deleteMany'];

/**
 * True if a Mongo aggregate pipeline contains a write stage ($out/$merge), which
 * persists/overwrites a collection (and $merge can target another DB) despite
 * `aggregate` being classified as a read op. $out/$merge are only ever top-level
 * stages, so a top-level scan is complete.
 */
export function aggregateHasWriteStage(pipeline: unknown): boolean {
  return Array.isArray(pipeline) && pipeline.some(
    (s) => s !== null && typeof s === 'object' && ('$out' in s || '$merge' in s),
  );
}

/**
 * All OTHER collections an aggregate pipeline reaches — $lookup / $graphLookup /
 * $unionWith / $out / $merge — recursing into nested sub-pipelines ($lookup.pipeline,
 * $unionWith.pipeline, $facet). Used to extend the manifest collection-deny to
 * pipeline stages (the top-level check only sees spec.collection).
 */
export function aggregateReferencedCollections(pipeline: unknown): string[] {
  const out: string[] = [];
  const add = (v: unknown) => { if (typeof v === 'string' && v) out.push(v); };
  const walk = (p: unknown): void => {
    if (!Array.isArray(p)) return;
    for (const stage of p) {
      if (!stage || typeof stage !== 'object') continue;
      const s = stage as Record<string, any>;
      if (s.$lookup) { add(s.$lookup.from); walk(s.$lookup.pipeline); }
      if (s.$graphLookup) add(s.$graphLookup.from);
      if (s.$unionWith) {
        if (typeof s.$unionWith === 'string') add(s.$unionWith);
        else { add(s.$unionWith.coll); walk(s.$unionWith.pipeline); }
      }
      if (s.$out) add(typeof s.$out === 'string' ? s.$out : s.$out?.coll);
      if (s.$merge) {
        const into = typeof s.$merge === 'string' ? s.$merge : s.$merge?.into;
        add(typeof into === 'string' ? into : into?.coll);
      }
      if (s.$facet && typeof s.$facet === 'object') {
        for (const sub of Object.values(s.$facet)) walk(sub);
      }
    }
  };
  walk(pipeline);
  return out;
}

const MONGO_SYNTAX_NOTE =
  'Write the spec as JSON: { "collection":"name", "op":"find"|"aggregate"|"countDocuments"|"distinct", ' +
  '"filter":{…} | "pipeline":[…], "projection":{…}, "sort":{…}, "limit":N }. Mongo queries are NOT SQL.';

/** Replaces the named params :name in a JSON template with the JSON-encoded value. */
function fillJsonTemplate(tpl: string, args: Record<string, unknown>): string {
  return tpl.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name: string) => JSON.stringify(args[name] ?? null));
}

/** Serializes the documents with an optional top-level projection and a truncation message. */
function formatMongoRows(rows: Record<string, unknown>[], config: MongoExecutorConfig): string {
  const maxRows = Math.min(config.maxRows ?? 50, 500);
  let limited = rows.slice(0, maxRows);
  if (config.projection?.length) {
    limited = limited.map((r) => Object.fromEntries(config.projection!.map((c) => [c, (r as any)[c]])));
  }
  if (!limited.length) return 'No documents found.';
  const json = JSON.stringify(limited, null, 2);
  const suffix = rows.length > maxRows ? `\n\n[Limited to ${maxRows} documents out of ${rows.length}]` : '';
  return json + suffix;
}

/** Document schema pre-fetch injected to the model (manifest or live). */
async function fetchMongoSchema(
  connStr: string,
  config: MongoExecutorConfig,
  dataSource: ResolvedDataSource,
  timeout: number,
): Promise<string> {
  const parts: string[] = [`[Engine: MongoDB] ${MONGO_SYNTAX_NOTE}`];
  if (dataSource.schemaHints?.trim()) parts.push(`[Notes]\n${dataSource.schemaHints.trim()}`);

  const manifest = isDocumentManifest(dataSource.schemaManifest) ? dataSource.schemaManifest : null;
  if (manifest) {
    const mode = config.schemaMode ?? 'compact';
    parts.push(mode === 'full' ? renderDocumentManifestFull(manifest) : renderDocumentManifestCompact(manifest));
    return parts.join('\n\n');
  }

  // Live: list of collections; in full it samples the fields of all of them (can be costly).
  const names = await mongoDriver.listCollections(connStr);
  parts.push(`[Available collections (${names.length})]\n${names.map((n) => `  ${n}`).join('\n')}`);
  if ((config.schemaMode ?? 'compact') === 'full') {
    const cols = await mongoDriver.sampleCollections(connStr, names);
    parts.push(renderDocumentManifestFull({ generatedAt: '', engine: 'mongodb', collections: cols }));
  } else {
    parts.push('The fields are not listed here. Call the tool with "describe_collections": ["coll1"] to get the fields.');
  }
  void timeout;
  return parts.join('\n\n');
}

/**
 * Executes the Mongo tool in Mode A (template: collection+op+filter/pipeline with :param)
 * or Mode B (free query: the model provides the JSON spec in config.queryParam).
 * Security: `operations` whitelist (default read-only), confirm for writes,
 * deny of collections/fields from the manifest (best-effort), maxRows.
 */
async function executeMongo(
  config: MongoExecutorConfig,
  args: Record<string, unknown>,
  dataSource: ResolvedDataSource | undefined,
): Promise<string> {
  if (!dataSource) {
    return 'Mongo configuration error: data source not found or not accessible.';
  }
  const t0 = Date.now();
  const connStr = dataSource.connectionString;
  const maxRows = Math.min(config.maxRows ?? 50, 500);
  const timeout = config.timeoutMs ?? 10_000;
  const manifest = isDocumentManifest(dataSource.schemaManifest) ? dataSource.schemaManifest : null;

  const submitted = config.queryParam ? args[config.queryParam] : undefined;
  const hasSubmitted = submitted != null && String(submitted).trim() !== '';
  const isTemplate = !!config.collection;
  const willExecute = isTemplate || (!!config.queryParam && hasSubmitted);

  // ── Schema prefetch (only if not executing a query) ────────────────────────
  const prefixParts: string[] = [];
  const needsPrefetch = !willExecute && (config.queryParam || dataSource.schemaHints || manifest);
  if (needsPrefetch) {
    try {
      prefixParts.push(await fetchMongoSchema(connStr, config, dataSource, timeout));
    } catch (err: any) {
      prefixParts.push(`[Schema not available: ${err.message}]`);
    }
  }

  // ── Mode B without a spec → describe_collections or invitation ──────────────
  if (config.queryParam && !hasSubmitted && !isTemplate) {
    const describe = args['describe_collections'];
    if (Array.isArray(describe) && describe.length) {
      const names = describe.map((x) => String(x));
      if (manifest) return renderDocumentManifestCollections(manifest, names);
      const cols = await mongoDriver.sampleCollections(connStr, names);
      return renderDocumentManifestFull({ generatedAt: '', engine: 'mongodb', collections: cols });
    }
    const out = prefixParts.join('\n\n');
    return out
      ? `${out}\n\n[Call the tool again with "${config.queryParam}" filled in with the JSON spec of the operation.]`
      : `Specify the JSON spec of the operation in the "${config.queryParam}" parameter.`;
  }

  // ── Build the spec ────────────────────────────────────────────────────────
  let spec: MongoExecuteSpec;
  try {
    if (isTemplate) {
      spec = {
        collection: config.collection!,
        op: (config.operation ?? 'find') as MongoOp,
        filter: config.filterTemplate ? JSON.parse(fillJsonTemplate(config.filterTemplate, args)) : undefined,
        pipeline: config.pipelineTemplate ? JSON.parse(fillJsonTemplate(config.pipelineTemplate, args)) : undefined,
        projection: config.projection?.length ? Object.fromEntries(config.projection.map((c) => [c, 1])) : undefined,
      };
    } else {
      const parsed = JSON.parse(String(submitted));
      if (!parsed || typeof parsed !== 'object' || !parsed.collection || !parsed.op) {
        return 'Error: the JSON spec must have at least "collection" and "op". ' + MONGO_SYNTAX_NOTE;
      }
      spec = parsed as MongoExecuteSpec;
    }
  } catch (err: any) {
    return `Error: invalid JSON spec (${err.message}). ${MONGO_SYNTAX_NOTE}`;
  }

  // ── Capability gate ─────────────────────────────────────────────────────────
  const allowedOps = (config.operations?.length ? config.operations : MONGO_READ_OPS) as MongoOp[];
  if (!allowedOps.includes(spec.op)) {
    return `Security error: operation "${spec.op}" not allowed for this tool (allowed: ${allowedOps.join(', ')}).`;
  }
  if (config.confirmDestructive && MONGO_WRITE_OPS.includes(spec.op) && args.confirm !== true) {
    return `Write operation (${spec.op}): requires confirmation. Call the tool again with confirm=true.`;
  }
  // `aggregate` is a read op, but a pipeline ending in $out/$merge WRITES (overwrites
  // or creates a collection, and $merge can target another DB). Treat those stages as
  // a write: block them unless the tool explicitly permits writes, and honour the
  // destructive-confirm guardrail. ($out/$merge are only ever top-level stages.)
  if (spec.op === 'aggregate' && aggregateHasWriteStage(spec.pipeline)) {
    const toolAllowsWrite = allowedOps.some((op) => MONGO_WRITE_OPS.includes(op));
    if (!toolAllowsWrite) {
      return `Security error: aggregation write stages ($out/$merge) are not allowed for this tool (read-only capability).`;
    }
    if (config.confirmDestructive && args.confirm !== true) {
      return `Aggregation writes to a collection ($out/$merge): requires confirmation. Call the tool again with confirm=true.`;
    }
  }

  // deny of collections/fields from the manifest (best-effort on the top-level fields cited).
  if (manifest) {
    const coll = spec.collection.toLowerCase();
    const deniedColls = deniedCollectionNames(manifest);
    if (deniedColls.has(coll)) {
      return `Security error: collection "${spec.collection}" not accessible (denied in the schema).`;
    }
    // Extend the deny to collections reached via aggregate pipeline stages
    // ($lookup/$graphLookup/$unionWith/$out/$merge), incl. nested sub-pipelines.
    if (spec.op === 'aggregate') {
      for (const c of aggregateReferencedCollections(spec.pipeline)) {
        if (deniedColls.has(c.toLowerCase())) {
          return `Security error: collection "${c}" not accessible (denied in the schema).`;
        }
      }
    }
    const deniedRefs = deniedFieldRefs(manifest);
    const referenced = new Set<string>([
      ...Object.keys(spec.filter ?? {}),
      ...Object.keys(spec.projection ?? {}),
      ...Object.keys(spec.sort ?? {}),
    ]);
    for (const f of referenced) {
      if (deniedRefs.has(`${coll}.${f.toLowerCase()}`)) {
        return `Security error: field "${spec.collection}.${f}" not accessible (denied in the schema).`;
      }
    }
  }

  const isRead = MONGO_READ_OPS.includes(spec.op);
  logger.log(`Mongo (${spec.op} ${spec.collection})${isRead ? ' [RO]' : ''}`);

  // ── Execute ───────────────────────────────────────────────────────────────
  let res: { rows: Record<string, unknown>[]; affected: number };
  try {
    res = await mongoDriver.execute(connStr, spec, maxRows, timeout);
  } catch (err: any) {
    logger.warn(`Mongo error: ${err.message}`);
    const prefix = prefixParts.length ? prefixParts.join('\n\n') + '\n\n' : '';
    return `${prefix}Mongo error: ${err.message}`;
  }

  const elapsed = Date.now() - t0;
  logger.log(`Mongo (${spec.op}): ${res.rows.length} doc / ${res.affected} affected in ${elapsed}ms`);

  const body = isRead && spec.op !== 'countDocuments'
    ? formatMongoRows(res.rows, config)
    : (spec.op === 'countDocuments'
        ? `Count: ${res.affected}`
        : `Operation completed. Documents affected: ${res.affected}.`);
  return [...prefixParts, body].join('\n\n');
}

// ── Redis executor (key-value DataSource) ──────────────────────────────────────

const REDIS_SYNTAX_NOTE =
  'Write the spec as JSON: { "command":"HGETALL"|"GET"|"LRANGE"|"SCAN"|…, "args":["key", …] }. ' +
  'Redis is NOT SQL: use Redis commands. Use SCAN to explore the keys.';

/** Keyspace pre-fetch injected to the model (manifest or live). */
async function fetchRedisSchema(
  connStr: string,
  config: RedisExecutorConfig,
  dataSource: ResolvedDataSource,
): Promise<string> {
  const parts: string[] = [`[Engine: Redis] ${REDIS_SYNTAX_NOTE}`];
  if (dataSource.schemaHints?.trim()) parts.push(`[Notes]\n${dataSource.schemaHints.trim()}`);

  const manifest = isKeyspaceManifest(dataSource.schemaManifest) ? dataSource.schemaManifest : null;
  if (manifest) {
    const mode = config.schemaMode ?? 'compact';
    parts.push(mode === 'full' ? renderKeyspaceManifestFull(manifest) : renderKeyspaceManifestCompact(manifest));
    return parts.join('\n\n');
  }

  // Live: samples the keyspace.
  const fresh = await redisDriver.introspectKeyspace(connStr);
  parts.push((config.schemaMode ?? 'compact') === 'full'
    ? renderKeyspaceManifestFull(fresh)
    : renderKeyspaceManifestCompact(fresh));
  return parts.join('\n\n');
}

/**
 * Executes the Redis tool in Mode A (template: fixed command + args with :param) or
 * Mode B (free command: the model provides { command, args }). Security: read
 * commands always ok, write only if allowWrite (with confirm), administrative/
 * dangerous commands always blocked, deny of the key patterns.
 */
async function executeRedis(
  config: RedisExecutorConfig,
  args: Record<string, unknown>,
  dataSource: ResolvedDataSource | undefined,
): Promise<string> {
  if (!dataSource) return 'Redis configuration error: data source not found or not accessible.';
  const t0 = Date.now();
  const connStr = dataSource.connectionString;
  const maxRows = Math.min(config.maxRows ?? 100, 1000);
  const manifest = isKeyspaceManifest(dataSource.schemaManifest) ? dataSource.schemaManifest : null;

  const submitted = config.queryParam ? args[config.queryParam] : undefined;
  const hasSubmitted = submitted != null && String(submitted).trim() !== '';
  const isTemplate = !!config.command;
  const willExecute = isTemplate || (!!config.queryParam && hasSubmitted);

  const prefixParts: string[] = [];
  const needsPrefetch = !willExecute && (config.queryParam || dataSource.schemaHints || manifest);
  if (needsPrefetch) {
    try {
      prefixParts.push(await fetchRedisSchema(connStr, config, dataSource));
    } catch (err: any) {
      prefixParts.push(`[Schema not available: ${err.message}]`);
    }
  }

  // Mode B without a spec → invitation (or describe live patterns).
  if (config.queryParam && !hasSubmitted && !isTemplate) {
    const out = prefixParts.join('\n\n');
    return out
      ? `${out}\n\n[Call the tool again with "${config.queryParam}" filled in with { command, args }.]`
      : `Specify { command, args } in the "${config.queryParam}" parameter.`;
  }

  // ── Build command + args ────────────────────────────────────────────────────
  let command: string;
  let cmdArgs: unknown[];
  try {
    if (isTemplate) {
      command = config.command!;
      cmdArgs = config.argsTemplate ? JSON.parse(fillJsonTemplate(config.argsTemplate, args)) : [];
    } else {
      const parsed = JSON.parse(String(submitted));
      if (!parsed?.command) return 'Error: the JSON spec must have "command". ' + REDIS_SYNTAX_NOTE;
      command = String(parsed.command);
      cmdArgs = Array.isArray(parsed.args) ? parsed.args : [];
    }
  } catch (err: any) {
    return `Error: invalid JSON spec (${err.message}). ${REDIS_SYNTAX_NOTE}`;
  }
  if (!Array.isArray(cmdArgs)) cmdArgs = [];

  // ── Capability gate ─────────────────────────────────────────────────────────
  const klass = classifyRedisCommand(command);
  if (klass === 'blocked') {
    return `Security error: command "${command.toUpperCase()}" not allowed (administrative/dangerous).`;
  }
  if (klass === 'write') {
    if (!config.allowWrite) {
      return `Security error: write command "${command.toUpperCase()}" not allowed (read-only tool).`;
    }
    if (config.confirmDestructive && args.confirm !== true) {
      return `Write operation (${command.toUpperCase()}): requires confirmation. Call the tool again with confirm=true.`;
    }
  }

  // deny of the key patterns (the key is usually the first argument).
  if (manifest && cmdArgs.length) {
    const key = String(cmdArgs[0]);
    const denied = deniedPatternForKey(manifest, key);
    if (denied) return `Security error: key "${key}" not accessible (denied pattern "${denied}").`;
  }

  logger.log(`Redis (${command.toUpperCase()})${klass === 'read' ? ' [RO]' : ''}`);

  // ── Execute ───────────────────────────────────────────────────────────────
  let reply: unknown;
  try {
    ({ reply } = await redisDriver.execute(connStr, command, cmdArgs));
  } catch (err: any) {
    logger.warn(`Redis error: ${err.message}`);
    const prefix = prefixParts.length ? prefixParts.join('\n\n') + '\n\n' : '';
    return `${prefix}Redis error: ${err.message}`;
  }

  // Cap on long arrays.
  if (Array.isArray(reply) && reply.length > maxRows) {
    reply = [...reply.slice(0, maxRows), `… [${reply.length - maxRows} elements omitted]`];
  }

  const elapsed = Date.now() - t0;
  logger.log(`Redis (${command.toUpperCase()}): reply ${Array.isArray(reply) ? `${reply.length} el.` : typeof reply} in ${elapsed}ms`);

  const body = reply === null || reply === undefined
    ? '(nil)'
    : typeof reply === 'string' ? reply : JSON.stringify(reply, null, 2);
  return [...prefixParts, body].join('\n\n');
}

// ── Prompt executor ─────────────────────────────────────────────────────────

/**
 * Runs an LLM sub-call with a system + user prompt configured by the user.
 *
 * Flow:
 *   1. Interpolate systemPrompt and userPromptTemplate with args/secrets
 *   2. If userPromptTemplate is absent → serialize the non-empty args as JSON
 *   3. Call ctx.callLlm with the configured model (default: Haiku)
 *   4. Return the text response to the main agent
 */
async function executePrompt(
  config:  PromptExecutorConfig,
  args:    Record<string, unknown>,
  secrets: Record<string, string>,
  ctx:     PromptContext,
): Promise<string> {
  const system = interpolate(config.systemPrompt, args, secrets);

  let user: string;
  if (config.userPromptTemplate) {
    user = interpolate(config.userPromptTemplate, args, secrets);
  } else {
    const filtered = Object.fromEntries(
      Object.entries(args).filter(([, v]) => v !== undefined && v !== null && v !== ''),
    );
    user = JSON.stringify(filtered, null, 2);
  }

  const maxTokens   = config.maxTokens   ?? 1024;
  const temperature = config.temperature ?? 0;

  logger.log(`Prompt executor: llmConfigId=${config.llmConfigId ?? 'default'} maxTokens=${maxTokens}`);

  return ctx.callLlm(system, user, config.llmConfigId, maxTokens, temperature);
}

// ── RAG executor ────────────────────────────────────────────────────────────

/**
 * Main dispatcher: branches on mode='search' (default) or mode='index'.
 */
async function executeRag(
  config:    RagExecutorConfig,
  args:      Record<string, unknown>,
  ctx:       RagContext,
  userId?:   string,
  projectId?: string,
): Promise<string> {
  if (config.mode === 'index') {
    return executeRagIndex(config, args, ctx, userId, projectId);
  }
  return executeRagSearch(config, args, ctx, userId, projectId);
}

/**
 * Merges the results of multiple per-scope queries: dedup by id, sort by
 * descending score and cut to the limit. Solves the recall problem (each scope
 * contributes its own top-K instead of filtering a single truncated list).
 */
function mergeSearchHits(groups: SearchHit[][], limit: number): SearchHit[] {
  const byId = new Map<string, SearchHit>();
  for (const g of groups) {
    for (const h of g) {
      const prev = byId.get(h.id);
      if (!prev || h.score > prev.score) byId.set(h.id, h);
    }
  }
  return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * Semantic search on a collection specified in the config.
 *
 * @param config  - RagExecutorConfig with collection, limit and filterByUser
 * @param args    - Parameters provided by the LLM (query, optional limit)
 * @param ctx     - embed/search functions injected by the service
 * @param userId  - current user ID (used if filterByUser=true)
 */
async function executeRagSearch(
  config:    RagExecutorConfig,
  args:      Record<string, unknown>,
  ctx:       RagContext,
  userId?:   string,
  projectId?: string,
): Promise<string> {
  const query  = String(args['query'] ?? '').trim();
  const limit  = Number(args['limit'] ?? config.limit ?? 5);

  if (!query) return 'Error: "query" parameter missing or empty.';

  const t0 = Date.now();
  const scopeMode = config.searchScope ?? 'auto';
  logger.log(`RAG search: query="${query}" collection="${config.collection}" limit=${limit} scope=${scopeMode}`);

  try {
    const vector = await ctx.embed(query);
    const col = config.collection;

    // NATIVE filter on the vector DB. "auto" visibility is an OR across different scopes:
    // since the adapters support only AND-equality, one query per scope is executed
    // and the union is taken (merge + dedup + re-rank + cut to the limit).
    let hits: SearchHit[];
    if (scopeMode === 'all') {
      hits = await ctx.search(col, vector, limit);
    } else if (scopeMode === 'universal') {
      hits = await ctx.search(col, vector, limit, { scope: 'universal' });
    } else {
      // auto: universal + the user's personal + documents of the current project
      const queries: Promise<SearchHit[]>[] = [
        ctx.search(col, vector, limit, { scope: 'universal' }),
      ];
      if (userId)    queries.push(ctx.search(col, vector, limit, { scope: 'personal', userId }));
      if (projectId) queries.push(ctx.search(col, vector, limit, { scope: 'project', projectId }));
      const groups = await Promise.all(queries);
      hits = mergeSearchHits(groups, limit);
    }

    logger.log(`RAG search: ${hits.length} results in ${Date.now() - t0}ms`);

    if (!hits.length) return 'No documents found for this search.';

    return hits
      .map((r, i) => {
        const p = r.payload;
        return (
          `[${i + 1}] Source: ${p?.source ?? 'N/A'}\n` +
          `Content: ${p?.text ?? p?.content ?? 'N/A'}\n` +
          `Score: ${r.score.toFixed(3)}`
        );
      })
      .join('\n\n---\n\n');
  } catch (err: any) {
    logger.error(`RAG search error (${Date.now() - t0}ms): ${err.message}`);
    return `Document search error: ${err.message}`;
  }
}

/**
 * Indexes content into the configured collection.
 *
 * Supports two mutually exclusive modes, chosen by the config:
 *
 *   fileIdParam (recommended for already-uploaded files):
 *     The LLM passes the fileId → the tool uses EmbedService.ingestFile() which
 *     extracts the text natively (pdf-parse, mammoth, OCR, XLSX). Much more reliable
 *     than LLM transcription, especially for PDFs and structured documents.
 *
 *   textParam (default, for text generated or known to the LLM):
 *     The LLM passes the text directly → chunking + embedding + manual upsert.
 *
 * @param config  - RagExecutorConfig with collection, fileIdParam/textParam, metadataParams
 * @param args    - Parameters provided by the LLM
 * @param ctx     - ingestFile/embedDoc/upsert/ensureCollection/chunkText functions
 * @param userId  - current user ID (used by ingestFile to find the file + payload)
 */
async function executeRagIndex(
  config:    RagExecutorConfig,
  args:      Record<string, unknown>,
  ctx:       RagContext,
  userId?:   string,
  projectId?: string,
): Promise<string> {
  const t0 = Date.now();

  // Scope of the indexed documents: explicit override on the tool, otherwise
  // derived from the context (the chat's project if present, otherwise personal).
  const scope: DocScope = config.indexScope ?? (projectId ? 'project' : 'personal');
  const scopeProjectId = scope === 'project' ? (projectId ?? null) : null;

  // ── fileId mode: uses EmbedService.ingestFile() ─────────────────────────────
  if (config.fileIdParam) {
    const fileId = String(args[config.fileIdParam] ?? '').trim();

    if (!fileId) return `Error: "${config.fileIdParam}" (fileId) parameter missing or empty.`;
    if (!userId) return 'Error: userId not available, unable to retrieve the file.';

    try {
      const result = await ctx.ingestFile(fileId, userId, config.collection, { scope, projectId: scopeProjectId });
      logger.log(`RAG index: ${result.chunks} chunk in ${Date.now() - t0}ms → collection "${result.collection}"`);
      return `File indexed: ${result.chunks} chunks inserted into the collection "${result.collection}".`;
    } catch (err: any) {
      logger.error(`RAG index fileId error: ${err.message}`);
      return `File indexing error: ${err.message}`;
    }
  }

  // ── Text mode: chunking + manual embedding ──────────────────────────────────
  const textParamName = config.textParam ?? 'text';
  const text          = String(args[textParamName] ?? '').trim();

  if (!text) return `Error: "${textParamName}" parameter missing or empty.`;

  // Builds the base payload with the metadata provided by the LLM
  const basePayload: Record<string, unknown> = {};
  for (const param of (config.metadataParams ?? [])) {
    if (args[param] !== undefined) basePayload[param] = args[param];
  }
  if (userId) basePayload.userId = userId;
  basePayload.scope = scope;
  basePayload.projectId = scopeProjectId;
  if (!basePayload.source) basePayload.source = 'custom-tool';
  basePayload.createdAt = new Date().toISOString();

  try {
    await ctx.ensureCollection(config.collection);

    const chunks  = await ctx.chunkText(text);
    const vectors = await Promise.all(chunks.map((chunk) => ctx.embedDoc(chunk)));

    const points: VectorPoint[] = chunks.map((chunk, i) => ({
      id:      uuidv4(),
      vector:  vectors[i],
      payload: { ...basePayload, text: chunk },
    }));

    await ctx.upsert(config.collection, points);

    const elapsed = Date.now() - t0;
    logger.log(`RAG index (text): ${chunks.length} chunk in ${elapsed}ms → "${config.collection}"`);
    return `Text indexed: ${chunks.length} chunks inserted into the collection "${config.collection}".`;
  } catch (err: any) {
    logger.error(`RAG index (text) error (${Date.now() - t0}ms): ${err.message}`);
    return `Indexing error: ${err.message}`;
  }
}

// ── Main factory ────────────────────────────────────────────────────────────

/**
 * Converts a CustomTool record (from the DB) into a LangChain DynamicStructuredTool.
 *
 * @param def           - CustomTool record loaded from the DB (without secrets.encryptedValue)
 * @param secrets       - keyName → decrypted value map (produced by CustomToolsService)
 * @param dataSource    - resolved DataSource (only for the 'sql' executor)
 * @param ragContext    - embed/search/index functions injected by the service (only for 'rag')
 * @param userId        - current user ID (used by 'rag' with filterByUser=true / index)
 * @param promptContext - callLlm function for LLM sub-calls (only for 'prompt')
 */
export function buildDynamicTool(
  def:            CustomTool,
  secrets:        Record<string, string>,
  dataSource:     ResolvedDataSource | undefined = undefined,
  ragContext:     RagContext | undefined = undefined,
  userId:         string | undefined = undefined,
  promptContext:  PromptContext | undefined = undefined,
  projectId:      string | undefined = undefined,
  /**
   * If true, execution errors are RE-THROWN instead of being returned as a
   * string. Default false = ReAct behavior (the tool never throws toward the
   * agent's loop). Used by the `/test` dry-run, which must be able to
   * distinguish a failed execution (e.g. SSRF block) from a successful one.
   */
  throwOnError:   boolean = false,
  /** Optional audit sink: records a `tool.execute` event (ok/error) per invocation. */
  audit?:         Pick<AuditService, 'record'>,
): DynamicStructuredTool {
  /**
   * Zod schema for RAG tools — differentiated by mode:
   *
   *   search (default): adds `query` (required) and `limit` (optional)
   *   index:            adds the text parameter (config.textParam ?? 'text')
   *
   * In both cases the user-defined custom parameters (def.parameters) are
   * included as the base and the extensions are added on top.
   */
  let schema: ReturnType<typeof buildZodSchema>;

  if (def.executorType === 'rag') {
    const ragCfg = def.executorConfig as RagExecutorConfig;
    const base   = buildZodSchema(def.parameters);

    if (ragCfg?.mode === 'index') {
      if (ragCfg.fileIdParam) {
        // fileId mode: the LLM passes the ID of the file already uploaded to the system
        schema = base.extend({
          [ragCfg.fileIdParam]: z.string()
            .describe('ID of the file to index (visible in the chat as "id: xxx")'),
        });
      } else {
        // Text mode: the LLM passes the text content directly
        const textParamName = ragCfg.textParam ?? 'text';
        schema = base.extend({
          [textParamName]: z.string()
            .describe('Text to index into the configured collection'),
        });
      }
    } else {
      // search mode (default — backward compatible)
      schema = base.extend({
        query: z.string()
          .describe('Text to search for in the documents of the collection'),
        limit: z.number()
          .optional()
          .default(ragCfg?.limit ?? 5)
          .describe('Maximum number of results (default 5)'),
      });
    }
  } else if (def.executorType === 'sql') {
    const sqlCfg = def.executorConfig as SqlExecutorConfig;
    let s = buildZodSchema(def.parameters);

    // Confirmation for destructive operations (E1).
    if (sqlCfg?.confirmDestructive) {
      s = s.extend({
        confirm: z.boolean().optional()
          .describe('Set to true to confirm a destructive operation (UPDATE/DELETE/DDL).'),
      });
    }

    // describe_tables — step 2 of the compact on-demand flow: the model, after having
    // seen the table list (step 1), asks for the columns of the tables it needs.
    // Free-query in compact mode, both with a manifest and live (no manifest).
    const compactOnDemand =
      !!sqlCfg?.queryParam &&
      (sqlCfg.schemaMode ?? 'compact') === 'compact';
    if (compactOnDemand) {
      s = s.extend({
        describe_tables: z.array(z.string()).optional()
          .describe(
            'List of tables to get the columns for (types, comments, foreign keys) ' +
            'BEFORE writing the query. E.g.: ["cliente","progettohead"]. Use it after seeing the table list.',
          ),
      });
    }

    schema = s;
  } else if (def.executorType === 'mongo') {
    const mCfg = def.executorConfig as MongoExecutorConfig;
    let s = buildZodSchema(def.parameters);

    if (mCfg?.confirmDestructive) {
      s = s.extend({
        confirm: z.boolean().optional()
          .describe('Set to true to confirm a write operation (insert/update/delete).'),
      });
    }
    // describe_collections — step 2 of the compact on-demand flow (free-query).
    const compactOnDemand = !!mCfg?.queryParam && (mCfg.schemaMode ?? 'compact') === 'compact';
    if (compactOnDemand) {
      s = s.extend({
        describe_collections: z.array(z.string()).optional()
          .describe(
            'List of collections to get the fields for (path, types, frequency) BEFORE writing ' +
            'the query. E.g.: ["ordini","clienti"]. Use it after seeing the collection list.',
          ),
      });
    }
    schema = s;
  } else if (def.executorType === 'redis') {
    const rCfg = def.executorConfig as RedisExecutorConfig;
    let s = buildZodSchema(def.parameters);
    if (rCfg?.allowWrite && rCfg?.confirmDestructive) {
      s = s.extend({
        confirm: z.boolean().optional()
          .describe('Set to true to confirm a write command (SET/DEL/HSET/…).'),
      });
    }
    schema = s;
  } else {
    schema = buildZodSchema(def.parameters);
  }

  return new DynamicStructuredTool<any>({
    name:        def.name,
    description: def.description,
    schema,

    func: async (args: Record<string, unknown>) => {
      logger.log(`tool_custom "${def.name}": args=${JSON.stringify(args)}`);

      const recordExec = (outcome: 'ok' | 'error', error?: string) =>
        audit?.record({
          actorId: userId, action: 'tool.execute', resource: def.name, outcome,
          ctx: { toolId: (def as any).id, executorType: def.executorType, ...(error ? { error: error.slice(0, 200) } : {}) },
        });

      try {
        const result = await (async (): Promise<string> => {
          switch (def.executorType as ExecutorType) {
            case 'http':
              return await executeHttp(
                def.executorConfig as HttpExecutorConfig,
                args,
                secrets,
              );
            case 'sql':
              return await executeSql(
                def.executorConfig as SqlExecutorConfig,
                args,
                secrets,
                dataSource,
              );
            case 'prompt':
              if (!promptContext) return 'Error: Prompt context not available (callLlm not injected).';
              return await executePrompt(
                def.executorConfig as PromptExecutorConfig,
                args,
                secrets,
                promptContext,
              );
            case 'rag':
              if (!ragContext) return 'Error: RAG context not available (embed/search not injected).';
              return await executeRag(
                def.executorConfig as RagExecutorConfig,
                args,
                ragContext,
                userId,
                projectId,
              );
            case 'mongo':
              return await executeMongo(
                def.executorConfig as MongoExecutorConfig,
                args,
                dataSource,
              );
            case 'redis':
              return await executeRedis(
                def.executorConfig as RedisExecutorConfig,
                args,
                dataSource,
              );
            default:
              return `Executor type "${def.executorType}" not recognized`;
          }
        })();
        await recordExec('ok');
        return result;
      } catch (err: any) {
        // Tools must never throw exceptions toward the ReAct loop —
        // we return the error as a string so the LLM can handle it.
        // Exception: the `/test` dry-run (throwOnError) wants the real failure.
        logger.error(`tool_custom "${def.name}" error: ${err.message}`, err.stack);
        await recordExec('error', err?.message);
        if (throwOnError) throw err;
        return `Error executing the tool: ${err.message}`;
      }
    },
  });
}
