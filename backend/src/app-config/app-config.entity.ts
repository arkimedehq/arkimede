import { Entity, PrimaryColumn, Column, UpdateDateColumn } from 'typeorm';

/**
 * Tool selection strategy (Axis 1 — how many tools to inject into the prompt).
 *
 * - always_inject_all  → all tools, always (default — current behavior)
 * - top_k_rag          → only the K tools semantically closest to the user message
 * - auto               → inject_all if n_tool ≤ maxTools, otherwise top_k_rag
 */
export type ToolLoadingStrategy = 'always_inject_all' | 'top_k_rag' | 'auto';

/**
 * Tool schema format (Axis 2 — how much detail per tool in the prompt).
 *
 * - full        → full JSON schema with all descriptions (default)
 * - compressed  → only the first sentence of the description; Zod schema unchanged
 * - deferred    → tools exposed with a minimal description; the full list (name + 1-liner)
 *                 is injected into the system prompt. A `get_tool_instructions` meta-tool
 *                 provides the SKILL.md on-demand. The selection (Axis 1) determines
 *                 how many tools are available (all or top-K RAG).
 */
export type ToolSchemaFormat = 'full' | 'compressed' | 'deferred';

/** Supported LLM providers. */
export type LlmProvider =
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'ollama'
  | 'lmstudio'
  | 'openai-compatible'
  | 'deepseek';

/**
 * Supported embedding providers.
 * - openai           → OpenAI cloud API (text-embedding-3-*)
 * - voyage           → VoyageAI API (voyage-multilingual-2, etc.)
 * - ollama           → local models via Ollama
 * - lmstudio         → local models via LM Studio (OpenAI-compatible API)
 * - openai-compatible→ any server with an OpenAI-compatible API
 */
export type EmbeddingProvider =
  | 'internal'
  | 'openai'
  | 'voyage'
  | 'ollama'
  | 'lmstudio'
  | 'openai-compatible';

/**
 * Supported voice transcription (Whisper) providers. They all speak the same
 * OpenAI-compatible `/v1/audio/transcriptions` contract; only the endpoint changes.
 * - openai            → OpenAI cloud API (whisper-1, gpt-4o-transcribe)
 * - groq              → Groq cloud (whisper-large-v3, very fast/cheap)
 * - openai-compatible → self-hosted whisper (faster-whisper / whisper.cpp server)
 * - internal          → the app's internal whisper service (whisper-service), auto-configured
 */
export type TranscriptionProvider = 'internal' | 'openai' | 'groq' | 'openai-compatible';

/**
 * Global application configuration — singleton table (always a single row, id = 1).
 *
 * Contains parameters editable at runtime by admins without the need for a redeploy.
 * The initial value is seeded by AppConfigService.onModuleInit() using the default
 * values, only if the table is still empty.
 */
@Entity('app_config')
export class AppConfigEntity {
  /** Fixed primary key — the table always has exactly one row. */
  @PrimaryColumn({ type: 'int' })
  id: number;

  /**
   * AI system base prompt.
   * It is prepended to the user's custom prompt and to the project's one.
   * Editable by the admin in the settings → "AI System" section.
   */
  @Column({ type: 'text' })
  systemPrompt: string;

  // The LLM configuration lives in the multi-record `llm_configs` table
  // (default + summarizer), no longer in app_config. See LlmConfigsService.

  // ── Embedding configuration ─────────────────────────────────────────────────

  /**
   * Active embedding provider.
   * Default: 'internal' — uses the embedding microservice bundled with the app
   * (whisper-service is the analog for transcription), auto-configured via
   * EMBEDDING_BASE_URL + /v1/models probing. The admin can choose their own provider.
   */
  @Column({ type: 'varchar', length: 50, default: 'internal' })
  embeddingProvider: EmbeddingProvider;

  /**
   * Embedding model name.
   * If null, the provider's default is used
   * (e.g. nomic-embed-text for lmstudio/ollama, text-embedding-3-small for openai).
   */
  @Column({ type: 'varchar', length: 200, nullable: true })
  embeddingModel: string | null;

  /**
   * Encrypted API key (AES-256-CBC) for cloud providers (OpenAI, VoyageAI).
   * If null, it tries the corresponding environment variable.
   * Format: "<iv_hex>:<ciphertext_hex>".
   */
  @Column({ type: 'text', nullable: true })
  embeddingApiKey: string | null;

  /**
   * Base URL for local or OpenAI-compatible providers.
   * Examples:
   *   Ollama:    http://localhost:11434
   *   LM Studio: http://localhost:1234/v1
   */
  @Column({ type: 'varchar', length: 500, nullable: true })
  embeddingBaseUrl: string | null;

  /**
   * Dimension of the vectors produced by the embedding model.
   * Must match the dimension with which the Qdrant collections were created.
   */
  @Column({ type: 'int', default: 1024 })
  embeddingVectorSize: number;

  /**
   * Prefix to prepend to search *queries* before embedding.
   * Some models (e.g. nomic-embed-text) use text prefixes to
   * distinguish queries from documents. E.g.: "search_query: "
   */
  @Column({ type: 'text', nullable: true })
  embeddingQueryPrefix: string | null;

  /**
   * Maximum size of each chunk in characters (~350-400 tokens).
   * Configurable to balance precision and the model's context window.
   */
  @Column({ type: 'int', default: 500 })
  embeddingChunkSize: number;

  /**
   * Overlap between consecutive chunks in characters.
   * Ensures semantic continuity at the chunk boundaries.
   */
  @Column({ type: 'int', default: 50 })
  embeddingChunkOverlap: number;

  // ── Voice transcription configuration (Whisper) ─────────────────────────────

  /**
   * Global toggle of the microphone button in chat. Default true: the internal
   * whisper service is bundled with the app, so voice input works out-of-the-box.
   */
  @Column({ type: 'boolean', default: true })
  transcriptionEnabled: boolean;

  /**
   * Active transcription provider (OpenAI-compatible endpoint).
   * Default 'internal' — uses the bundled whisper-service, auto-configured via
   * TRANSCRIPTION_BASE_URL. The admin can choose OpenAI/Groq/self-hosted.
   */
  @Column({ type: 'varchar', length: 50, default: 'internal' })
  transcriptionProvider: TranscriptionProvider;

  /**
   * Transcription model name (e.g. whisper-1, whisper-large-v3).
   * If null, the provider's default is used.
   */
  @Column({ type: 'varchar', length: 200, nullable: true })
  transcriptionModel: string | null;

  /**
   * Encrypted API key (AES-256-CBC) for cloud providers (OpenAI, Groq).
   * If null, it tries the corresponding environment variable.
   * Format: "<iv_hex>:<ciphertext_hex>".
   */
  @Column({ type: 'text', nullable: true })
  transcriptionApiKey: string | null;

  /**
   * Base URL for self-hosted / OpenAI-compatible providers.
   * Examples:
   *   Groq:    https://api.groq.com/openai/v1
   *   local:   http://whisper:9000/v1
   */
  @Column({ type: 'varchar', length: 500, nullable: true })
  transcriptionBaseUrl: string | null;

  // ── Tool loading configuration ──────────────────────────────────────────────

  /**
   * Axis 1 — Selection strategy: how many tools to inject into the prompt.
   * Default: 'always_inject_all' (backward-compatible).
   */
  @Column({ type: 'varchar', length: 30, default: 'always_inject_all' })
  toolLoadingStrategy: ToolLoadingStrategy;

  /**
   * Threshold for the 'auto' strategy and K for 'top_k_rag'.
   * - auto:      if n_tool ≤ toolLoadingMaxTools → inject_all, otherwise → RAG
   * - top_k_rag: retrieves exactly toolLoadingMaxTools relevant tools
   */
  @Column({ type: 'int', default: 15 })
  toolLoadingMaxTools: number;

  /**
   * Axis 2 — Schema format: how much detail to expose for each tool.
   * Default: 'full' (backward-compatible).
   */
  @Column({ type: 'varchar', length: 20, default: 'full' })
  toolSchemaFormat: ToolSchemaFormat;

  /**
   * Global token limit for the conversation history (global default).
   * The budget is ALWAYS applied (trim in buildMessages); compaction decides
   * only whether the overflow is summarized or discarded. A turn's weight also
   * includes the replayed tool-calls (SQL/schema output can weigh more than the text).
   * Recommended value: 20000-50000 tokens with compaction enabled — see
   * DATAFLOW_AGENT.md for the full flow.
   *
   * Users can override it with their own `maxHistoryTokens`.
   */
  @Column({ type: 'int', default: 30000 })
  maxHistoryTokens: number;

  /**
   * If true, when the history exceeds the `maxHistoryTokens` threshold the oldest
   * turns are summarized (rolling summary persisted on the Chat) instead of being
   * simply discarded. Default true: turning it off means the overflow is silently
   * thrown away by the trim (lost memory).
   */
  @Column({ type: 'boolean', default: true })
  historyCompactionEnabled: boolean;

  /**
   * Percentage of `maxHistoryTokens` beyond which compaction triggers:
   * when `summary + fresh turns` exceeds this threshold, the oldest turns
   * are summarized. Low values = more frequent/aggressive compaction.
   */
  @Column({ type: 'int', default: 80 })
  historyCompactionThreshold: number;

  /**
   * If true, 👎/👍 feedback with a correction is vectorized into 'feedback_memory'
   * and re-injected into the system prompt on future similar requests (active memory).
   * Default false. On activation the vector collection is created.
   */
  @Column({ type: 'boolean', default: false })
  feedbackMemoryEnabled: boolean;

  /**
   * Global default of the user-memory extraction threshold: number of new
   * messages (since the last extraction) beyond which automatic extraction triggers.
   * Users can override it with their own `memoryThreshold`. Default 6.
   */
  @Column({ type: 'int', default: 6 })
  autoMemoryThreshold: number;

  // ── Sandbox (arbitrary code/shell execution) ────────────────────────────────

  /**
   * Global master switch for the sandbox tool (`run_in_sandbox`). Default false:
   * it is the most powerful/risky capability of the system (arbitrary code), so it is
   * off until an admin explicitly enables it.
   */
  @Column({ type: 'boolean', default: false })
  sandboxEnabled: boolean;

  /**
   * Teams authorized to use the sandbox (besides admins, always allowed).
   * A user is authorized if they belong to at least one of these teams.
   */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  sandboxAllowedTeamIds: string[];

  /**
   * Projects authorized to use the sandbox: the tool is available in chats
   * linked to one of these projects.
   */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  sandboxAllowedProjectIds: string[];

  /**
   * Sandbox network policy:
   *   none     → no network (maximum isolation)
   *   internal → backend /internal/* API only, no WAN (default)
   *   internet → only allowlisted domains via the egress-proxy (like skills)
   *   open     → OPEN internet (ad-hoc curl/HTTP from arbitrary code; the open docker
   *              network must also be in BROKER_ALLOWED_NETWORKS).
   */
  @Column({ type: 'varchar', length: 10, default: 'none' })
  sandboxNetwork: 'none' | 'internal' | 'internet' | 'open';

  /**
   * Sandbox execution profile:
   *   hardened (default) → read-only rootfs, non-root uid, cap-drop ALL (max isolation).
   *   trusted            → writable rootfs + root + default caps, so the code can
   *                        `apt-get install` system libraries at runtime. It is a real
   *                        isolation DOWNGRADE: also requires the operator flag
   *                        BROKER_ALLOW_PRIVILEGED_SANDBOX=1 on the broker, and is only
   *                        advisable under gVisor (runsc) or a trusted single-tenant deploy.
   */
  @Column({ type: 'varchar', length: 10, default: 'hardened' })
  sandboxExecMode: 'hardened' | 'trusted';

  // ── DataSource anti-SSRF policy ─────────────────────────────────────────────

  /**
   * If true (default), DataSources/DB tools may target private/loopback/CGNAT
   * hosts (needed for self-hosted DBs on LAN/localhost). The cloud metadata
   * endpoint (169.254.169.254 / IPv6 link-local) is ALWAYS blocked regardless.
   * Set false to harden to public hosts only (+ the allowlist below) for
   * untrusted multi-tenant deployments.
   */
  @Column({ type: 'boolean', default: true })
  dataSourceAllowPrivateHosts: boolean;

  /**
   * Host/CIDR allowlist that is permitted even when dataSourceAllowPrivateHosts
   * is false (e.g. a specific internal DB host). Entries: hostname, IP, or CIDR.
   */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  dataSourceHostAllowlist: string[];

  @UpdateDateColumn()
  updatedAt: Date;
}
