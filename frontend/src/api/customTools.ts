import api from './client';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ToolParameter {
  name: string;
  type: 'string' | 'number' | 'boolean';
  description: string;
  required: boolean;
  default?: string | number | boolean;
}

export interface HttpExecutorConfig {
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  queryParams?: Record<string, string>;
  bodyTemplate?: Record<string, unknown> | string;
  responsePath?: string;
  maxResponseChars?: number;
  timeoutMs?: number;
}

export interface SqlExecutorConfig {
  /** ID of the data source configured in Data Sources */
  dataSourceId: string;
  /** Mode A: fixed SELECT query with named params :paramName */
  queryTemplate?: string;
  /** Mode B: name of the optional parameter that the LLM fills with the SELECT */
  queryParam?: string;
  /** Schema mode (automatic source: curated manifest or live): 'compact' (default) | 'full' */
  schemaMode?: 'compact' | 'full';
  /** Max rows (default 50, hard-cap 500) */
  maxRows?: number;
  /** Column projection in the response */
  columns?: string[];
  /** Query timeout in ms (default 10 000) */
  timeoutMs?: number;
  /** Allowed operations (E1). Default ['select']; writes are opt-in. */
  operations?: ('select' | 'insert' | 'update' | 'delete' | 'ddl')[];
  /** Reject UPDATE/DELETE without WHERE */
  requireWhere?: boolean;
  /** Destructive operations require confirm=true */
  confirmDestructive?: boolean;
}

export type MongoOp =
  | 'find' | 'aggregate' | 'countDocuments' | 'distinct'
  | 'insertOne' | 'insertMany' | 'updateOne' | 'updateMany' | 'deleteOne' | 'deleteMany';

export interface MongoExecutorConfig {
  /** ID of the data source (mongodb engine) */
  dataSourceId: string;
  /** Allowed operations. Default read-only (find/aggregate/countDocuments/distinct). */
  operations?: MongoOp[];
  /** Writes require confirm=true */
  confirmDestructive?: boolean;
  /** Mode A: fixed collection (template) */
  collection?: string;
  /** Template operation (default 'find') */
  operation?: MongoOp;
  /** JSON filter with :param (Mode A) */
  filterTemplate?: string;
  /** JSON pipeline with :param (Mode A, aggregate) */
  pipelineTemplate?: string;
  /** Mode B: name of the parameter that the LLM fills with the JSON spec */
  queryParam?: string;
  /** Injected schema mode: 'compact' (default) | 'full' */
  schemaMode?: 'compact' | 'full';
  /** Max documents (default 50, hard-cap 500) */
  maxRows?: number;
  /** Field projection (top-level) in the response */
  projection?: string[];
  /** Operation timeout in ms (default 10 000) */
  timeoutMs?: number;
}

export interface RedisExecutorConfig {
  /** ID of the data source (redis engine) */
  dataSourceId: string;
  /** Enable write commands (default false = read-only) */
  allowWrite?: boolean;
  /** Writes require confirm=true */
  confirmDestructive?: boolean;
  /** Mode A: fixed command (template) */
  command?: string;
  /** JSON arguments (array) with :param (Mode A) */
  argsTemplate?: string;
  /** Mode B: name of the parameter that the LLM fills with { command, args } */
  queryParam?: string;
  /** 'compact' (default) | 'full' */
  schemaMode?: 'compact' | 'full';
  /** Cap elements if the reply is an array (default 100, hard-cap 1000) */
  maxRows?: number;
  /** Command timeout in ms */
  timeoutMs?: number;
}

export interface RagExecutorConfig {
  /** Mode: 'search' (semantic search) | 'index' (indexing) */
  mode?: 'search' | 'index';
  /** Name of the Qdrant collection */
  collection: string;
  /** Maximum number of results (default 5) — mode=search only */
  limit?: number;
  /**
   * Search filter — mode=search only. Default 'auto' = dynamic visibility
   * (universal + the user's personal + documents of the current project).
   * 'universal' = company base only · 'all' = the whole collection (cross-project).
   */
  searchScope?: 'auto' | 'universal' | 'all';
  /**
   * Scope assigned to indexed documents — mode=index only. If omitted,
   * derived from context (the chat's project if present, otherwise personal).
   */
  indexScope?: 'universal' | 'project' | 'personal';
  /** Name of the parameter that will contain the fileId to index — mode=index only */
  fileIdParam?: string;
  /** Name of the parameter that will contain the text to index — mode=index only */
  textParam?: string;
  /** Names of the additional parameters to save as metadata — mode=index only */
  metadataParams?: string[];
}

export interface PromptExecutorConfig {
  /** System prompt of the sub-agent. Supports {{param}} / {{secret.KEY}} / {{env.VAR}} */
  systemPrompt: string;
  /** User message template. If omitted: JSON.stringify(args) */
  userPromptTemplate?: string;
  /** ID of the LlmConfig to use. If omitted: uses the default config. */
  llmConfigId?: string;
  /** Max tokens in the response (default: 1024) */
  maxTokens?: number;
  /** Temperature 0–1 (default: 0) */
  temperature?: number;
}

export interface CustomTool {
  id: string;
  name: string;
  description: string;
  parameters: ToolParameter[];
  executorType: 'http' | 'sql' | 'prompt' | 'rag' | 'mongo' | 'redis';
  executorConfig: HttpExecutorConfig | SqlExecutorConfig | RagExecutorConfig | PromptExecutorConfig | MongoExecutorConfig | RedisExecutorConfig | Record<string, unknown>;
  enabled: boolean;
  /** If false, the tool does not enter the chat's flat context (usable only via agent). */
  loadOnFirst: boolean;
  userId: string;
  /** Visibility: personal = creator; team = team members; org = everyone */
  scope: 'personal' | 'team' | 'org';
  teamId: string | null;
  createdAt: string;
  updatedAt: string;
  secrets?: Array<{ id: string; toolId: string; keyName: string }>;
}

export interface TestResult {
  success: boolean;
  tool_name: string;
  executor_type: string;
  args_used: Record<string, unknown>;
  result?: string;
  error?: string;
  error_type?: 'validation' | 'execution';
  elapsed_ms: number;
}

export interface CreateToolPayload {
  name: string;
  description: string;
  parameters: ToolParameter[];
  executorType: 'http' | 'sql' | 'prompt' | 'rag' | 'mongo' | 'redis';
  executorConfig: Record<string, unknown>;
  scope?: 'personal' | 'team' | 'org';
  teamId?: string | null;
  loadOnFirst?: boolean;
  secrets?: Record<string, string>;
}

// ── API client ────────────────────────────────────────────────────────────────

export const customToolsApi = {
  list: () =>
    api.get<CustomTool[]>('/custom-tools').then((r) => r.data),

  get: (id: string) =>
    api.get<CustomTool>(`/custom-tools/${id}`).then((r) => r.data),

  create: (payload: CreateToolPayload) =>
    api.post<CustomTool>('/custom-tools', payload).then((r) => r.data),

  update: (id: string, payload: Partial<CreateToolPayload> & { enabled?: boolean }) =>
    api.put<CustomTool>(`/custom-tools/${id}`, payload).then((r) => r.data),

  remove: (id: string) =>
    api.delete<{ message: string }>(`/custom-tools/${id}`).then((r) => r.data),

  toggle: (id: string) =>
    api.patch<CustomTool>(`/custom-tools/${id}/toggle`).then((r) => r.data),

  test: (id: string, args: Record<string, unknown>) =>
    api.post<TestResult>(`/custom-tools/${id}/test`, { args }).then((r) => r.data),

  getSecretKeys: (id: string) =>
    api.get<{ keys: string[] }>(`/custom-tools/${id}/secrets`).then((r) => r.data),

  upsertSecrets: (id: string, secrets: Record<string, string>) =>
    api.put(`/custom-tools/${id}/secrets`, { secrets }).then((r) => r.data),

  removeSecret: (id: string, key: string) =>
    api.delete(`/custom-tools/${id}/secrets/${key}`).then((r) => r.data),
};
