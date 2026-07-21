/**
 * @file ToolsPage.tsx
 *
 * "Tool" section in settings.
 *
 * Structure:
 *   ToolsSection          — tool list + "New" button
 *   ToolCard              — single tool card (toggle, edit, delete)
 *   ToolEditor            — inline create/edit form + test panel (replaces the list, back button)
 *   ├─ IdentitySection    — name, description, executor type
 *   ├─ HttpConfigSection  — url, method, headers, body, response path
 *   ├─ ParamsSection      — parameters (LLM schema)
 *   ├─ SecretsSection     — encrypted API keys
 *   └─ TestSection        — dry-run with custom args
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Wrench, Plus, Loader2, X, Play, CheckCircle, XCircle,
  Trash2, Globe, Lock, Eye, EyeOff, AlertCircle,
  ChevronDown, ChevronRight, Terminal,
  Users, ArrowLeft,
} from 'lucide-react';
import {
  customToolsApi,
  type CustomTool,
  type ToolParameter,
  type HttpExecutorConfig,
  type SqlExecutorConfig,
  type RagExecutorConfig,
  type PromptExecutorConfig,
  type MongoExecutorConfig,
  type RedisExecutorConfig,
  type TestResult,
} from '../api/customTools';
import { dataSourcesApi, engineFamily, type DataSource } from '../api/dataSources';
import { filesApi } from '../api/files';
import { llmConfigsApi, type LlmConfigDto } from '../api/llmConfigs';
import { useStore } from '../store/useStore';
import { ScopeSelector, ScopeBadge } from '../components/ScopeSelector';

// ── Constants ────────────────────────────────────────────────────────────────

const VALID_NAME = /^[a-z][a-z0-9_]{1,63}$/;
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
type HttpMethod = typeof HTTP_METHODS[number];

// ── Form-internal types ───────────────────────────────────────────────────────

interface KVPair { key: string; value: string }

interface ParamRow {
  name: string;
  type: 'string' | 'number' | 'boolean';
  description: string;
  required: boolean;
  default: string;
}

interface SecretRow {
  key: string;
  value: string;       // empty = do not modify
  existing: boolean;   // true = already saved on the server
  show: boolean;
}

interface FormState {
  name: string;
  description: string;
  executorType: 'http' | 'sql' | 'prompt' | 'rag' | 'mongo' | 'redis';
  scope: 'personal' | 'team' | 'org';
  teamId: string | null;
  loadOnFirst: boolean;
  // ── HTTP ────────────────────────────────────────────────────────────────────
  url: string;
  method: HttpMethod;
  headers: KVPair[];
  queryParams: KVPair[];
  bodyTemplate: string;
  responsePath: string;
  maxResponseChars: string;
  timeoutMs: string;
  // ── SQL ─────────────────────────────────────────────────────────────────────
  /** 'template' = fixed query with :param  |  'freequery' = LLM writes the SELECT */
  sqlMode: 'template' | 'freequery';
  /** Data source ID (DataSource entity) */
  sqlDataSourceId: string;
  sqlQueryTemplate: string;
  /** Name of the optional parameter the LLM fills with the SELECT (Mode B) */
  sqlQueryParam: string;
  /** Injected schema mode (automatic manifest/live source): compact vs full */
  sqlSchemaMode: 'compact' | 'full';
  sqlMaxRows: string;
  /** Column projection — CSV string, e.g. "name, email" */
  sqlColumns: string;
  sqlTimeoutMs: string;
  // ── SQL: write capabilities (E1) — select always implicit ─────────────────────
  sqlOpInsert: boolean;
  sqlOpUpdate: boolean;
  sqlOpDelete: boolean;
  sqlOpDdl: boolean;
  /** Reject UPDATE/DELETE without WHERE */
  sqlRequireWhere: boolean;
  /** Destructive operations require confirm=true */
  sqlConfirmDestructive: boolean;
  // ── Mongo ───────────────────────────────────────────────────────────────────
  /** 'template' = fixed collection+op with :param  |  'freequery' = LLM writes the JSON spec */
  mongoMode: 'template' | 'freequery';
  mongoDataSourceId: string;
  mongoCollection: string;
  mongoOperation: 'find' | 'aggregate';
  mongoFilterTemplate: string;
  mongoPipelineTemplate: string;
  mongoQueryParam: string;
  mongoSchemaMode: 'compact' | 'full';
  mongoMaxRows: string;
  mongoProjection: string;
  mongoTimeoutMs: string;
  /** Write capabilities (read always implicit) */
  mongoOpInsert: boolean;
  mongoOpUpdate: boolean;
  mongoOpDelete: boolean;
  mongoConfirmDestructive: boolean;
  // ── Redis ───────────────────────────────────────────────────────────────────
  /** 'template' = fixed command with :param args  |  'freequery' = LLM writes { command, args } */
  redisMode: 'template' | 'freequery';
  redisDataSourceId: string;
  redisCommand: string;
  redisArgsTemplate: string;
  redisQueryParam: string;
  redisSchemaMode: 'compact' | 'full';
  redisMaxRows: string;
  redisTimeoutMs: string;
  redisAllowWrite: boolean;
  redisConfirmDestructive: boolean;
  // ── RAG ─────────────────────────────────────────────────────────────────────
  /** Mode: search (default) or index */
  ragMode: 'search' | 'index';
  /** Qdrant collection name */
  ragCollection: string;
  /** Maximum number of results — search only */
  ragLimit: string;
  /** Filter by current user — search only */
  ragSearchScope: 'auto' | 'universal' | 'all';
  ragIndexScope: '' | 'universal' | 'project' | 'personal';
  /** fileId parameter name — index via fileIdParam only */
  ragFileIdParam: string;
  /** text parameter name — index via textParam only */
  ragTextParam: string;
  /** Additional metadata parameters — CSV — index only */
  ragMetadataParams: string;
  // ── Prompt ──────────────────────────────────────────────────────────────────
  /** System prompt of the LLM sub-agent */
  promptSystemPrompt: string;
  /** User message template — if empty: JSON.stringify(args) */
  promptUserTemplate: string;
  /** Claude model to use */
  promptModel: string;
  /** Max response tokens */
  promptMaxTokens: string;
  /** Temperature 0–1 */
  promptTemperature: string;
  // ── Common ──────────────────────────────────────────────────────────────────
  parameters: ParamRow[];
  secrets: SecretRow[];
}

// ── Form ↔ API conversion helpers ─────────────────────────────────────────────

function kvToRecord(pairs: KVPair[]): Record<string, string> {
  return Object.fromEntries(pairs.filter((p) => p.key.trim()).map((p) => [p.key.trim(), p.value]));
}

function recordToKv(obj?: Record<string, string>): KVPair[] {
  if (!obj || !Object.keys(obj).length) return [{ key: '', value: '' }];
  return Object.entries(obj).map(([key, value]) => ({ key, value }));
}

function toolToForm(tool: CustomTool): FormState {
  const base: FormState = {
    name:         tool.name,
    description:  tool.description,
    executorType: tool.executorType,
    scope:        tool.scope ?? 'personal',
    teamId:       tool.teamId ?? null,
    loadOnFirst:  tool.loadOnFirst ?? true,
    // HTTP defaults
    url: '', method: 'GET',
    headers: [{ key: '', value: '' }], queryParams: [{ key: '', value: '' }],
    bodyTemplate: '', responsePath: '', maxResponseChars: '', timeoutMs: '',
    // SQL defaults
    sqlMode: 'template', sqlDataSourceId: '', sqlQueryTemplate: '',
    sqlQueryParam: '', sqlSchemaMode: 'compact',
    sqlMaxRows: '', sqlColumns: '', sqlTimeoutMs: '',
    sqlOpInsert: false, sqlOpUpdate: false, sqlOpDelete: false, sqlOpDdl: false,
    sqlRequireWhere: false, sqlConfirmDestructive: false,
    // Mongo
    mongoMode: 'template', mongoDataSourceId: '', mongoCollection: '', mongoOperation: 'find',
    mongoFilterTemplate: '', mongoPipelineTemplate: '', mongoQueryParam: '',
    mongoSchemaMode: 'compact', mongoMaxRows: '', mongoProjection: '', mongoTimeoutMs: '',
    mongoOpInsert: false, mongoOpUpdate: false, mongoOpDelete: false, mongoConfirmDestructive: false,
    // Redis
    redisMode: 'template', redisDataSourceId: '', redisCommand: '', redisArgsTemplate: '',
    redisQueryParam: '', redisSchemaMode: 'compact', redisMaxRows: '', redisTimeoutMs: '',
    redisAllowWrite: false, redisConfirmDestructive: false,
    // RAG defaults
    ragMode: 'search', ragCollection: '', ragLimit: '', ragSearchScope: 'auto', ragIndexScope: '',
    ragFileIdParam: '', ragTextParam: '', ragMetadataParams: '',
    // Prompt defaults
    promptSystemPrompt: '', promptUserTemplate: '',
    promptModel: '', promptMaxTokens: '', promptTemperature: '',
    // Common
    parameters: tool.parameters.map((p) => ({
      name: p.name, type: p.type, description: p.description,
      required: p.required, default: p.default !== undefined ? String(p.default) : '',
    })),
    secrets: (tool.secrets ?? []).map((s) => ({
      key: s.keyName, value: '', existing: true, show: false,
    })),
  };

  if (tool.executorType === 'http') {
    const http = tool.executorConfig as HttpExecutorConfig;
    const body = http.bodyTemplate !== undefined
      ? (typeof http.bodyTemplate === 'string'
          ? http.bodyTemplate
          : JSON.stringify(http.bodyTemplate, null, 2))
      : '';
    return {
      ...base,
      url:              http.url ?? '',
      method:           (http.method ?? 'GET') as HttpMethod,
      headers:          recordToKv(http.headers),
      queryParams:      recordToKv(http.queryParams),
      bodyTemplate:     body,
      responsePath:     http.responsePath ?? '',
      maxResponseChars: http.maxResponseChars ? String(http.maxResponseChars) : '',
      timeoutMs:        http.timeoutMs ? String(http.timeoutMs) : '',
    };
  }

  if (tool.executorType === 'sql') {
    const sql = tool.executorConfig as SqlExecutorConfig;
    return {
      ...base,
      sqlMode:           sql.queryParam ? 'freequery' : 'template',
      sqlDataSourceId:   sql.dataSourceId ?? '',
      sqlQueryTemplate:  sql.queryTemplate ?? '',
      sqlQueryParam:     sql.queryParam ?? '',
      sqlSchemaMode:        sql.schemaMode ?? 'compact',
      sqlMaxRows:        sql.maxRows ? String(sql.maxRows) : '',
      sqlColumns:        (sql.columns ?? []).join(', '),
      sqlTimeoutMs:      sql.timeoutMs ? String(sql.timeoutMs) : '',
      sqlOpInsert:           (sql.operations ?? []).includes('insert'),
      sqlOpUpdate:           (sql.operations ?? []).includes('update'),
      sqlOpDelete:           (sql.operations ?? []).includes('delete'),
      sqlOpDdl:              (sql.operations ?? []).includes('ddl'),
      sqlRequireWhere:       sql.requireWhere ?? false,
      sqlConfirmDestructive: sql.confirmDestructive ?? false,
    };
  }

  if (tool.executorType === 'mongo') {
    const m = tool.executorConfig as MongoExecutorConfig;
    return {
      ...base,
      mongoMode:            m.queryParam ? 'freequery' : 'template',
      mongoDataSourceId:    m.dataSourceId ?? '',
      mongoCollection:      m.collection ?? '',
      mongoOperation:       (m.operation === 'aggregate' ? 'aggregate' : 'find'),
      mongoFilterTemplate:  m.filterTemplate ?? '',
      mongoPipelineTemplate: m.pipelineTemplate ?? '',
      mongoQueryParam:      m.queryParam ?? '',
      mongoSchemaMode:      m.schemaMode ?? 'compact',
      mongoMaxRows:         m.maxRows ? String(m.maxRows) : '',
      mongoProjection:      (m.projection ?? []).join(', '),
      mongoTimeoutMs:       m.timeoutMs ? String(m.timeoutMs) : '',
      mongoOpInsert:        (m.operations ?? []).some((o) => o.startsWith('insert')),
      mongoOpUpdate:        (m.operations ?? []).some((o) => o.startsWith('update')),
      mongoOpDelete:        (m.operations ?? []).some((o) => o.startsWith('delete')),
      mongoConfirmDestructive: m.confirmDestructive ?? false,
    };
  }

  if (tool.executorType === 'redis') {
    const r = tool.executorConfig as RedisExecutorConfig;
    return {
      ...base,
      redisMode:           r.queryParam ? 'freequery' : 'template',
      redisDataSourceId:   r.dataSourceId ?? '',
      redisCommand:        r.command ?? '',
      redisArgsTemplate:   r.argsTemplate ?? '',
      redisQueryParam:     r.queryParam ?? '',
      redisSchemaMode:     r.schemaMode ?? 'compact',
      redisMaxRows:        r.maxRows ? String(r.maxRows) : '',
      redisTimeoutMs:      r.timeoutMs ? String(r.timeoutMs) : '',
      redisAllowWrite:     r.allowWrite ?? false,
      redisConfirmDestructive: r.confirmDestructive ?? false,
    };
  }

  if (tool.executorType === 'rag') {
    const rag = tool.executorConfig as RagExecutorConfig;
    return {
      ...base,
      ragMode:          rag.mode ?? 'search',
      ragCollection:    rag.collection ?? '',
      ragLimit:         rag.limit ? String(rag.limit) : '',
      ragSearchScope:   rag.searchScope ?? 'auto',
      ragIndexScope:    rag.indexScope ?? '',
      ragFileIdParam:   rag.fileIdParam ?? '',
      ragTextParam:     rag.textParam ?? '',
      ragMetadataParams: (rag.metadataParams ?? []).join(', '),
    };
  }

  if (tool.executorType === 'prompt') {
    const p = tool.executorConfig as PromptExecutorConfig;
    return {
      ...base,
      promptSystemPrompt: p.systemPrompt ?? '',
      promptUserTemplate: p.userPromptTemplate ?? '',
      promptModel:        p.llmConfigId ?? '',
      promptMaxTokens:    p.maxTokens ? String(p.maxTokens) : '',
      promptTemperature:  p.temperature !== undefined ? String(p.temperature) : '',
    };
  }

  return base;
}

function emptyForm(): FormState {
  return {
    name: '', description: '', executorType: 'http', scope: 'personal', teamId: null,
    loadOnFirst: true,
    // HTTP
    url: '', method: 'GET',
    headers: [{ key: '', value: '' }], queryParams: [{ key: '', value: '' }],
    bodyTemplate: '', responsePath: '', maxResponseChars: '', timeoutMs: '',
    // SQL
    sqlMode: 'template', sqlDataSourceId: '', sqlQueryTemplate: '',
    sqlQueryParam: '', sqlSchemaMode: 'compact',
    sqlMaxRows: '', sqlColumns: '', sqlTimeoutMs: '',
    sqlOpInsert: false, sqlOpUpdate: false, sqlOpDelete: false, sqlOpDdl: false,
    sqlRequireWhere: false, sqlConfirmDestructive: false,
    // Mongo
    mongoMode: 'template', mongoDataSourceId: '', mongoCollection: '', mongoOperation: 'find',
    mongoFilterTemplate: '', mongoPipelineTemplate: '', mongoQueryParam: '',
    mongoSchemaMode: 'compact', mongoMaxRows: '', mongoProjection: '', mongoTimeoutMs: '',
    mongoOpInsert: false, mongoOpUpdate: false, mongoOpDelete: false, mongoConfirmDestructive: false,
    // Redis
    redisMode: 'template', redisDataSourceId: '', redisCommand: '', redisArgsTemplate: '',
    redisQueryParam: '', redisSchemaMode: 'compact', redisMaxRows: '', redisTimeoutMs: '',
    redisAllowWrite: false, redisConfirmDestructive: false,
    // RAG
    ragMode: 'search', ragCollection: '', ragLimit: '', ragSearchScope: 'auto', ragIndexScope: '',
    ragFileIdParam: '', ragTextParam: '', ragMetadataParams: '',
    // Prompt
    promptSystemPrompt: '', promptUserTemplate: '',
    promptModel: '', promptMaxTokens: '', promptTemperature: '',
    // Common
    parameters: [], secrets: [],
  };
}

function buildDefaultArgs(params: ParamRow[]): string {
  const obj: Record<string, unknown> = {};
  for (const p of params) {
    if (p.type === 'number')  obj[p.name] = p.default ? Number(p.default) : 0;
    else if (p.type === 'boolean') obj[p.name] = p.default === 'true';
    else obj[p.name] = p.default || '';
  }
  return JSON.stringify(obj, null, 2);
}

// ── Supporting UI components ──────────────────────────────────────────────────

function Label({ children }: { children: React.ReactNode }) {
  return <label className="block text-xs font-medium text-gray-400 mb-1">{children}</label>;
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 pt-2">
      <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">{children}</span>
      <div className="flex-1 h-px bg-gray-800" />
    </div>
  );
}

function Input({
  value, onChange, placeholder, className = '', type = 'text', disabled = false,
}: {
  value: string; onChange: (v: string) => void; placeholder?: string;
  className?: string; type?: string; disabled?: boolean;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      className={`w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200
        placeholder-gray-600 focus:outline-none focus:border-blue-500 disabled:opacity-50
        disabled:cursor-not-allowed transition-colors ${className}`}
    />
  );
}

function Textarea({
  value, onChange, placeholder, rows = 4, className = '', monospace = false,
}: {
  value: string; onChange: (v: string) => void; placeholder?: string;
  rows?: number; className?: string; monospace?: boolean;
}) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      className={`w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200
        placeholder-gray-600 focus:outline-none focus:border-blue-500 resize-y transition-colors
        ${monospace ? 'font-mono text-xs' : ''} ${className}`}
    />
  );
}

/** Key-value pair editor with add/remove */
function KVEditor({
  pairs, onChange, keyPlaceholder = 'key', valuePlaceholder = 'value',
}: {
  pairs: KVPair[];
  onChange: (pairs: KVPair[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}) {
  const update = (idx: number, field: 'key' | 'value', val: string) => {
    const next = pairs.map((p, i) => i === idx ? { ...p, [field]: val } : p);
    onChange(next);
  };
  const add    = () => onChange([...pairs, { key: '', value: '' }]);
  const remove = (idx: number) => onChange(pairs.filter((_, i) => i !== idx));

  return (
    <div className="space-y-1.5">
      {pairs.map((p, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <input
            value={p.key}
            onChange={(e) => update(i, 'key', e.target.value)}
            placeholder={keyPlaceholder}
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-gray-200
              placeholder-gray-600 focus:outline-none focus:border-blue-500 font-mono"
          />
          <input
            value={p.value}
            onChange={(e) => update(i, 'value', e.target.value)}
            placeholder={valuePlaceholder}
            className="flex-[2] bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-gray-200
              placeholder-gray-600 focus:outline-none focus:border-blue-500 font-mono"
          />
          <button
            onClick={() => remove(i)}
            className="p-1.5 text-gray-600 hover:text-red-400 rounded transition-colors"
          >
            <X size={13} />
          </button>
        </div>
      ))}
      <button
        onClick={add}
        className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 transition-colors"
      >
        <Plus size={12} /> Add
      </button>
    </div>
  );
}

// ── ToolCard ──────────────────────────────────────────────────────────────────

function ToolCard({
  tool,
  onEdit,
  isOwner,
}: {
  tool: CustomTool;
  onEdit: () => void;
  /** true if the tool belongs to the current user */
  isOwner: boolean;
}) {
  const { t } = useTranslation('tools');
  const qc = useQueryClient();

  const toggle = useMutation({
    mutationFn: () => customToolsApi.toggle(tool.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['custom-tools'] }),
  });

  const executorBadge = ({
    http:   { label: 'HTTP',   cls: 'bg-blue-900/50 text-blue-300'    },
    sql:    { label: 'SQL',    cls: 'bg-amber-900/50 text-amber-300'  },
    mongo:  { label: 'Mongo',  cls: 'bg-green-900/50 text-green-300'  },
    redis:  { label: 'Redis',  cls: 'bg-red-900/50 text-red-300'      },
    prompt: { label: 'Prompt', cls: 'bg-violet-900/50 text-violet-300'},
    rag:    { label: 'RAG',    cls: 'bg-teal-900/50 text-teal-300'   },
  } as Record<string, { label: string; cls: string }>)[tool.executorType] ?? { label: tool.executorType, cls: 'bg-gray-800 text-gray-400' };

  return (
    <div
      onClick={onEdit}
      className={`flex items-center gap-3 px-4 py-3.5 hover:bg-gray-800/30 transition-colors cursor-pointer
        ${!tool.enabled ? 'opacity-60' : ''}`}
    >
      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-mono font-medium text-gray-200">{tool.name}</span>
          <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${executorBadge.cls}`}>
            {executorBadge.label}
          </span>
          {tool.scope !== 'personal' && <ScopeBadge scope={tool.scope} />}
          {!tool.enabled && (
            <span className="text-xs text-gray-600">{t('card.disabledTag')}</span>
          )}
        </div>
        <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{tool.description}</p>
        {(tool.secrets?.length ?? 0) > 0 && (
          <div className="flex items-center gap-1 mt-1">
            <Lock size={10} className="text-gray-600" />
            <span className="text-xs text-gray-600">
              {t('card.secret', { count: tool.secrets!.length })}
            </span>
          </div>
        )}
      </div>

      {/* Enable toggle — right side, skills-style pill. Non-owners can't toggle. */}
      <button
        onClick={(e) => { e.stopPropagation(); if (isOwner) toggle.mutate(); }}
        disabled={toggle.isPending || !isOwner}
        title={!isOwner ? t('card.toggleNotOwner') : tool.enabled ? t('card.disable') : t('card.enable')}
        className={`relative flex items-center w-10 h-6 rounded-full border transition-colors duration-200
          disabled:opacity-50 focus:outline-none flex-shrink-0
          ${!isOwner ? 'cursor-not-allowed' : ''}
          ${tool.enabled ? 'bg-blue-600 border-blue-500' : 'bg-gray-700 border-gray-600'}`}
      >
        {toggle.isPending ? (
          <Loader2 size={12} className="absolute inset-0 m-auto animate-spin text-white" />
        ) : (
          <span
            className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200
              ${tool.enabled ? 'translate-x-4' : 'translate-x-0.5'}`}
          />
        )}
      </button>
    </div>
  );
}

// ── ToolEditor ────────────────────────────────────────────────────────────────

function ToolEditor({
  tool,
  isAdmin,
  onClose,
}: {
  tool: CustomTool | null;   // null = create new
  isAdmin: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation('tools');
  const qc = useQueryClient();
  const isEdit = !!tool?.id;

  const [form, setForm] = useState<FormState>(() =>
    tool ? toolToForm(tool) : emptyForm(),
  );

  // Data sources — loaded for the SQL and Mongo selectors
  const { data: dataSources = [] } = useQuery<DataSource[]>({
    queryKey: ['data-sources'],
    queryFn:  dataSourcesApi.list,
    enabled:  ['sql', 'mongo', 'redis'].includes(form.executorType),
  });
  // Each tool type only accepts sources from its own family.
  const sqlDataSources   = dataSources.filter((d) => engineFamily(d.engine) === 'relational');
  const mongoDataSources = dataSources.filter((d) => engineFamily(d.engine) === 'document');
  const redisDataSources = dataSources.filter((d) => engineFamily(d.engine) === 'keyvalue');

  // LLM configs — loaded for the Prompt executor selector
  const { data: llmConfigs = [] } = useQuery<LlmConfigDto[]>({
    queryKey: ['llm-configs'],
    queryFn:  llmConfigsApi.list,
    enabled:  form.executorType === 'prompt',
    staleTime: 60_000,
  });

  // Qdrant collections — loaded for the RAG selector
  const { data: qdrantCollections = [], isLoading: collectionsLoading } = useQuery<string[]>({
    queryKey: ['embed-collections'],
    queryFn:  filesApi.listCollections,
    enabled:  form.executorType === 'rag',
    staleTime: 30_000,
  });

  // Test state
  const [testArgs, setTestArgs]       = useState<string>(() =>
    tool ? buildDefaultArgs((tool.parameters ?? []).map((p) => ({
      name: p.name, type: p.type, description: p.description,
      required: p.required, default: p.default !== undefined ? String(p.default) : '',
    }))) : '{}',
  );
  const [testResult, setTestResult]   = useState<TestResult | null>(null);
  const [testLoading, setTestLoading] = useState(false);
  const [saveError, setSaveError]     = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  // ID of the just-created tool (to enable the test right after the first save)
  const [savedId, setSavedId]         = useState<string | null>(tool?.id ?? null);
  const testResultRef                 = useRef<HTMLDivElement>(null);

  // A new tool (tool === null) belongs to the current user; an existing one is
  // editable/deletable only by its owner.
  const currentUser = useStore((s) => s.user);
  const isOwner = !tool || tool.userId === currentUser?.id;

  // Collapsible sections
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({
    identity: false, http: false, sql: false, rag: false, prompt: false, params: false, secrets: false, test: false,
  });
  const toggleSection = (s: string) =>
    setCollapsed((prev) => ({ ...prev, [s]: !prev[s] }));

  // Form helpers
  const set = useCallback(<K extends keyof FormState>(key: K, val: FormState[K]) => {
    setForm((f) => ({ ...f, [key]: val }));
  }, []);

  const nameError = form.name && !VALID_NAME.test(form.name)
    ? 'snake_case, inizia con lettera minuscola, solo lettere/numeri/underscore'
    : '';

  // ── Builds the API payload from the form ────────────────────────────────────

  function buildHttpConfig(): Record<string, unknown> {
    let bodyTemplate: Record<string, unknown> | string | undefined;
    if (form.bodyTemplate.trim()) {
      try { bodyTemplate = JSON.parse(form.bodyTemplate); }
      catch { bodyTemplate = form.bodyTemplate; }
    }
    const cfg: Record<string, unknown> = { url: form.url, method: form.method };
    const headers = kvToRecord(form.headers);
    const qparams = kvToRecord(form.queryParams);
    if (Object.keys(headers).length)  cfg.headers        = headers;
    if (Object.keys(qparams).length)  cfg.queryParams    = qparams;
    if (bodyTemplate !== undefined)   cfg.bodyTemplate   = bodyTemplate;
    if (form.responsePath.trim())     cfg.responsePath   = form.responsePath.trim();
    if (form.maxResponseChars.trim()) cfg.maxResponseChars = Number(form.maxResponseChars);
    if (form.timeoutMs.trim())        cfg.timeoutMs      = Number(form.timeoutMs);
    return cfg;
  }

  function buildPromptConfig(): Record<string, unknown> {
    const cfg: Record<string, unknown> = {
      systemPrompt: form.promptSystemPrompt.trim(),
    };
    if (form.promptUserTemplate.trim()) cfg.userPromptTemplate = form.promptUserTemplate.trim();
    if (form.promptModel.trim())        cfg.llmConfigId        = form.promptModel.trim();
    if (form.promptMaxTokens.trim())    cfg.maxTokens          = Number(form.promptMaxTokens);
    if (form.promptTemperature.trim())  cfg.temperature        = Number(form.promptTemperature);
    return cfg;
  }

  function buildRagConfig(): Record<string, unknown> {
    const cfg: Record<string, unknown> = {
      mode:       form.ragMode,
      collection: form.ragCollection.trim(),
    };
    if (form.ragMode === 'search') {
      if (form.ragLimit.trim())          cfg.limit       = Number(form.ragLimit);
      if (form.ragSearchScope !== 'auto') cfg.searchScope = form.ragSearchScope;
    } else {
      // index mode
      if (form.ragIndexScope)            cfg.indexScope     = form.ragIndexScope;
      if (form.ragFileIdParam.trim())    cfg.fileIdParam    = form.ragFileIdParam.trim();
      if (form.ragTextParam.trim())      cfg.textParam      = form.ragTextParam.trim();
      const meta = form.ragMetadataParams.split(',').map((s) => s.trim()).filter(Boolean);
      if (meta.length)                   cfg.metadataParams = meta;
    }
    return cfg;
  }

  function buildSqlConfig(): Record<string, unknown> {
    const cfg: Record<string, unknown> = {
      dataSourceId: form.sqlDataSourceId,
    };
    if (form.sqlMode === 'template') {
      if (form.sqlQueryTemplate.trim()) cfg.queryTemplate = form.sqlQueryTemplate.trim();
    } else {
      if (form.sqlQueryParam.trim()) cfg.queryParam = form.sqlQueryParam.trim();
      cfg.schemaMode = form.sqlSchemaMode;
    }
    if (form.sqlMaxRows.trim()) cfg.maxRows = Number(form.sqlMaxRows);
    const responseCols = form.sqlColumns.split(',').map((s) => s.trim()).filter(Boolean);
    if (responseCols.length) cfg.columns = responseCols;
    if (form.sqlTimeoutMs.trim()) cfg.timeoutMs = Number(form.sqlTimeoutMs);
    // Write capabilities (E1): 'select' is always implicit; writes are opt-in.
    const writeOps = [
      form.sqlOpInsert && 'insert',
      form.sqlOpUpdate && 'update',
      form.sqlOpDelete && 'delete',
      form.sqlOpDdl    && 'ddl',
    ].filter(Boolean) as string[];
    if (writeOps.length) {
      cfg.operations = ['select', ...writeOps];
      if (form.sqlRequireWhere)       cfg.requireWhere       = true;
      if (form.sqlConfirmDestructive) cfg.confirmDestructive = true;
    }
    return cfg;
  }

  function buildMongoConfig(): Record<string, unknown> {
    const cfg: Record<string, unknown> = { dataSourceId: form.mongoDataSourceId };
    if (form.mongoMode === 'template') {
      if (form.mongoCollection.trim()) cfg.collection = form.mongoCollection.trim();
      cfg.operation = form.mongoOperation;
      if (form.mongoOperation === 'aggregate') {
        if (form.mongoPipelineTemplate.trim()) cfg.pipelineTemplate = form.mongoPipelineTemplate.trim();
      } else if (form.mongoFilterTemplate.trim()) {
        cfg.filterTemplate = form.mongoFilterTemplate.trim();
      }
    } else {
      if (form.mongoQueryParam.trim()) cfg.queryParam = form.mongoQueryParam.trim();
      cfg.schemaMode = form.mongoSchemaMode;
    }
    if (form.mongoMaxRows.trim()) cfg.maxRows = Number(form.mongoMaxRows);
    const proj = form.mongoProjection.split(',').map((s) => s.trim()).filter(Boolean);
    if (proj.length) cfg.projection = proj;
    if (form.mongoTimeoutMs.trim()) cfg.timeoutMs = Number(form.mongoTimeoutMs);
    // Read ops always implicit; writes are opt-in.
    const writeOps = [
      form.mongoOpInsert && 'insertOne',
      form.mongoOpUpdate && 'updateMany',
      form.mongoOpDelete && 'deleteMany',
    ].filter(Boolean) as string[];
    if (writeOps.length) {
      cfg.operations = ['find', 'aggregate', 'countDocuments', 'distinct', ...writeOps];
      if (form.mongoConfirmDestructive) cfg.confirmDestructive = true;
    }
    return cfg;
  }

  function buildRedisConfig(): Record<string, unknown> {
    const cfg: Record<string, unknown> = { dataSourceId: form.redisDataSourceId };
    if (form.redisMode === 'template') {
      if (form.redisCommand.trim())      cfg.command      = form.redisCommand.trim();
      if (form.redisArgsTemplate.trim()) cfg.argsTemplate = form.redisArgsTemplate.trim();
    } else {
      if (form.redisQueryParam.trim()) cfg.queryParam = form.redisQueryParam.trim();
      cfg.schemaMode = form.redisSchemaMode;
    }
    if (form.redisMaxRows.trim())   cfg.maxRows   = Number(form.redisMaxRows);
    if (form.redisTimeoutMs.trim()) cfg.timeoutMs = Number(form.redisTimeoutMs);
    if (form.redisAllowWrite) {
      cfg.allowWrite = true;
      if (form.redisConfirmDestructive) cfg.confirmDestructive = true;
    }
    return cfg;
  }

  function buildPayload() {
    const executorConfig =
      form.executorType === 'sql'    ? buildSqlConfig()    :
      form.executorType === 'mongo'  ? buildMongoConfig()  :
      form.executorType === 'redis'  ? buildRedisConfig()  :
      form.executorType === 'http'   ? buildHttpConfig()   :
      form.executorType === 'rag'    ? buildRagConfig()    :
      form.executorType === 'prompt' ? buildPromptConfig() : {};

    const parameters: ToolParameter[] = form.parameters.map((p) => ({
      name: p.name, type: p.type, description: p.description, required: p.required,
      ...(p.default.trim() ? {
        default: p.type === 'number'  ? Number(p.default)
               : p.type === 'boolean' ? p.default === 'true'
               : p.default,
      } : {}),
    }));

    // Secrets: include only those with a non-empty value
    const secrets: Record<string, string> = {};
    for (const s of form.secrets) {
      if (s.value.trim()) secrets[s.key] = s.value;
    }

    return {
      parameters,
      executorConfig,
      scope: form.scope,
      teamId: form.scope === 'team' ? form.teamId : null,
      loadOnFirst: form.loadOnFirst,
      secrets: Object.keys(secrets).length ? secrets : undefined,
    };
  }

  // ── Mutations ───────────────────────────────────────────────────────────────
  const createMut = useMutation({
    mutationFn: () => {
      const { parameters, executorConfig, scope, teamId, loadOnFirst, secrets } = buildPayload();
      return customToolsApi.create({
        name:         form.name,
        description:  form.description,
        executorType: form.executorType,
        executorConfig,
        parameters,
        scope,
        teamId,
        loadOnFirst,
        secrets,
      });
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ['custom-tools'] });
      setSavedId(saved.id);
      setSaveError('');
      // Update the form with the returned data (including existing secrets)
      setForm(toolToForm(saved));
    },
    onError: (err: any) => {
      setSaveError(err.response?.data?.message || err.message || 'Error during creation');
    },
  });

  const updateMut = useMutation({
    mutationFn: () => {
      const id = savedId!;
      const { parameters, executorConfig, scope, teamId, loadOnFirst, secrets } = buildPayload();
      return customToolsApi.update(id, {
        description:  form.description,
        executorType: form.executorType,
        executorConfig,
        parameters,
        scope,
        teamId,
        loadOnFirst,
        secrets,
      });
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ['custom-tools'] });
      setForm(toolToForm(saved));
      setSaveError('');
    },
    onError: (err: any) => {
      setSaveError(err.response?.data?.message || err.message || 'Error during update');
    },
  });

  const deleteMut = useMutation({
    mutationFn: () => customToolsApi.remove(savedId!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['custom-tools'] });
      onClose(); // back to the list
    },
    onError: (err: any) => {
      setSaveError(err.response?.data?.message || err.message || 'Error during deletion');
    },
  });

  const isSaving = createMut.isPending || updateMut.isPending;
  const hasSaved = !!savedId;

  function handleSave() {
    setSaveError('');
    if (hasSaved) updateMut.mutate();
    else createMut.mutate();
  }

  // ── Test ────────────────────────────────────────────────────────────────────
  async function handleTest() {
    if (!savedId) return;
    setTestLoading(true);
    setTestResult(null);
    try {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(testArgs); } catch { /* use {} */ }
      const result = await customToolsApi.test(savedId, args);
      setTestResult(result);
      setTimeout(() => testResultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
    } catch (err: any) {
      setTestResult({
        success: false,
        tool_name: form.name,
        executor_type: form.executorType,
        args_used: {},
        error: err.message,
        error_type: 'execution',
        elapsed_ms: 0,
      });
    } finally {
      setTestLoading(false);
    }
  }

  // ── Parameters helpers ───────────────────────────────────────────────────────
  const addParam = () => set('parameters', [
    ...form.parameters,
    { name: '', type: 'string', description: '', required: true, default: '' },
  ]);

  const updateParam = (idx: number, field: keyof ParamRow, val: string | boolean) =>
    set('parameters', form.parameters.map((p, i) => i === idx ? { ...p, [field]: val } : p));

  const removeParam = (idx: number) =>
    set('parameters', form.parameters.filter((_, i) => i !== idx));

  // ── Secrets helpers ──────────────────────────────────────────────────────────
  const addSecret = () => set('secrets', [
    ...form.secrets,
    { key: '', value: '', existing: false, show: false },
  ]);

  const updateSecret = (idx: number, field: keyof SecretRow, val: string | boolean) =>
    set('secrets', form.secrets.map((s, i) => i === idx ? { ...s, [field]: val } : s));

  const removeSecret = async (idx: number) => {
    const row = form.secrets[idx];
    // Remove immediately from the form's local state.
    set('secrets', form.secrets.filter((_, i) => i !== idx));
    // If it is an ALREADY saved secret, actually delete it on the backend: the tool
    // update only performs an upsert (it does not remove missing secrets), so without
    // this DELETE the secret would reappear on the next refresh.
    if (row?.existing && row.key && savedId) {
      try {
        await customToolsApi.removeSecret(savedId, row.key);
        qc.invalidateQueries({ queryKey: ['custom-tools'] });
      } catch (err: any) {
        setSaveError(err.response?.data?.message || err.message || 'Error while removing the secret');
      }
    }
  };

  // Auto-update testArgs when the parameters change (only if testArgs === '{}')
  useEffect(() => {
    if (testArgs === '{}' || testArgs === '') {
      setTestArgs(buildDefaultArgs(form.parameters));
    }
  }, [form.parameters]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Render ───────────────────────────────────────────────────────────────────

  const CollapsibleHeader = ({ section, label }: { section: string; label: string }) => (
    <button
      onClick={() => toggleSection(section)}
      className="w-full flex items-center gap-2 py-1 group"
    >
      {collapsed[section]
        ? <ChevronRight size={12} className="text-gray-600 group-hover:text-gray-400" />
        : <ChevronDown  size={12} className="text-gray-600 group-hover:text-gray-400" />
      }
      <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">{label}</span>
      <div className="flex-1 h-px bg-gray-800" />
    </button>
  );

  return (
    <div>
      {/* Header with back button — replaces the section content (Flows-style) */}
      <div className="flex items-center gap-3 mb-5">
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-white flex items-center gap-1 text-sm flex-shrink-0"
        >
          <ArrowLeft size={16} /> {t('title')}
        </button>
        <div className="flex items-center gap-2.5 min-w-0">
          <Wrench size={16} className="text-blue-400 flex-shrink-0" />
          <h2 className="text-sm font-semibold text-gray-100 truncate">
            {hasSaved ? t('form.titleEdit', { name: form.name }) : t('form.titleNew')}
          </h2>
          {hasSaved && (
            <span className="text-xs text-gray-600 font-mono flex-shrink-0">#{savedId!.slice(0, 8)}</span>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="space-y-4">

          {/* ── Identity ──────────────────────────────────────────────────── */}
          <CollapsibleHeader section="identity" label={t('form.section.identity')} />
          {!collapsed.identity && (
            <div className="space-y-3">
              <div>
                <Label>
                  {t('form.identity.nameLabel')}{' '}
                  <span className="text-gray-600 font-normal">{t('form.identity.nameHint')}</span>
                </Label>
                <Input
                  value={form.name}
                  onChange={(v) => set('name', v)}
                  placeholder={t('form.identity.namePlaceholder')}
                  disabled={isEdit || hasSaved}
                  className={nameError ? 'border-red-600' : ''}
                />
                {nameError && <p className="text-xs text-red-400 mt-1">{nameError}</p>}
              </div>

              <div>
                <Label>
                  {t('form.identity.descLabel')}{' '}
                  <span className="text-gray-600 font-normal">{t('form.identity.descHint')}</span>
                </Label>
                <Textarea
                  value={form.description}
                  onChange={(v) => set('description', v)}
                  placeholder={t('form.identity.descPlaceholder')}
                  rows={3}
                />
              </div>

              <div>
                <Label>{t('form.identity.executorType')}</Label>
                <div className="flex gap-2 flex-wrap">
                  {([
                    { id: 'http',   label: 'HTTP',   active: 'bg-blue-600 border-blue-500'    },
                    { id: 'sql',    label: 'SQL',    active: 'bg-amber-600 border-amber-500'  },
                    { id: 'mongo',  label: 'Mongo',  active: 'bg-green-600 border-green-500'  },
                    { id: 'redis',  label: 'Redis',  active: 'bg-red-600 border-red-500'      },
                    { id: 'rag',    label: 'RAG',    active: 'bg-teal-600 border-teal-500'    },
                    { id: 'prompt', label: 'Prompt', active: 'bg-violet-600 border-violet-500' },
                  ] as const).map(({ id, label, active }) => (
                    <button
                      key={id}
                      onClick={() => set('executorType', id)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors
                        ${form.executorType === id
                          ? `${active} text-white`
                          : 'border-gray-700 text-gray-400 hover:border-gray-600 hover:text-gray-300'
                        }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Scope: personal / team / org (org reserved for admins) */}
              <div>
                <Label>{t('common:scope.visibility')}</Label>
                <ScopeSelector
                  scope={form.scope}
                  teamId={form.teamId}
                  onScope={(s) => set('scope', s)}
                  onTeam={(id) => set('teamId', id)}
                  allowOrg={isAdmin}
                />
              </div>

              {/* loadOnFirst: if off, the tool does not enter the chat context */}
              <div>
                <Label>{t('form.identity.loadOnFirstLabel')}</Label>
                <label className="flex items-center gap-2 text-sm text-gray-300" title={t('form.identity.loadOnFirstTitle')}>
                  <input
                    type="checkbox"
                    checked={form.loadOnFirst}
                    onChange={(e) => set('loadOnFirst', e.target.checked)}
                  />
                  {t('form.identity.loadOnFirstText')} <span className="text-gray-500">{t('form.identity.loadOnFirstHint')}</span>
                </label>
              </div>
            </div>
          )}

          {/* ── HTTP Config ────────────────────────────────────────────────── */}
          {form.executorType === 'http' && (
            <>
              <CollapsibleHeader section="http" label={t('form.section.http')} />
              {!collapsed.http && (
                <div className="space-y-3">
                  <div className="flex gap-2">
                    <div className="flex-1">
                      <Label>URL</Label>
                      <Input
                        value={form.url}
                        onChange={(v) => set('url', v)}
                        placeholder="https://api.example.com/search"
                      />
                    </div>
                    <div className="w-28 flex-shrink-0">
                      <Label>{t('form.http.method')}</Label>
                      <select
                        value={form.method}
                        onChange={(e) => set('method', e.target.value as HttpMethod)}
                        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-2 text-sm
                          text-gray-200 focus:outline-none focus:border-blue-500"
                      >
                        {HTTP_METHODS.map((m) => <option key={m}>{m}</option>)}
                      </select>
                    </div>
                  </div>

                  <div>
                    <Label>
                      {t('form.http.headersLabel')}{' '}
                      <span className="text-gray-600 font-normal">
                        {t('form.http.headersHintPre')} <code className="text-blue-400">{'{{secret.KEY}}'}</code> {t('form.http.headersHintPost')}
                      </span>
                    </Label>
                    <KVEditor
                      pairs={form.headers}
                      onChange={(v) => set('headers', v)}
                      keyPlaceholder="Authorization"
                      valuePlaceholder="Bearer {{secret.API_KEY}}"
                    />
                  </div>

                  {form.method === 'GET' && (
                    <div>
                      <Label>
                        {t('form.http.queryLabel')}{' '}
                        <span className="text-gray-600 font-normal">
                          {t('form.http.queryHintPre')} <code className="text-blue-400">{'{{paramName}}'}</code> {t('form.http.queryHintPost')}
                        </span>
                      </Label>
                      <KVEditor
                        pairs={form.queryParams}
                        onChange={(v) => set('queryParams', v)}
                        keyPlaceholder="q"
                        valuePlaceholder="{{query}}"
                      />
                    </div>
                  )}

                  {form.method !== 'GET' && (
                    <div>
                      <Label>
                        {t('form.http.bodyLabel')}{' '}
                        <span className="text-gray-600 font-normal">
                          {t('form.http.bodyHintPre')} <code className="text-blue-400">{'{{param}}'}</code> {t('form.http.bodyHintMid')}{' '}
                          <code className="text-blue-400">{'{{secret.KEY}}'}</code>
                        </span>
                      </Label>
                      <Textarea
                        value={form.bodyTemplate}
                        onChange={(v) => set('bodyTemplate', v)}
                        placeholder={'{\n  "api_key": "{{secret.API_KEY}}",\n  "query": "{{query}}",\n  "max_results": {{maxResults}}\n}'}
                        rows={5}
                        monospace
                      />
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label>
                        {t('form.http.responsePathLabel')}{' '}
                        <span className="text-gray-600 font-normal">{t('form.http.responsePathHint')}</span>
                      </Label>
                      <Input
                        value={form.responsePath}
                        onChange={(v) => set('responsePath', v)}
                        placeholder={t('form.http.responsePathPlaceholder')}
                      />
                    </div>
                    <div>
                      <Label>{t('form.http.maxCharsLabel')}</Label>
                      <Input
                        value={form.maxResponseChars}
                        onChange={(v) => set('maxResponseChars', v)}
                        placeholder="3000"
                        type="number"
                      />
                    </div>
                  </div>
                </div>
              )}
            </>
          )}

          {/* ── SQL Config ────────────────────────────────────────────────── */}
          {form.executorType === 'sql' && (
            <>
              <CollapsibleHeader section="sql" label={t('form.section.sql')} />
              {!collapsed.sql && (
                <div className="space-y-4">

                  {/* Data Source */}
                  <div>
                    <Label>
                      {t('form.sql.dataSourceLabel')}{' '}
                      <span className="text-gray-600 font-normal">{t('form.sql.dataSourceHint')}</span>
                    </Label>
                    {sqlDataSources.length === 0 ? (
                      <div className="flex items-start gap-1.5 text-xs text-amber-400/80 bg-amber-950/30
                        border border-amber-900/50 rounded-lg px-2.5 py-2">
                        <AlertCircle size={12} className="mt-0.5 flex-shrink-0" />
                        <span>
                          {t('form.sql.noDataSourcePre')}{' '}
                          <strong>{t('form.sql.noDataSourceStrong')}</strong> {t('form.sql.noDataSourcePost')}
                        </span>
                      </div>
                    ) : (
                      <select
                        value={form.sqlDataSourceId}
                        onChange={(e) => set('sqlDataSourceId', e.target.value)}
                        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm
                          text-gray-200 focus:outline-none focus:border-amber-500 transition-colors"
                      >
                        <option value="">{t('form.sql.selectDataSource')}</option>
                        {sqlDataSources.map((ds) => (
                          <option key={ds.id} value={ds.id}>
                            {ds.name} · {ds.engine}{ds.scope !== 'personal' ? ` (${ds.scope})` : ''}
                          </option>
                        ))}
                      </select>
                    )}
                    {form.sqlDataSourceId && (() => {
                      const ds = sqlDataSources.find((d) => d.id === form.sqlDataSourceId);
                      return ds?.description ? (
                        <p className="text-xs text-gray-600 mt-1">{ds.description}</p>
                      ) : null;
                    })()}
                  </div>

                  {/* Mode selector */}
                  <div>
                    <Label>{t('form.sql.modeLabel')}</Label>
                    <div className="flex gap-2">
                      {([
                        { id: 'template',  label: 'Template',             desc: t('form.sql.modeTemplateDesc') },
                        { id: 'freequery', label: 'Free Query / Text-to-SQL', desc: t('form.sql.modeFreeDesc') },
                      ] as const).map(({ id, label, desc }) => (
                        <button
                          key={id}
                          onClick={() => set('sqlMode', id)}
                          className={`flex-1 text-left px-3 py-2.5 rounded-lg border text-xs transition-colors
                            ${form.sqlMode === id
                              ? 'bg-amber-900/40 border-amber-700 text-amber-200'
                              : 'border-gray-700 text-gray-500 hover:border-gray-600 hover:text-gray-400'
                            }`}
                        >
                          <div className="font-medium mb-0.5">{label}</div>
                          <div className="text-gray-600 leading-tight">{desc}</div>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Mode A: Template */}
                  {form.sqlMode === 'template' && (
                    <div>
                      <Label>
                        {t('form.sql.queryTemplateLabel')}{' '}
                        <span className="text-gray-600 font-normal">
                          {t('form.sql.queryTemplateHintPre')} <code className="text-amber-400">:paramName</code> {t('form.sql.queryTemplateHintPost')}
                        </span>
                      </Label>
                      <Textarea
                        value={form.sqlQueryTemplate}
                        onChange={(v) => set('sqlQueryTemplate', v)}
                        placeholder={'SELECT nome, email, regione\nFROM clienti\nWHERE regione = :regione\n  AND attivo = :attivo'}
                        rows={5}
                        monospace
                      />
                      <p className="text-xs text-gray-600 mt-1">
                        {t('form.sql.templateNote')}
                      </p>
                    </div>
                  )}

                  {/* Mode B: Free Query */}
                  {form.sqlMode === 'freequery' && (
                    <div className="space-y-3">
                      <div>
                        <Label>
                          {t('form.sql.queryParamLabel')}{' '}
                          <span className="text-gray-600 font-normal">{t('form.sql.queryParamHint')}</span>
                        </Label>
                        <Input
                          value={form.sqlQueryParam}
                          onChange={(v) => set('sqlQueryParam', v)}
                          placeholder="sql_query"
                        />
                        {form.sqlQueryParam && (
                          <div className="mt-1.5 flex items-start gap-1.5 text-xs text-amber-400/80 bg-amber-950/30
                            border border-amber-900/50 rounded-lg px-2.5 py-2">
                            <AlertCircle size={12} className="mt-0.5 flex-shrink-0" />
                            <span>
                              {t('form.sql.queryParamWarn', { param: form.sqlQueryParam })}
                            </span>
                          </div>
                        )}
                      </div>

                      {/* Injected schema mode — the source (curated manifest vs live) is automatic */}
                      <div className="bg-gray-900 rounded-lg px-3 py-3 space-y-2.5">
                        <p className="text-xs font-medium text-gray-500">{t('form.sql.schemaModeLabel')}</p>
                        <div className="flex gap-2">
                          {([
                            { id: 'compact', label: t('form.sql.schemaModeCompact'), desc: t('form.sql.schemaModeCompactDesc') },
                            { id: 'full',    label: t('form.sql.schemaModeFull'),    desc: t('form.sql.schemaModeFullDesc') },
                          ] as const).map(({ id, label, desc }) => (
                            <button
                              key={id}
                              type="button"
                              onClick={() => set('sqlSchemaMode', id)}
                              className={`flex-1 text-left px-3 py-2 rounded-lg border text-xs transition-colors
                                ${form.sqlSchemaMode === id
                                  ? 'bg-amber-900/40 border-amber-700 text-amber-200'
                                  : 'border-gray-700 text-gray-500 hover:border-gray-600 hover:text-gray-400'
                                }`}
                            >
                              <div className="font-medium mb-0.5">{label}</div>
                              <div className="text-gray-600 leading-tight">{desc}</div>
                            </button>
                          ))}
                        </div>

                        <p className="text-xs text-gray-600 pt-0.5">
                          {t('form.sql.schemaHintsNotePre')}{' '}
                          <strong className="text-gray-500">{t('form.sql.schemaHintsNoteStrong')}</strong> {t('form.sql.schemaHintsNotePost')}
                        </p>
                      </div>
                    </div>
                  )}

                  {/* Advanced options — always visible */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label>{t('form.sql.maxRowsLabel')} <span className="text-gray-600 font-normal">{t('form.sql.maxRowsHint')}</span></Label>
                      <Input
                        value={form.sqlMaxRows}
                        onChange={(v) => set('sqlMaxRows', v)}
                        placeholder="50"
                        type="number"
                      />
                    </div>
                    <div>
                      <Label>{t('form.sql.timeoutLabel')} <span className="text-gray-600 font-normal">{t('form.sql.timeoutHint')}</span></Label>
                      <Input
                        value={form.sqlTimeoutMs}
                        onChange={(v) => set('sqlTimeoutMs', v)}
                        placeholder="10000"
                        type="number"
                      />
                    </div>
                  </div>

                  {/* Allowed operations (E1) — select always implicit; writes opt-in */}
                  <div className="rounded-lg border border-amber-700/40 bg-amber-500/5 p-3 space-y-2">
                    <Label>
                      {t('form.sql.opsLabel')}{' '}
                      <span className="text-gray-600 font-normal">{t('form.sql.opsHint')}</span>
                    </Label>
                    <p className="text-xs text-gray-500">
                      <strong className="text-gray-400">{t('form.sql.opsNoteStrong')}</strong> {t('form.sql.opsNotePost')}
                    </p>
                    <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                      {([
                        ['sqlOpInsert', 'INSERT'],
                        ['sqlOpUpdate', 'UPDATE'],
                        ['sqlOpDelete', 'DELETE'],
                        ['sqlOpDdl',    'DDL (create/alter/drop)'],
                      ] as const).map(([field, label]) => (
                        <label key={field} className="inline-flex items-center gap-1.5 text-sm text-gray-300 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={form[field] as boolean}
                            onChange={(e) => set(field, e.target.checked)}
                          />
                          {label}
                        </label>
                      ))}
                    </div>
                    {(form.sqlOpInsert || form.sqlOpUpdate || form.sqlOpDelete || form.sqlOpDdl) && (
                      <div className="flex flex-wrap gap-x-4 gap-y-1.5 pt-1 border-t border-amber-700/30">
                        <label className="inline-flex items-center gap-1.5 text-sm text-gray-300 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={form.sqlRequireWhere}
                            onChange={(e) => set('sqlRequireWhere', e.target.checked)}
                          />
                          {t('form.sql.requireWhere')}
                        </label>
                        <label className="inline-flex items-center gap-1.5 text-sm text-gray-300 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={form.sqlConfirmDestructive}
                            onChange={(e) => set('sqlConfirmDestructive', e.target.checked)}
                          />
                          {t('form.sql.confirmDestructive')}
                        </label>
                      </div>
                    )}
                  </div>

                  <div>
                    <Label>
                      {t('form.sql.columnsLabel')}{' '}
                      <span className="text-gray-600 font-normal">{t('form.sql.columnsHint')}</span>
                    </Label>
                    <Input
                      value={form.sqlColumns}
                      onChange={(v) => set('sqlColumns', v)}
                      placeholder="nome, email, regione"
                    />
                  </div>

                </div>
              )}
            </>
          )}

          {/* ── Mongo Config ─────────────────────────────────────────────── */}
          {form.executorType === 'mongo' && (
            <>
              <CollapsibleHeader section="mongo" label={t('form.mongo.section')} />
              {!collapsed.mongo && (
                <div className="space-y-4">

                  {/* Data source (MongoDB only) */}
                  <div>
                    <Label>{t('form.mongo.dataSourceLabel')}</Label>
                    {mongoDataSources.length === 0 ? (
                      <div className="flex items-start gap-1.5 text-xs text-amber-400/80 bg-amber-950/30
                        border border-amber-900/50 rounded-lg px-2.5 py-2">
                        <AlertCircle size={12} className="mt-0.5 flex-shrink-0" />
                        <span>{t('form.mongo.noDataSource')}</span>
                      </div>
                    ) : (
                      <select
                        value={form.mongoDataSourceId}
                        onChange={(e) => set('mongoDataSourceId', e.target.value)}
                        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm
                          text-gray-200 focus:outline-none focus:border-green-500 transition-colors"
                      >
                        <option value="">{t('form.mongo.selectDataSource')}</option>
                        {mongoDataSources.map((ds) => (
                          <option key={ds.id} value={ds.id}>
                            {ds.name}{ds.scope !== 'personal' ? ` (${ds.scope})` : ''}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>

                  {/* Mode selector */}
                  <div>
                    <Label>{t('form.mongo.modeLabel')}</Label>
                    <div className="flex gap-2">
                      {([
                        { id: 'template',  label: 'Template',   desc: t('form.mongo.modeTemplateDesc') },
                        { id: 'freequery', label: 'Free Query', desc: t('form.mongo.modeFreeDesc') },
                      ] as const).map(({ id, label, desc }) => (
                        <button
                          key={id}
                          type="button"
                          onClick={() => set('mongoMode', id)}
                          className={`flex-1 text-left px-3 py-2.5 rounded-lg border text-xs transition-colors
                            ${form.mongoMode === id
                              ? 'bg-green-900/40 border-green-700 text-green-200'
                              : 'border-gray-700 text-gray-500 hover:border-gray-600 hover:text-gray-400'}`}
                        >
                          <div className="font-medium mb-0.5">{label}</div>
                          <div className="text-gray-600 leading-tight">{desc}</div>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Mode A: Template */}
                  {form.mongoMode === 'template' && (
                    <div className="space-y-3">
                      <div className="flex gap-2">
                        <div className="flex-1">
                          <Label>{t('form.mongo.collectionLabel')}</Label>
                          <Input value={form.mongoCollection} onChange={(v) => set('mongoCollection', v)} placeholder="ordini" />
                        </div>
                        <div className="w-40">
                          <Label>{t('form.mongo.operationLabel')}</Label>
                          <select
                            value={form.mongoOperation}
                            onChange={(e) => set('mongoOperation', e.target.value as 'find' | 'aggregate')}
                            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-green-500"
                          >
                            <option value="find">find</option>
                            <option value="aggregate">aggregate</option>
                          </select>
                        </div>
                      </div>
                      {form.mongoOperation === 'find' ? (
                        <div>
                          <Label>{t('form.mongo.filterLabel')}</Label>
                          <Textarea value={form.mongoFilterTemplate} onChange={(v) => set('mongoFilterTemplate', v)}
                            placeholder={'{ "status": :status }'} rows={3} monospace />
                        </div>
                      ) : (
                        <div>
                          <Label>{t('form.mongo.pipelineLabel')}</Label>
                          <Textarea value={form.mongoPipelineTemplate} onChange={(v) => set('mongoPipelineTemplate', v)}
                            placeholder={'[ { "$match": { "status": :status } }, { "$group": { "_id": "$city", "n": { "$sum": 1 } } } ]'} rows={4} monospace />
                        </div>
                      )}
                    </div>
                  )}

                  {/* Mode B: Free query */}
                  {form.mongoMode === 'freequery' && (
                    <div className="space-y-3">
                      <div>
                        <Label>
                          {t('form.mongo.queryParamLabel')}{' '}
                          <span className="text-gray-600 font-normal">{t('form.mongo.queryParamHint')}</span>
                        </Label>
                        <Input value={form.mongoQueryParam} onChange={(v) => set('mongoQueryParam', v)} placeholder="mongo_query" />
                      </div>
                      <div className="bg-gray-900 rounded-lg px-3 py-3 space-y-2.5">
                        <p className="text-xs font-medium text-gray-500">{t('form.mongo.schemaModeLabel')}</p>
                        <div className="flex gap-2">
                          {(['compact', 'full'] as const).map((id) => (
                            <button key={id} type="button" onClick={() => set('mongoSchemaMode', id)}
                              className={`flex-1 px-3 py-2 rounded-lg border text-xs transition-colors
                                ${form.mongoSchemaMode === id ? 'bg-green-900/40 border-green-700 text-green-200' : 'border-gray-700 text-gray-500 hover:border-gray-600'}`}>
                              {id === 'compact' ? t('form.sql.schemaModeCompact') : t('form.sql.schemaModeFull')}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Write capabilities */}
                  <div className="bg-gray-900 rounded-lg px-3 py-3 space-y-2">
                    <p className="text-xs font-medium text-gray-500">{t('form.mongo.opsLabel')} <span className="text-gray-600">{t('form.mongo.opsHint')}</span></p>
                    <div className="flex flex-wrap gap-3 text-xs text-gray-300">
                      <label className="flex items-center gap-1.5"><input type="checkbox" checked={form.mongoOpInsert} onChange={(e) => set('mongoOpInsert', e.target.checked)} /> insert</label>
                      <label className="flex items-center gap-1.5"><input type="checkbox" checked={form.mongoOpUpdate} onChange={(e) => set('mongoOpUpdate', e.target.checked)} /> update</label>
                      <label className="flex items-center gap-1.5"><input type="checkbox" checked={form.mongoOpDelete} onChange={(e) => set('mongoOpDelete', e.target.checked)} /> delete</label>
                    </div>
                    {(form.mongoOpInsert || form.mongoOpUpdate || form.mongoOpDelete) && (
                      <label className="flex items-center gap-1.5 text-xs text-gray-300">
                        <input type="checkbox" checked={form.mongoConfirmDestructive} onChange={(e) => set('mongoConfirmDestructive', e.target.checked)} />
                        {t('form.mongo.confirmDestructive')}
                      </label>
                    )}
                  </div>

                  {/* Limits */}
                  <div className="flex gap-2">
                    <div className="w-32">
                      <Label>{t('form.mongo.maxRows')}</Label>
                      <Input value={form.mongoMaxRows} onChange={(v) => set('mongoMaxRows', v)} placeholder="50" />
                    </div>
                    <div className="flex-1">
                      <Label>{t('form.mongo.projection')}</Label>
                      <Input value={form.mongoProjection} onChange={(v) => set('mongoProjection', v)} placeholder="nome, totale" />
                    </div>
                  </div>

                </div>
              )}
            </>
          )}

          {/* ── Redis Config ─────────────────────────────────────────────── */}
          {form.executorType === 'redis' && (
            <>
              <CollapsibleHeader section="redis" label={t('form.redis.section')} />
              {!collapsed.redis && (
                <div className="space-y-4">

                  {/* Data source (Redis only) */}
                  <div>
                    <Label>{t('form.redis.dataSourceLabel')}</Label>
                    {redisDataSources.length === 0 ? (
                      <div className="flex items-start gap-1.5 text-xs text-amber-400/80 bg-amber-950/30
                        border border-amber-900/50 rounded-lg px-2.5 py-2">
                        <AlertCircle size={12} className="mt-0.5 flex-shrink-0" />
                        <span>{t('form.redis.noDataSource')}</span>
                      </div>
                    ) : (
                      <select
                        value={form.redisDataSourceId}
                        onChange={(e) => set('redisDataSourceId', e.target.value)}
                        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm
                          text-gray-200 focus:outline-none focus:border-red-500 transition-colors"
                      >
                        <option value="">{t('form.redis.selectDataSource')}</option>
                        {redisDataSources.map((ds) => (
                          <option key={ds.id} value={ds.id}>
                            {ds.name}{ds.scope !== 'personal' ? ` (${ds.scope})` : ''}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>

                  {/* Mode selector */}
                  <div>
                    <Label>{t('form.redis.modeLabel')}</Label>
                    <div className="flex gap-2">
                      {([
                        { id: 'template',  label: 'Template',     desc: t('form.redis.modeTemplateDesc') },
                        { id: 'freequery', label: 'Free Command', desc: t('form.redis.modeFreeDesc') },
                      ] as const).map(({ id, label, desc }) => (
                        <button
                          key={id}
                          type="button"
                          onClick={() => set('redisMode', id)}
                          className={`flex-1 text-left px-3 py-2.5 rounded-lg border text-xs transition-colors
                            ${form.redisMode === id
                              ? 'bg-red-900/40 border-red-700 text-red-200'
                              : 'border-gray-700 text-gray-500 hover:border-gray-600 hover:text-gray-400'}`}
                        >
                          <div className="font-medium mb-0.5">{label}</div>
                          <div className="text-gray-600 leading-tight">{desc}</div>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Mode A: Template */}
                  {form.redisMode === 'template' && (
                    <div className="space-y-3">
                      <div>
                        <Label>{t('form.redis.commandLabel')}</Label>
                        <Input value={form.redisCommand} onChange={(v) => set('redisCommand', v)} placeholder="HGETALL" />
                      </div>
                      <div>
                        <Label>{t('form.redis.argsLabel')}</Label>
                        <Textarea value={form.redisArgsTemplate} onChange={(v) => set('redisArgsTemplate', v)}
                          placeholder={'[ "user::id" ]'} rows={2} monospace />
                      </div>
                    </div>
                  )}

                  {/* Mode B: Free command */}
                  {form.redisMode === 'freequery' && (
                    <div className="space-y-3">
                      <div>
                        <Label>
                          {t('form.redis.queryParamLabel')}{' '}
                          <span className="text-gray-600 font-normal">{t('form.redis.queryParamHint')}</span>
                        </Label>
                        <Input value={form.redisQueryParam} onChange={(v) => set('redisQueryParam', v)} placeholder="redis_query" />
                      </div>
                      <div className="bg-gray-900 rounded-lg px-3 py-3 space-y-2.5">
                        <p className="text-xs font-medium text-gray-500">{t('form.redis.schemaModeLabel')}</p>
                        <div className="flex gap-2">
                          {(['compact', 'full'] as const).map((id) => (
                            <button key={id} type="button" onClick={() => set('redisSchemaMode', id)}
                              className={`flex-1 px-3 py-2 rounded-lg border text-xs transition-colors
                                ${form.redisSchemaMode === id ? 'bg-red-900/40 border-red-700 text-red-200' : 'border-gray-700 text-gray-500 hover:border-gray-600'}`}>
                              {id === 'compact' ? t('form.sql.schemaModeCompact') : t('form.sql.schemaModeFull')}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Write capabilities */}
                  <div className="bg-gray-900 rounded-lg px-3 py-3 space-y-2">
                    <label className="flex items-center gap-1.5 text-xs text-gray-300">
                      <input type="checkbox" checked={form.redisAllowWrite} onChange={(e) => set('redisAllowWrite', e.target.checked)} />
                      {t('form.redis.allowWrite')} <span className="text-gray-600">{t('form.redis.allowWriteHint')}</span>
                    </label>
                    {form.redisAllowWrite && (
                      <label className="flex items-center gap-1.5 text-xs text-gray-300">
                        <input type="checkbox" checked={form.redisConfirmDestructive} onChange={(e) => set('redisConfirmDestructive', e.target.checked)} />
                        {t('form.redis.confirmDestructive')}
                      </label>
                    )}
                  </div>

                  {/* Limits */}
                  <div className="w-40">
                    <Label>{t('form.redis.maxRows')}</Label>
                    <Input value={form.redisMaxRows} onChange={(v) => set('redisMaxRows', v)} placeholder="100" />
                  </div>

                </div>
              )}
            </>
          )}

          {/* ── RAG Config ───────────────────────────────────────────────── */}
          {form.executorType === 'rag' && (
            <>
              <CollapsibleHeader section="rag" label={t('form.section.rag')} />
              {!collapsed.rag && (
                <div className="space-y-4">

                  {/* Mode selector */}
                  <div>
                    <Label>{t('form.rag.modeLabel')}</Label>
                    <div className="flex gap-2">
                      {(['search', 'index'] as const).map((m) => (
                        <button
                          key={m}
                          type="button"
                          onClick={() => set('ragMode', m)}
                          className={`flex-1 py-2 px-3 rounded-lg text-xs font-medium border transition-colors ${
                            form.ragMode === m
                              ? m === 'search'
                                ? 'bg-teal-600 border-teal-500 text-white'
                                : 'bg-violet-600 border-violet-500 text-white'
                              : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-500'
                          }`}
                        >
                          {m === 'search' ? '🔍 Semantic search' : '📥 Indexing'}
                        </button>
                      ))}
                    </div>
                    <p className="text-xs text-gray-600 mt-1.5 leading-tight">
                      {form.ragMode === 'search'
                        ? t('form.rag.modeSearchNote')
                        : t('form.rag.modeIndexNote')}
                    </p>
                  </div>

                  {/* Collection selector — always visible */}
                  <div>
                    <Label>
                      {t('form.rag.collectionLabel')}{' '}
                      <span className="text-gray-600 font-normal">
                        {form.ragMode === 'search' ? t('form.rag.collectionHintSearch') : t('form.rag.collectionHintIndex')}
                      </span>
                    </Label>

                    {collectionsLoading ? (
                      <div className="flex items-center gap-2 py-2 text-xs text-gray-500">
                        <Loader2 size={12} className="animate-spin" /> {t('form.rag.loadingCollections')}
                      </div>
                    ) : qdrantCollections.length > 0 ? (
                      <select
                        value={form.ragCollection}
                        onChange={(e) => set('ragCollection', e.target.value)}
                        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm
                          text-gray-200 focus:outline-none focus:border-teal-500 transition-colors"
                      >
                        <option value="">{t('form.rag.selectCollection')}</option>
                        {qdrantCollections.map((c) => (
                          <option key={c} value={c}>{c}</option>
                        ))}
                      </select>
                    ) : (
                      <p className="text-xs text-amber-400/80 py-1">
                        {t('form.rag.noCollections')}
                      </p>
                    )}

                    {!form.ragCollection.trim() && (
                      <p className="text-xs text-amber-400/80 mt-1.5">
                        {t('form.rag.collectionWarn')}
                      </p>
                    )}
                  </div>

                  {/* ── mode=search fields ── */}
                  {form.ragMode === 'search' && (
                    <>
                      <div className="flex gap-4 items-start">
                        <div className="w-36">
                          <Label>
                            {t('form.rag.maxResultsLabel')}{' '}
                            <span className="text-gray-600 font-normal">{t('form.rag.maxResultsHint')}</span>
                          </Label>
                          <Input
                            value={form.ragLimit}
                            onChange={(v) => set('ragLimit', v)}
                            placeholder="5"
                            type="number"
                          />
                        </div>
                        <div className="flex-1">
                          <Label>
                            {t('form.rag.docVisibilityLabel')}{' '}
                            <span className="text-gray-600 font-normal">{t('form.rag.optional')}</span>
                          </Label>
                          <select
                            value={form.ragSearchScope}
                            onChange={(e) => set('ragSearchScope', e.target.value as any)}
                            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-2.5 py-2
                              text-sm text-gray-200 focus:outline-none focus:border-teal-500 transition-colors"
                          >
                            <option value="auto">{t('form.rag.scopeAuto')}</option>
                            <option value="universal">{t('form.rag.scopeUniversal')}</option>
                            <option value="all">{t('form.rag.scopeAll')}</option>
                          </select>
                          <p className="text-xs text-gray-600 leading-tight mt-1">
                            {t('form.rag.scopeNote')}
                          </p>
                        </div>
                      </div>

                      <div className="bg-teal-950/30 border border-teal-900/40 rounded-lg px-3 py-2.5">
                        <p className="text-xs text-teal-300/80 leading-relaxed">
                          {t('form.rag.searchHelp')}
                        </p>
                      </div>
                    </>
                  )}

                  {/* ── mode=index fields ── */}
                  {form.ragMode === 'index' && (
                    <>
                      <div>
                        <Label>
                          {t('form.rag.indexScopeLabel')}{' '}
                          <span className="text-gray-600 font-normal">{t('form.rag.optional')}</span>
                        </Label>
                        <select
                          value={form.ragIndexScope}
                          onChange={(e) => set('ragIndexScope', e.target.value as any)}
                          className="w-full bg-gray-900 border border-gray-700 rounded-lg px-2.5 py-2
                            text-sm text-gray-200 focus:outline-none focus:border-teal-500 transition-colors"
                        >
                          <option value="">{t('form.rag.indexScopeAuto')}</option>
                          <option value="universal">{t('form.rag.indexScopeUniversal')}</option>
                          <option value="project">{t('form.rag.indexScopeProject')}</option>
                          <option value="personal">{t('form.rag.indexScopePersonal')}</option>
                        </select>
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <Label>
                            {t('form.rag.fileIdLabel')}{' '}
                            <span className="text-gray-600 font-normal">{t('form.rag.fileIdHint')}</span>
                          </Label>
                          <Input
                            value={form.ragFileIdParam}
                            onChange={(v) => set('ragFileIdParam', v)}
                            placeholder={t('form.rag.fileIdPlaceholder')}
                          />
                          <p className="text-xs text-gray-600 mt-1 leading-tight">
                            {t('form.rag.fileIdDesc')}
                          </p>
                        </div>
                        <div>
                          <Label>
                            {t('form.rag.textParamLabel')}{' '}
                            <span className="text-gray-600 font-normal">{t('form.rag.textParamHint')}</span>
                          </Label>
                          <Input
                            value={form.ragTextParam}
                            onChange={(v) => set('ragTextParam', v)}
                            placeholder={t('form.rag.textParamPlaceholder')}
                          />
                          <p className="text-xs text-gray-600 mt-1 leading-tight">
                            {t('form.rag.textParamDesc')}
                          </p>
                        </div>
                      </div>

                      <div>
                        <Label>
                          {t('form.rag.metadataLabel')}{' '}
                          <span className="text-gray-600 font-normal">{t('form.rag.metadataHint')}</span>
                        </Label>
                        <Input
                          value={form.ragMetadataParams}
                          onChange={(v) => set('ragMetadataParams', v)}
                          placeholder={t('form.rag.metadataPlaceholder')}
                        />
                        <p className="text-xs text-gray-600 mt-1 leading-tight">
                          {t('form.rag.metadataDesc')}
                        </p>
                      </div>

                      <div className="bg-violet-950/30 border border-violet-900/40 rounded-lg px-3 py-2.5">
                        <p className="text-xs text-violet-200 leading-relaxed">
                          {t('form.rag.indexHelp')}
                        </p>
                      </div>
                    </>
                  )}

                </div>
              )}
            </>
          )}

          {/* ── Prompt Config ─────────────────────────────────────────────── */}
          {form.executorType === 'prompt' && (
            <>
              <CollapsibleHeader section="prompt" label={t('form.section.prompt')} />
              {!collapsed.prompt && (
                <div className="space-y-4">

                  {/* System prompt */}
                  <div>
                    <Label>
                      {t('form.prompt.systemLabel')}{' '}
                      <span className="text-gray-600 font-normal">
                        {t('form.prompt.systemHintPre')}{' '}
                        <code className="text-violet-400">{'{{param}}'}</code>{' '}
                        {t('form.prompt.systemHintMid')} <code className="text-violet-400">{'{{secret.KEY}}'}</code>
                      </span>
                    </Label>
                    <Textarea
                      value={form.promptSystemPrompt}
                      onChange={(v) => set('promptSystemPrompt', v)}
                      placeholder={'You are a message classifier.\nReply ONLY with: ORDER, COMPLAINT, INFO, OTHER.\nNo other words.'}
                      rows={5}
                    />
                  </div>

                  {/* User prompt template */}
                  <div>
                    <Label>
                      {t('form.prompt.userLabel')}{' '}
                      <span className="text-gray-600 font-normal">
                        {t('form.prompt.userHint')}
                      </span>
                    </Label>
                    <Textarea
                      value={form.promptUserTemplate}
                      onChange={(v) => set('promptUserTemplate', v)}
                      placeholder={'Messaggio: {{testo}}\n\nContesto: {{contesto}}'}
                      rows={3}
                    />
                  </div>

                  {/* LLM Config selector */}
                  <div>
                    <Label>{t('form.prompt.modelLabel')}</Label>
                    <select
                      value={form.promptModel}
                      onChange={(e) => set('promptModel', e.target.value)}
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm
                        text-gray-200 focus:outline-none focus:border-violet-500 transition-colors"
                    >
                      <option value="">{t('form.prompt.useDefault')}</option>
                      {llmConfigs.map((cfg) => (
                        <option key={cfg.id} value={cfg.id}>
                          {cfg.name}
                          {cfg.model ? ` · ${cfg.model}` : ''}
                          {cfg.isDefault ? ' ★' : ''}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label>{t('form.prompt.maxTokensLabel')} <span className="text-gray-600 font-normal">{t('form.prompt.maxTokensHint')}</span></Label>
                      <Input
                        value={form.promptMaxTokens}
                        onChange={(v) => set('promptMaxTokens', v)}
                        placeholder="1024"
                        type="number"
                      />
                    </div>
                    <div>
                      <Label>{t('form.prompt.tempLabel')} <span className="text-gray-600 font-normal">{t('form.prompt.tempHint')}</span></Label>
                      <Input
                        value={form.promptTemperature}
                        onChange={(v) => set('promptTemperature', v)}
                        placeholder="0"
                        type="number"
                      />
                    </div>
                  </div>

                  <div className="bg-violet-950/30 border border-violet-900/40 rounded-lg px-3 py-2.5">
                    <p className="text-xs text-violet-200 leading-relaxed">
                      {t('form.prompt.help')}
                    </p>
                  </div>

                </div>
              )}
            </>
          )}

          {/* ── Parameters ────────────────────────────────────────────────── */}
          <CollapsibleHeader section="params" label={t('form.params.label', { count: form.parameters.length })} />
          {!collapsed.params && (
            <div className="space-y-2">
              <p className="text-xs text-gray-600 leading-relaxed">
                {t('form.params.intro')}
              </p>
              {form.parameters.length === 0 && (
                <p className="text-xs text-gray-600 italic">{t('form.params.empty')}</p>
              )}
              {form.parameters.map((p, i) => (
                <div key={i} className="bg-gray-900 rounded-lg p-3 space-y-2">
                  <div className="flex items-start gap-2">
                    <div className="flex-1 min-w-0 grid grid-cols-2 gap-2">
                      <div>
                        <Label>{t('form.params.name')}</Label>
                        <input
                          value={p.name}
                          onChange={(e) => updateParam(i, 'name', e.target.value)}
                          placeholder={t('form.params.namePlaceholder')}
                          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs
                            text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500 font-mono"
                        />
                      </div>
                      <div>
                        <Label>{t('form.params.type')}</Label>
                        <select
                          value={p.type}
                          onChange={(e) => updateParam(i, 'type', e.target.value)}
                          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-xs
                            text-gray-200 focus:outline-none focus:border-blue-500"
                        >
                          <option value="string">string</option>
                          <option value="number">number</option>
                          <option value="boolean">boolean</option>
                        </select>
                      </div>
                    </div>
                    <button
                      onClick={() => removeParam(i)}
                      className="mt-5 p-1 text-gray-600 hover:text-red-400 rounded transition-colors flex-shrink-0"
                    >
                      <X size={13} />
                    </button>
                  </div>
                  <div>
                    <Label>{t('form.params.descLabel')}</Label>
                    <input
                      value={p.description}
                      onChange={(e) => updateParam(i, 'description', e.target.value)}
                      placeholder={t('form.params.descPlaceholder')}
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs
                        text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500"
                    />
                  </div>
                  <div className="flex items-center gap-3">
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={p.required}
                        onChange={(e) => updateParam(i, 'required', e.target.checked)}
                        className="accent-blue-500"
                      />
                      <span className="text-xs text-gray-400">{t('form.params.required')}</span>
                    </label>
                    <div className="flex-1">
                      <input
                        value={p.default}
                        onChange={(e) => updateParam(i, 'default', e.target.value)}
                        placeholder={t('form.params.defaultPlaceholder')}
                        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs
                          text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500"
                      />
                    </div>
                  </div>
                </div>
              ))}
              <button
                onClick={addParam}
                className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 transition-colors"
              >
                <Plus size={13} /> {t('form.params.add')}
              </button>
            </div>
          )}

          {/* ── Secrets ───────────────────────────────────────────────────── */}
          <CollapsibleHeader section="secrets" label={t('form.secrets.label', { count: form.secrets.length })} />
          {!collapsed.secrets && (
            <div className="space-y-2">
              <p className="text-xs text-gray-600 leading-relaxed">
                {t('form.secrets.introPre')}{' '}
                <code className="text-blue-400">{'{{secret.KEY_NAME}}'}</code> {t('form.secrets.introPost')}
              </p>
              {form.secrets.map((s, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <div className="w-36 flex-shrink-0">
                    <input
                      value={s.key}
                      onChange={(e) => updateSecret(i, 'key', e.target.value)}
                      placeholder="KEY_NAME"
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs
                        text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500 font-mono uppercase"
                    />
                  </div>
                  <div className="flex-1 relative">
                    <input
                      type={s.show ? 'text' : 'password'}
                      value={s.value}
                      onChange={(e) => updateSecret(i, 'value', e.target.value)}
                      placeholder={s.existing ? t('form.secrets.existingPlaceholder') : t('form.secrets.valuePlaceholder')}
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-2.5 pr-8 py-1.5 text-xs
                        text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500"
                    />
                    <button
                      onClick={() => updateSecret(i, 'show', !s.show)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-600 hover:text-gray-400"
                    >
                      {s.show ? <EyeOff size={12} /> : <Eye size={12} />}
                    </button>
                  </div>
                  {s.existing && (
                    <Lock size={12} className="text-gray-600 flex-shrink-0" />
                  )}
                  <button
                    onClick={() => removeSecret(i)}
                    className="p-1 text-gray-600 hover:text-red-400 rounded flex-shrink-0"
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
              <button
                onClick={addSecret}
                className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 transition-colors"
              >
                <Plus size={13} /> {t('form.secrets.add')}
              </button>
            </div>
          )}

          {/* ── Test ──────────────────────────────────────────────────────── */}
          <CollapsibleHeader section="test" label={t('form.test.label')} />
          {!collapsed.test && (
            <div className="space-y-3">
              {!hasSaved ? (
                <div className="flex items-center gap-2 text-xs text-gray-600">
                  <AlertCircle size={13} />
                  {t('form.test.needSave')}
                </div>
              ) : (
                <>
                  <div>
                    <Label>
                      {t('form.test.argsLabel')}{' '}
                      <span className="text-gray-600 font-normal">{t('form.test.argsHint')}</span>
                    </Label>
                    <Textarea
                      value={testArgs}
                      onChange={setTestArgs}
                      placeholder='{}'
                      rows={form.parameters.length > 0 ? Math.min(form.parameters.length + 2, 6) : 3}
                      monospace
                    />
                  </div>
                  <button
                    onClick={handleTest}
                    disabled={testLoading}
                    className="flex items-center gap-2 px-4 py-2 bg-emerald-700 hover:bg-emerald-600
                      disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-medium
                      rounded-lg transition-colors"
                  >
                    {testLoading ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
                    {testLoading ? t('form.test.running') : t('form.test.run')}
                  </button>

                  {testResult && (
                    <div
                      ref={testResultRef}
                      className={`rounded-lg border text-xs overflow-hidden
                        ${testResult.success
                          ? 'border-emerald-800 bg-emerald-950/40'
                          : 'border-red-800 bg-red-950/40'
                        }`}
                    >
                      <div className={`flex items-center justify-between px-3 py-2 border-b
                        ${testResult.success ? 'border-emerald-800' : 'border-red-800'}`}
                      >
                        <div className="flex items-center gap-2">
                          {testResult.success
                            ? <CheckCircle size={13} className="text-emerald-400" />
                            : <XCircle    size={13} className="text-red-400" />
                          }
                          <span className={testResult.success ? 'text-emerald-300' : 'text-red-300'}>
                            {testResult.success ? t('form.test.success') : `${t('form.test.errorPrefix')} ${testResult.error_type ?? ''}`}
                          </span>
                        </div>
                        <span className="text-gray-600">{testResult.elapsed_ms}ms</span>
                      </div>
                      <pre className="px-3 py-2.5 text-gray-300 whitespace-pre-wrap break-all font-mono leading-relaxed
                        max-h-64 overflow-y-auto">
                        {testResult.success ? testResult.result : testResult.error}
                      </pre>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>

      {/* Footer */}
      <div className="border-t border-gray-800 mt-6 pt-4 flex items-center gap-3">
        {/* Delete — owner only, existing tool only */}
        {isOwner && hasSaved && (
          confirmDelete ? (
            <div className="flex items-center gap-2 flex-shrink-0">
              <span className="text-xs text-gray-400">{t('card.deleteConfirm')}</span>
              <button
                onClick={() => deleteMut.mutate()}
                disabled={deleteMut.isPending}
                className="px-2 py-1 text-xs bg-red-600 hover:bg-red-500 text-white rounded transition-colors"
              >
                {deleteMut.isPending ? <Loader2 size={12} className="animate-spin" /> : t('card.delete')}
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="px-2 py-1 text-xs text-gray-400 hover:text-gray-200 rounded"
              >
                {t('card.no')}
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              title={t('card.delete')}
              className="flex items-center gap-1.5 px-2.5 py-2 text-sm text-gray-400 hover:text-red-400 rounded-lg transition-colors flex-shrink-0"
            >
              <Trash2 size={15} /> {t('card.delete')}
            </button>
          )
        )}
        <div className="min-w-0 flex-1 pr-4">
            {saveError && (
              <div className="flex items-center gap-1.5 text-xs text-red-400">
                <XCircle size={13} />
                <span className="truncate">{saveError}</span>
              </div>
            )}
            {(createMut.isSuccess || updateMut.isSuccess) && !saveError && (
              <div className="flex items-center gap-1.5 text-xs text-emerald-400">
                <CheckCircle size={13} />
                {t('modal.saved')}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={onClose}
              className="px-3 py-2 text-sm text-gray-400 hover:text-gray-200 rounded-lg transition-colors"
            >
              {hasSaved ? t('modal.close') : t('common:actions.cancel')}
            </button>
            <button
              onClick={handleSave}
              disabled={isSaving || !!nameError || !form.name || !form.description}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500
                disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium
                rounded-lg transition-colors"
            >
              {isSaving ? <Loader2 size={14} className="animate-spin" /> : null}
              {isSaving ? t('modal.saving') : hasSaved ? t('modal.saveChanges') : t('modal.createTool')}
            </button>
          </div>
        </div>
      </div>
  );
}
/* end ToolEditor */

// ── ToolsSection (export) ─────────────────────────────────────────────────────

export function ToolsSection() {
  const { t } = useTranslation('tools');
  const qc = useQueryClient();
  const user    = useStore((s) => s.user);
  const isAdmin = user?.role === 'admin';

  const [showModal, setShowModal]     = useState(false);
  const [editingTool, setEditingTool] = useState<CustomTool | null>(null);

  const { data: tools = [], isLoading } = useQuery({
    queryKey: ['custom-tools'],
    queryFn:  customToolsApi.list,
  });

  const openCreate = () => { setEditingTool(null); setShowModal(true); };
  const openEdit   = (t: CustomTool) => { setEditingTool(t); setShowModal(true); };
  const closeModal = () => { setShowModal(false); setEditingTool(null); };

  const enabledCount  = tools.filter((t) => t.enabled).length;
  const disabledCount = tools.length - enabledCount;
  const sharedCount   = tools.filter((t) => t.scope !== 'personal').length;

  // Editor replaces the list in-place (Flows-style) instead of a right-anchored drawer.
  if (showModal) {
    return <ToolEditor tool={editingTool} isAdmin={isAdmin} onClose={closeModal} />;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-white">{t('title')}</h2>
          <p className="text-sm text-gray-500 mt-1 leading-relaxed">
            {t('subtitle')}
          </p>
        </div>
        <button
          onClick={openCreate}
          className="flex items-center gap-2 px-3.5 py-2 bg-blue-600 hover:bg-blue-500
            text-white text-sm font-medium rounded-lg transition-colors flex-shrink-0"
        >
          <Plus size={15} />
          {t('new')}
        </button>
      </div>

      {/* Stats */}
      {tools.length > 0 && (
        <div className="flex items-center gap-4 text-xs text-gray-500">
          <div className="flex items-center gap-1.5">
            <Globe size={12} className="text-blue-400" />
            <span>{t('stats.total', { count: tools.length })}</span>
          </div>
          <span>·</span>
          <span className="text-emerald-400">{t('stats.enabled', { count: enabledCount })}</span>
          {disabledCount > 0 && (
            <>
              <span>·</span>
              <span>{t('stats.disabled', { count: disabledCount })}</span>
            </>
          )}
          {sharedCount > 0 && (
            <>
              <span>·</span>
              <span className="flex items-center gap-1 text-purple-400">
                <Users size={10} /> {t('stats.teamOrg', { count: sharedCount })}
              </span>
            </>
          )}
        </div>
      )}

      {/* Tool list */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        {isLoading ? (
          <div className="flex items-center justify-center py-10 gap-2 text-gray-600 text-sm">
            <Loader2 size={16} className="animate-spin" />
            {t('common:actions.loading')}
          </div>
        ) : tools.length === 0 ? (
          <div className="py-14 text-center space-y-3">
            <div className="w-12 h-12 bg-gray-800 rounded-2xl flex items-center justify-center mx-auto">
              <Terminal size={22} className="text-gray-600" />
            </div>
            <div>
              <p className="text-sm text-gray-400">{t('empty.title')}</p>
              <p className="text-xs text-gray-600 mt-1">
                {t('empty.subtitle')}
              </p>
            </div>
            <button
              onClick={openCreate}
              className="inline-flex items-center gap-1.5 text-sm text-blue-400 hover:text-blue-300 transition-colors"
            >
              <Plus size={14} /> {t('create')}
            </button>
          </div>
        ) : (
          <div className="divide-y divide-gray-800">
            {tools.map((tool) => (
              <ToolCard
                key={tool.id}
                tool={tool}
                isOwner={tool.userId === user?.id}
                onEdit={() => openEdit(tool)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Interpolation note */}
      {tools.length > 0 && (
        <div className="bg-gray-900/60 border border-gray-800/60 rounded-xl px-4 py-3 space-y-1">
          <p className="text-xs font-medium text-gray-500">{t('placeholders.title')}</p>
          <div className="grid grid-cols-3 gap-2 text-xs font-mono text-gray-600">
            <code className="text-blue-400">{'{{paramName}}'}</code>
            <span className="col-span-2 text-gray-600">{t('placeholders.param')}</span>
            <code className="text-amber-400">{'{{secret.KEY}}'}</code>
            <span className="col-span-2 text-gray-600">{t('placeholders.secret')}</span>
            <code className="text-emerald-400">{'{{env.VAR}}'}</code>
            <span className="col-span-2 text-gray-600">{t('placeholders.env')}</span>
          </div>
        </div>
      )}
    </div>
  );
}
