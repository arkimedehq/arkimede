import api from './client';

export type LlmProvider =
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'ollama'
  | 'lmstudio'
  | 'openai-compatible'
  | 'deepseek';

export type EmbeddingProvider =
  | 'internal'
  | 'openai'
  | 'voyage'
  | 'ollama'
  | 'lmstudio'
  | 'openai-compatible';

export type TranscriptionProvider = 'internal' | 'openai' | 'groq' | 'openai-compatible';

export interface AppConfig {
  id:           number;
  systemPrompt: string;
  updatedAt:    string;
}

export interface TranscriptionConfig {
  transcriptionEnabled:   boolean;
  transcriptionProvider:  TranscriptionProvider;
  transcriptionModel:     string | null;
  hasTranscriptionApiKey: boolean;
  transcriptionBaseUrl:   string | null;
}

export interface UpdateTranscriptionConfigPayload {
  transcriptionEnabled:   boolean;
  transcriptionProvider:  TranscriptionProvider;
  transcriptionModel?:    string | null;
  /** Non-empty string → save, null → clear, undefined → leave untouched */
  transcriptionApiKey?:   string | null;
  transcriptionBaseUrl?:  string | null;
}

export interface EmbeddingConfig {
  embeddingProvider:    EmbeddingProvider;
  embeddingModel:       string | null;
  hasEmbeddingApiKey:   boolean;
  embeddingBaseUrl:     string | null;
  embeddingVectorSize:  number;
  embeddingQueryPrefix: string | null;
  embeddingChunkSize:   number;
  embeddingChunkOverlap: number;
}

export interface UpdateEmbeddingConfigPayload {
  embeddingProvider:    EmbeddingProvider;
  embeddingModel?:      string | null;
  /** Non-empty string → save, null → clear, undefined → leave untouched */
  embeddingApiKey?:     string | null;
  embeddingBaseUrl?:    string | null;
  embeddingVectorSize:  number;
  embeddingQueryPrefix?: string | null;
  embeddingChunkSize:   number;
  embeddingChunkOverlap: number;
}

export const appConfigApi = {
  /** GET /api/admin/config — full configuration (admin) */
  get: (): Promise<AppConfig> =>
    api.get('/admin/config').then((r) => r.data),

  /** PATCH /api/admin/config — update the base system prompt */
  updateSystemPrompt: (systemPrompt: string): Promise<AppConfig> =>
    api.patch('/admin/config', { systemPrompt }).then((r) => r.data),

  /** @deprecated use updateSystemPrompt */
  update: (systemPrompt: string): Promise<AppConfig> =>
    api.patch('/admin/config', { systemPrompt }).then((r) => r.data),

  // The LLM configuration (default/summarizer) is managed by `llmConfigsApi`
  // (see api/llmConfigs.ts) — multi-record CRUD with per-row connection test.

  // ── Embedding Config ────────────────────────────────────────────────────────

  /** GET /api/admin/config/embedding — embedding configuration */
  getEmbeddingConfig: (): Promise<EmbeddingConfig> =>
    api.get('/admin/config/embedding').then((r) => r.data),

  /** PATCH /api/admin/config/embedding — update embedding configuration */
  updateEmbeddingConfig: (payload: UpdateEmbeddingConfigPayload): Promise<EmbeddingConfig> =>
    api.patch('/admin/config/embedding', payload).then((r) => r.data),

  /** POST /api/admin/config/embedding/test — test the connection to the embedding provider */
  testEmbeddingConnection: (): Promise<{ ok: boolean; error?: string; model?: string; dims?: number }> =>
    api.post('/admin/config/embedding/test').then((r) => r.data),

  // ── Transcription Config (Whisper) ──────────────────────────────────────────

  /** GET /api/admin/config/transcription — voice transcription configuration */
  getTranscriptionConfig: (): Promise<TranscriptionConfig> =>
    api.get('/admin/config/transcription').then((r) => r.data),

  /** PATCH /api/admin/config/transcription — update transcription configuration */
  updateTranscriptionConfig: (payload: UpdateTranscriptionConfigPayload): Promise<TranscriptionConfig> =>
    api.patch('/admin/config/transcription', payload).then((r) => r.data),

  /** POST /api/admin/config/transcription/test — test the Whisper endpoint */
  testTranscriptionConnection: (): Promise<{ ok: boolean; error?: string; model?: string }> =>
    api.post('/admin/config/transcription/test').then((r) => r.data),

  // ── Tool Loading Config ─────────────────────────────────────────────────────

  /** GET /api/admin/config/tool-loading */
  getToolLoadingConfig: (): Promise<ToolLoadingConfig> =>
    api.get('/admin/config/tool-loading').then((r) => r.data),

  /** PATCH /api/admin/config/tool-loading */
  updateToolLoadingConfig: (payload: ToolLoadingConfig): Promise<ToolLoadingConfig> =>
    api.patch('/admin/config/tool-loading', payload).then((r) => r.data),

  // ── Sandbox Config ──────────────────────────────────────────────────────────

  /** GET /api/admin/config/sandbox — sandbox tool gating */
  getSandboxConfig: (): Promise<SandboxConfig> =>
    api.get('/admin/config/sandbox').then((r) => r.data),

  /** PATCH /api/admin/config/sandbox — enable and configure allowlist/network */
  updateSandboxConfig: (payload: SandboxConfig): Promise<SandboxConfig> =>
    api.patch('/admin/config/sandbox', payload).then((r) => r.data),

  // ── DataSource security (anti-SSRF) ─────────────────────────────────────────

  /** GET /api/admin/config/datasource-security — anti-SSRF policy */
  getDataSourceSecurityConfig: (): Promise<DataSourceSecurityConfig> =>
    api.get('/admin/config/datasource-security').then((r) => r.data),

  /** PATCH /api/admin/config/datasource-security — update anti-SSRF policy */
  updateDataSourceSecurityConfig: (payload: DataSourceSecurityConfig): Promise<DataSourceSecurityConfig> =>
    api.patch('/admin/config/datasource-security', payload).then((r) => r.data),
};

export interface DataSourceSecurityConfig {
  /** Allow DataSources to target private/loopback/CGNAT hosts (metadata always blocked). */
  dataSourceAllowPrivateHosts: boolean;
  /** Host/IP/CIDR allowed even when private hosts are disallowed. */
  dataSourceHostAllowlist: string[];
}

// ── Sandbox types ───────────────────────────────────────────────────────────

export type SandboxNetwork = 'none' | 'internal' | 'internet' | 'open';

/** Runtime mode reported by the executor (read-only; null = executor unreachable). */
export type SandboxRuntimeMode = 'broker' | 'in-process' | 'unavailable';

/** Execution profile: hardened (isolated, default) | trusted (writable rootfs + root). */
export type SandboxExecMode = 'hardened' | 'trusted';

export interface SandboxConfig {
  /** Global master switch. */
  sandboxEnabled: boolean;
  /** Authorized teams (in addition to admins). */
  sandboxAllowedTeamIds: string[];
  /** Authorized projects. */
  sandboxAllowedProjectIds: string[];
  /** Network tier: none | internal (backend) | internet (allowlist) | open (full internet). */
  sandboxNetwork: SandboxNetwork;
  /**
   * Execution profile. 'hardened' (default) = read-only rootfs, non-root, cap-drop ALL.
   * 'trusted' = writable rootfs + root + default caps (lets the code apt-get system
   * libraries), and additionally requires the broker's BROKER_ALLOW_PRIVILEGED_SANDBOX flag.
   */
  sandboxExecMode: SandboxExecMode;
  /** Only in the GET response (not part of the PATCH payload). */
  sandboxRuntimeMode?: SandboxRuntimeMode | null;
}

// ── Tool Loading types ────────────────────────────────────────────────────────

export type ToolLoadingStrategy = 'always_inject_all' | 'top_k_rag' | 'auto';
export type ToolSchemaFormat    = 'full' | 'compressed' | 'deferred';

export interface ToolLoadingConfig {
  toolLoadingStrategy: ToolLoadingStrategy;
  toolLoadingMaxTools: number;
  toolSchemaFormat:    ToolSchemaFormat;
  maxHistoryTokens:    number;
  historyCompactionEnabled: boolean;
  historyCompactionThreshold: number;
  /** Global default threshold for user memory extraction (number of new messages). */
  autoMemoryThreshold: number;
}
