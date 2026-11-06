// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

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
  /** Pass the expected words to the model as its prompt (the admin's + the names the memory knows). */
  transcriptionVocabularyEnabled: boolean;
  transcriptionVocabulary:        string | null;
  /** Model of the bundled service used when a cloud provider fails; null = none. */
  transcriptionFallbackModel:     string | null;
  /** Whether the bundled whisper-service is deployed (GET only). */
  internalAvailable?:     boolean;
  /** Models the bundled service has downloaded: the only fallback choices (GET only). */
  localModels?:           { id: string; engine: string }[];
}

export interface UpdateTranscriptionConfigPayload {
  transcriptionEnabled:   boolean;
  transcriptionProvider:  TranscriptionProvider;
  transcriptionModel?:    string | null;
  /** Non-empty string → save, null → clear, undefined → leave untouched */
  transcriptionApiKey?:   string | null;
  transcriptionBaseUrl?:  string | null;
  transcriptionVocabularyEnabled?: boolean;
  transcriptionVocabulary?:        string | null;
  transcriptionFallbackModel?:     string | null;
}

export type TtsProvider = 'internal' | 'openai' | 'openai-compatible';

export interface TtsConfig {
  ttsEnabled:   boolean;
  /** Null = unset (the backend applies the env fallback, default internal). */
  ttsProvider:  TtsProvider | null;
  ttsModel:     string | null;
  hasTtsApiKey: boolean;
  ttsBaseUrl:   string | null;
  ttsVoice:     string | null;
  /** Whether the bundled piper-service is deployed (GET only). */
  internalAvailable?: boolean;
}

/** Home Assistant as a native integration: settings + live status (the token only as set or not). */
export interface HomeAssistantConfig {
  haUrl: string | null;
  hasHaToken: boolean;
  haPresenceEnabled: boolean;
  haVoiceEnabled:    boolean;
  haToolsEnabled:    boolean;
  haToolsUserIds:    string[] | null;
  users:   Array<{ id: string; name: string; haPerson: string | null }>;
  servers: Array<{ id: string; name: string }>;
  status: {
    state: 'off' | 'connecting' | 'connected' | 'error';
    error: string | null;
    version: string | null;
    url: string | null;
    memoryUserId: string | null;
    voicePoints: Array<{ entityId: string; area: string; listens: boolean }>;
    home: string[];
    rooms: Array<{ area: string; people: string[]; someone: number }>;
    persons: Array<{ entityId: string; name: string }>;
    exposed: number;
  };
}

export interface UpdateHomeAssistantPayload {
  haUrl?: string | null;
  haToken?: string | null;
  haPresenceEnabled?: boolean;
  haVoiceEnabled?:    boolean;
  haToolsEnabled?:    boolean;
  haToolsUserIds?:    string[] | null;
}

/** Wyoming voice server (Home Assistant & co.): config + live status. */
export interface WyomingConfig {
  wyomingEnabled:       boolean;
  wyomingAllowedCidrs:  string | null;
  /** Conversation identity (null = STT/TTS only). */
  wyomingHandleUserId:  string | null;
  wyomingHandleAgentId: string | null;
  /** Save the conversation turns as chats of the handle user. */
  wyomingPersistConversations: boolean;
  running:   boolean;
  port:      number;
  clients:   number;
  lastError: string | null;
  /** Conversation agent as resolved by the server (null = not exposed). */
  handle:    { userEmail: string; agentName: string | null; model: string } | null;
}

export interface UpdateWyomingConfigPayload {
  wyomingEnabled:        boolean;
  wyomingAllowedCidrs?:  string | null;
  wyomingHandleUserId?:  string | null;
  wyomingHandleAgentId?: string | null;
  wyomingPersistConversations?: boolean;
}

export interface UpdateTtsConfigPayload {
  ttsEnabled:  boolean;
  ttsProvider: TtsProvider;
  ttsModel?:   string | null;
  /** Non-empty string → save, null → clear, undefined → leave untouched */
  ttsApiKey?:  string | null;
  ttsBaseUrl?: string | null;
  ttsVoice?:   string | null;
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
  /** Model actually served by the active provider (for 'internal': loaded by the embedding service); null if unreachable. */
  activeModel?:         string | null;
  activeVectorSize?:    number | null;
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

  // ── TTS Config (Piper) ──────────────────────────────────────────────────────

  /** GET /api/admin/config/tts — text-to-speech configuration */
  getTtsConfig: (): Promise<TtsConfig> =>
    api.get('/admin/config/tts').then((r) => r.data),

  /** PATCH /api/admin/config/tts — update text-to-speech configuration */
  updateTtsConfig: (payload: UpdateTtsConfigPayload): Promise<TtsConfig> =>
    api.patch('/admin/config/tts', payload).then((r) => r.data),

  /** POST /api/admin/config/tts/test — test the TTS endpoint (micro-synthesis) */
  testTtsConnection: (): Promise<{ ok: boolean; error?: string; model?: string }> =>
    api.post('/admin/config/tts/test').then((r) => r.data),

  // ── Home Assistant (presence and voice) ───────────────────────────────────────

  /** GET /api/admin/config/home-assistant — settings, live status, MCP servers to pick from */
  getHomeAssistantConfig: (): Promise<HomeAssistantConfig> =>
    api.get('/admin/config/home-assistant').then((r) => r.data),

  /** PATCH /api/admin/config/home-assistant — update the settings (reconnects at once) */
  updateHomeAssistantConfig: (payload: UpdateHomeAssistantPayload): Promise<HomeAssistantConfig> =>
    api.patch('/admin/config/home-assistant', payload).then((r) => r.data),

  /** POST /api/admin/config/home-assistant/import-mcp — URL and token from its MCP server (turned off after) */
  importHomeAssistantFromMcp: (serverId: string, disable: boolean): Promise<HomeAssistantConfig> =>
    api.post('/admin/config/home-assistant/import-mcp', { serverId, disable }).then((r) => r.data),

  /** PATCH /api/admin/config/home-assistant/people — a user's Home Assistant person */
  linkHomeAssistantPerson: (userId: string, haPerson: string | null): Promise<HomeAssistantConfig> =>
    api.patch('/admin/config/home-assistant/people', { userId, haPerson }).then((r) => r.data),

  // ── Wyoming voice server ────────────────────────────────────────────────────

  /** GET /api/admin/config/wyoming — configuration + live listener status */
  getWyomingConfig: (): Promise<WyomingConfig> =>
    api.get('/admin/config/wyoming').then((r) => r.data),

  /** PATCH /api/admin/config/wyoming — update the configuration (listener restarted at once) */
  updateWyomingConfig: (payload: UpdateWyomingConfigPayload): Promise<WyomingConfig> =>
    api.patch('/admin/config/wyoming', payload).then((r) => r.data),

  /** GET /api/admin/config/wyoming/agents?userId= — agents a user can run as conversation agent */
  listWyomingAgents: (userId: string): Promise<{ id: string; name: string }[]> =>
    api.get('/admin/config/wyoming/agents', { params: { userId } }).then((r) => r.data),

  // ── Tool Loading Config ─────────────────────────────────────────────────────

  /** GET /api/admin/config/tool-loading */
  getToolLoadingConfig: (): Promise<ToolLoadingConfig> =>
    api.get('/admin/config/tool-loading').then((r) => r.data),

  /** PATCH /api/admin/config/tool-loading */
  updateToolLoadingConfig: (payload: ToolLoadingConfig): Promise<ToolLoadingConfig> =>
    api.patch('/admin/config/tool-loading', payload).then((r) => r.data),

  // ── Network isolation level (detected, read-only) ───────────────────────────

  /** GET /api/admin/config/isolation — probed compose-topology isolation level */
  getIsolationInfo: (): Promise<IsolationInfo> =>
    api.get('/admin/config/isolation').then((r) => r.data),

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

  /** GET /api/admin/config/mcp-security — MCP anti-SSRF policy */
  getMcpSecurityConfig: (): Promise<McpSecurityConfig> =>
    api.get('/admin/config/mcp-security').then((r) => r.data),

  /** PATCH /api/admin/config/mcp-security — update MCP anti-SSRF policy */
  updateMcpSecurityConfig: (payload: McpSecurityConfig): Promise<McpSecurityConfig> =>
    api.patch('/admin/config/mcp-security', payload).then((r) => r.data),
};

export interface DataSourceSecurityConfig {
  /** Allow DataSources to target private/loopback/CGNAT hosts (metadata always blocked). */
  dataSourceAllowPrivateHosts: boolean;
  /** Host/IP/CIDR allowed even when private hosts are disallowed. */
  dataSourceHostAllowlist: string[];
}

export interface McpSecurityConfig {
  /** Allow http/sse MCP servers to target private/loopback/CGNAT hosts (metadata always blocked). */
  mcpAllowPrivateHosts: boolean;
  /** Host/IP/CIDR allowed even when private hosts are disallowed. */
  mcpHostAllowlist: string[];
}

// ── Sandbox types ───────────────────────────────────────────────────────────

export type SandboxNetwork = 'none' | 'internal' | 'internet' | 'open';

/** Runtime mode reported by the executor (read-only; null = executor unreachable). */
export type SandboxRuntimeMode = 'broker' | 'in-process' | 'unavailable';

/** Execution profile: hardened (isolated, default) | trusted (writable rootfs + root). */
export type SandboxExecMode = 'hardened' | 'trusted';

/** Network-isolation level of the deployment, probed server-side at runtime. */
export interface IsolationInfo {
  level: 1 | 2 | 3;
  name: 'standard' | 'isolated' | 'maximum';
  brokerReachable: boolean;
  egressReachable: boolean;
  executorSandboxMode: 'broker' | 'in-process' | 'unavailable' | null;
  jobEgressNetwork: string | null;
  /** Broker's network allowlist (double gate); null if the broker doesn't declare it. */
  brokerAllowedNetworks: string[] | null;
  /** True when the `internet` tier can actually work: egress proxy deployed AND its network declared + allowed by the broker. */
  internetTierAvailable: boolean;
  /** True when the `open` tier network (default `bridge`) passes the broker allowlist (hardened deploys may remove it). */
  openTierAvailable: boolean;
  /** False when the broker refuses the 'trusted' exec profile (BROKER_ALLOW_PRIVILEGED_SANDBOX unset → silent fallback to hardened). */
  trustedExecModeAvailable: boolean;
}

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

// ── Recordare (episodic memory service) ───────────────────────────────────────

export type RecordareSource = 'settings' | 'env' | null;

export interface RecordareConfig {
  recordareUrl: string | null;
  hasRecordareApiKey: boolean;
  hasRecordareWebhookSecret: boolean;
  /** Where each value in use comes from: these settings, the server's environment, or missing. */
  sources: { url: RecordareSource; apiKey: RecordareSource; webhookSecret: RecordareSource };
  effectiveUrl: string | null;
  configured: boolean;
  /** The last verified webhook delivery since the backend started. */
  lastWebhook: { at: string; type: string } | null;
}

/** A string sets, null clears (the environment applies again), absent keeps. */
export interface UpdateRecordareConfigPayload {
  recordareUrl?: string | null;
  recordareApiKey?: string | null;
  recordareWebhookSecret?: string | null;
}

export const recordareConfigApi = {
  get: (): Promise<RecordareConfig> => api.get('/admin/config/recordare').then((r) => r.data),
  update: (payload: UpdateRecordareConfigPayload): Promise<RecordareConfig> =>
    api.patch('/admin/config/recordare', payload).then((r) => r.data),
  test: (): Promise<{ ok: boolean; error?: string; latencyMs?: number }> =>
    api.post('/admin/config/recordare/test').then((r) => r.data),
};
