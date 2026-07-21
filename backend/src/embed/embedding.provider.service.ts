/**
 * @file embedding.provider.service.ts
 *
 * Multi-provider abstraction for generating vector embeddings.
 *
 * The system supports five interchangeable backends via the configuration
 * saved in the database (admin → Settings → Vector DB → Embedding Configuration):
 *   - "openai"           → OpenAI cloud API (text-embedding-3-*)
 *   - "voyage"           → VoyageAI API (voyage-multilingual-2, etc.)
 *   - "ollama"           → local models via Ollama
 *   - "lmstudio"         → local models via LM Studio (OpenAI-compatible)
 *   - "openai-compatible"→ any server with an OpenAI-compatible API
 *
 * Fallback: if the configuration is not present in the DB, the environment
 * variables (EMBEDDING_PROVIDER, EMBEDDING_MODEL, etc.) are used for backward compatibility.
 *
 * Cache: the client is rebuilt lazily and invalidated via invalidateCache()
 * when the admin saves a new configuration.
 *
 * Notes on the OpenAI SDK ≥ 4.25 / base64 bug:
 *   The SDK sends encoding_format=base64 by default; local servers return
 *   float but the SDK interprets them as a raw binary buffer → wrong size.
 *   All methods explicitly use encoding_format='float'.
 */
import { forwardRef, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { VoyageAIClient } from 'voyageai';
import { EmbeddingProvider } from '../app-config/app-config.entity';
import { AppConfigService } from '../app-config/app-config.service';

/** Runtime configuration of the embedding provider (read from DB or env). */
interface EmbeddingRuntimeConfig {
  provider:     EmbeddingProvider;
  model:        string;
  apiKey:       string | null;
  baseUrl:      string | null;
  vectorSize:   number;
  queryPrefix:  string;
  docPrefix:    string;
  chunkSize:    number;
  chunkOverlap: number;
}

/** Model defaults when not specified in the DB. */
const MODEL_DEFAULTS: Record<EmbeddingProvider, string> = {
  internal:           'mixedbread-ai/mxbai-embed-large-v1',
  openai:             'text-embedding-3-small',
  voyage:             'voyage-multilingual-2',
  ollama:             'nomic-embed-text',
  lmstudio:           'nomic-embed-text',
  'openai-compatible': 'nomic-embed-text',
};

const DEFAULT_BASE_URLS: Partial<Record<EmbeddingProvider, string>> = {
  internal:           'http://localhost:8000/v1',
  ollama:             'http://localhost:11434/v1',
  lmstudio:           'http://localhost:1234/v1',
  'openai-compatible': 'http://localhost:1234/v1',
};

/** Type of the active cached client. */
interface CachedClient {
  config:        EmbeddingRuntimeConfig;
  openaiClient?: OpenAI;
  voyageClient?: VoyageAIClient;
}

@Injectable()
export class EmbeddingProviderService {
  private readonly logger = new Logger(EmbeddingProviderService.name);

  /**
   * Cache of the active client. Cleared by invalidateCache() when
   * the admin saves a new embedding configuration.
   */
  private cachedClient: CachedClient | null = null;

  constructor(
    @Inject(ConfigService)
    private readonly cfg: ConfigService,

    /**
     * AppConfigService is Optional + forwardRef to handle the circular dependency:
     * AppConfigModule ↔ EmbedModule. If null (test), the environment variables are used.
     */
    @Optional() @Inject(forwardRef(() => AppConfigService))
    private readonly appConfigService: AppConfigService | null,
  ) {}

  // ── Cache & invalidation ──────────────────────────────────────────────────

  /**
   * Invalidates the embedding client cache.
   * Idempotent: if the cache is already empty it does nothing.
   * Call after every update of the embedding configuration.
   */
  invalidateCache(): void {
    if (this.cachedClient === null) return;
    this.cachedClient = null;
    this.logger.log('Embedding provider cache invalidated');
  }

  /**
   * Vector dimension of the active model.
   * Returns the value from the cache (if available) or from the DB/env configuration.
   * Does not block on I/O if the cache is already available.
   */
  get vectorSize(): number {
    return this.cachedClient?.config.vectorSize
      ?? parseInt(this.cfg.get('EMBEDDING_VECTOR_SIZE', '1024'), 10);
  }

  /**
   * Async-safe vector dimension: forces the client to be built (resolving the
   * current DB config) before returning, so the value always reflects the active
   * embedding provider — never the stale ENV fallback.
   *
   * Use this instead of the `vectorSize` getter wherever a collection's dimension
   * is being SET (ensure/recreate). The synchronous getter returns the ENV default
   * whenever the cache was just invalidated (e.g. right after an admin changes the
   * embedding provider, or on the very first operation after boot), which would
   * otherwise create a mis-dimensioned collection and make every upsert fail.
   */
  async getVectorSize(): Promise<number> {
    const client = await this.getClient();
    return client.config.vectorSize;
  }

  // ── Client construction ─────────────────────────────────────────────────────

  /** Returns the cached client, building it if necessary. */
  private async getClient(): Promise<CachedClient> {
    if (this.cachedClient) return this.cachedClient;

    const config = await this.resolveConfig();
    const client = this.buildClient(config);
    this.cachedClient = client;
    this.logger.log(
      `Embedding: provider=${config.provider} model=${config.model} dims=${config.vectorSize}`,
    );
    return client;
  }

  /** Query prefix as configured in the UI (empty = not set). */
  private resolveQueryPrefix(dbValue: string | null | undefined): string {
    return (dbValue ?? '').replace(/\\n/g, '\n');
  }

  /**
   * Retrieval models are asymmetric: the query carries an instruction, the indexed document
   * does not. For the bundled 'internal' service we don't hardcode that instruction — we tag
   * the side (`input_type`) and the service applies the prompt the loaded MODEL declares.
   *
   * A prefix configured in the UI WINS: it is prepended here (see `embed`), and we then leave
   * `input_type` off so the service adds nothing on top of it — no double prompt.
   * `input_type` is an extension to the OpenAI schema, sent only to our own service.
   */
  private inputTypeFor(
    config: EmbeddingRuntimeConfig,
    side: 'query' | 'document',
  ): Record<string, string> {
    if (config.provider !== 'internal') return {};
    if (side === 'query' && config.queryPrefix) return {};
    return { input_type: side };
  }

  /**
   * Resolves the runtime configuration reading first from the DB, then from the env vars
   * as a fallback for backward compatibility.
   */
  private async resolveConfig(): Promise<EmbeddingRuntimeConfig> {
    if (this.appConfigService) {
      try {
        const dbConfig = await this.appConfigService.getEmbeddingConfig();

        // ── Provider 'internal': embedding service included in the app ──────────
        // URL from the deployment (env), model and dimensions auto-detected by the
        // service itself (probing /v1/models). Nothing to configure by hand.
        if (dbConfig.embeddingProvider === 'internal') {
          const baseUrl = this.cfg.get('EMBEDDING_BASE_URL', DEFAULT_BASE_URLS.internal!);
          const probed = await this.probeInternal(baseUrl);
          return {
            provider:    'internal',
            model:       probed?.model ?? dbConfig.embeddingModel ?? MODEL_DEFAULTS.internal,
            apiKey:      null,
            baseUrl,
            vectorSize:  probed?.dims ?? dbConfig.embeddingVectorSize,
            queryPrefix: this.resolveQueryPrefix(dbConfig.embeddingQueryPrefix),
            docPrefix:   '',
            chunkSize:   dbConfig.embeddingChunkSize,
            chunkOverlap: dbConfig.embeddingChunkOverlap,
          };
        }

        const apiKeyRaw = dbConfig.hasEmbeddingApiKey
          ? await this.appConfigService.getRawEmbeddingApiKey()
          : null;

        return {
          provider:    dbConfig.embeddingProvider,
          model:       dbConfig.embeddingModel ?? MODEL_DEFAULTS[dbConfig.embeddingProvider],
          apiKey:      apiKeyRaw,
          baseUrl:     dbConfig.embeddingBaseUrl ?? DEFAULT_BASE_URLS[dbConfig.embeddingProvider] ?? null,
          vectorSize:  dbConfig.embeddingVectorSize,
          queryPrefix: this.resolveQueryPrefix(dbConfig.embeddingQueryPrefix),
          docPrefix:   '',   // docPrefix is not exposed in the UI (used only internally)
          chunkSize:   dbConfig.embeddingChunkSize,
          chunkOverlap: dbConfig.embeddingChunkOverlap,
        };
      } catch (err) {
        this.logger.warn(`Unable to read embedding config from DB: ${err.message} — using env vars`);
      }
    }

    // Fallback to environment variables (backward compatibility)
    return this.resolveConfigFromEnv();
  }

  /** Reads the configuration from the environment variables (backward-compatible fallback). */
  private resolveConfigFromEnv(): EmbeddingRuntimeConfig {
    const provider = this.cfg.get<string>('EMBEDDING_PROVIDER', 'lmstudio') as EmbeddingProvider;
    const model    = this.cfg.get('EMBEDDING_MODEL', MODEL_DEFAULTS[provider] ?? 'nomic-embed-text');

    return {
      provider,
      model,
      // API keys live ONLY in the UI config (app_config, encrypted): this
      // fallback covers the bootstrap with local providers, which do not require them.
      apiKey: null,
      baseUrl:     this.cfg.get('EMBEDDING_BASE_URL', DEFAULT_BASE_URLS[provider] ?? 'http://localhost:1234/v1'),
      vectorSize:  parseInt(this.cfg.get('EMBEDDING_VECTOR_SIZE', '1024'), 10),
      queryPrefix: this.cfg.get('EMBEDDING_QUERY_PREFIX', '').replace(/\\n/g, '\n'),
      docPrefix:   this.cfg.get('EMBEDDING_DOC_PREFIX', '').replace(/\\n/g, '\n'),
      chunkSize:   parseInt(this.cfg.get('EMBED_CHUNK_SIZE', '500'), 10),
      chunkOverlap: parseInt(this.cfg.get('EMBED_CHUNK_OVERLAP', '50'), 10),
    };
  }

  /**
   * Probes the internal embedding service to auto-detect the model and vector
   * dimensions. Best-effort: on error/timeout it returns null and the caller
   * falls back to the saved values (vectorSize) — no exceptions that would block the embed.
   */
  private async probeInternal(baseUrl: string): Promise<{ model: string; dims: number } | null> {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) return null;
      const json: any = await res.json();
      const entry = json?.data?.[0];
      const dims = Number(entry?.dims);
      // Requires valid id + dims: wrong dims would break the Qdrant collections.
      if (!entry?.id || !Number.isFinite(dims) || dims <= 0) return null;
      return { model: entry.id, dims };
    } catch {
      return null;
    }
  }

  /** Builds the OpenAI/Voyage client based on the resolved configuration. */
  private buildClient(config: EmbeddingRuntimeConfig): CachedClient {
    if (config.provider === 'voyage') {
      return {
        config,
        voyageClient: new VoyageAIClient({ apiKey: config.apiKey ?? '' }),
      };
    }

    // For all OpenAI-compatible providers (openai, ollama, lmstudio, openai-compatible)
    let baseURL = config.provider === 'openai'
      ? undefined   // OpenAI uses its default endpoint
      : (config.baseUrl ?? DEFAULT_BASE_URLS[config.provider] ?? 'http://localhost:1234/v1');

    // Ollama serves its OpenAI-compatible API exclusively under /v1 (the root is the
    // native /api). The OpenAI SDK appends "/embeddings" to baseURL, so a base without
    // /v1 (e.g. "http://host:11434", which is what users naturally enter) would 404.
    if (config.provider === 'ollama' && baseURL && !/\/v1\/?$/.test(baseURL)) {
      baseURL = `${baseURL.replace(/\/$/, '')}/v1`;
    }

    return {
      config,
      openaiClient: new OpenAI({
        apiKey:  config.apiKey ?? (config.provider === 'openai' ? '' : 'lm-studio'),
        ...(baseURL ? { baseURL } : {}),
      }),
    };
  }

  // ── Chunking properties (read from config) ───────────────────────────────

  /**
   * Current chunk size (from DB or env).
   * EmbedService reads this value to split the text.
   */
  async getChunkSize(): Promise<number> {
    const client = await this.getClient();
    return client.config.chunkSize;
  }

  async getChunkOverlap(): Promise<number> {
    const client = await this.getClient();
    return client.config.chunkOverlap;
  }

  // ── Embedding ──────────────────────────────────────────────────────────────

  /**
   * Generates the embedding of a single string (typically a search **query**).
   *
   * For Voyage it uses inputType='query'.
   * For OpenAI-compatible providers it prepends queryPrefix if configured.
   *
   * @param text - Text to embed
   * @returns Numeric vector of size vectorSize
   */
  async embed(text: string): Promise<number[]> {
    const { config, openaiClient, voyageClient } = await this.getClient();

    if (config.provider === 'voyage') {
      const res = await voyageClient!.embed({
        input: text, model: config.model, inputType: 'query',
      });
      return res.data![0].embedding!;
    }

    const input = config.queryPrefix ? config.queryPrefix + text : text;
    const embedParams: Record<string, any> = {
      model: config.model,
      input,
      encoding_format: 'float', // Explicit to avoid the base64 bug with local servers
      ...this.inputTypeFor(config, 'query'),
    };
    if (config.provider === 'openai') embedParams.dimensions = config.vectorSize;

    const res = await openaiClient!.embeddings.create(embedParams as any);
    return res.data[0].embedding as number[];
  }

  /**
   * Generates embeddings for a batch of texts using the **queryPrefix** (identical to `embed`
   * but for multiple texts in a single API call).
   *
   * Used by ToolSelectionService to embed the user query + the descriptions of the
   * tools not yet cached with a single HTTP request instead of N sequential requests.
   *
   * @param texts - Array of texts (query + tool descriptions) to embed
   * @returns Array of vectors in the original order
   */
  async embedBatchQuery(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (texts.length === 1) return [await this.embed(texts[0])];

    const { config, openaiClient, voyageClient } = await this.getClient();

    if (config.provider === 'voyage') {
      const res = await voyageClient!.embed({
        input: texts, model: config.model, inputType: 'query',
      });
      return res.data!.map((d) => d.embedding!);
    }

    const inputs = config.queryPrefix ? texts.map((t) => config.queryPrefix + t) : texts;
    const batchParams: Record<string, any> = {
      model:           config.model,
      input:           inputs,
      encoding_format: 'float',
      ...this.inputTypeFor(config, 'query'),
    };
    if (config.provider === 'openai') batchParams.dimensions = config.vectorSize;

    const res = await openaiClient!.embeddings.create(batchParams as any);
    // The OpenAI API returns the results ordered by index
    const sorted = [...res.data].sort((a, b) => a.index - b.index);
    return sorted.map((d) => d.embedding as number[]);
  }

  /**
   * Generates embeddings for a batch of texts (typically **documents** to index).
   *
   * @param texts - Array of texts to embed
   * @returns Array of vectors in the original order
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    const { config, openaiClient, voyageClient } = await this.getClient();

    if (config.provider === 'voyage') {
      const res = await voyageClient!.embed({
        input: texts, model: config.model, inputType: 'document',
      });
      return res.data!.map((d) => d.embedding!);
    }

    const inputs = config.docPrefix ? texts.map((t) => config.docPrefix + t) : texts;
    const batchParams: Record<string, any> = {
      model: config.model,
      input: inputs,
      encoding_format: 'float',
      ...this.inputTypeFor(config, 'document'),
    };
    if (config.provider === 'openai') batchParams.dimensions = config.vectorSize;

    const res = await openaiClient!.embeddings.create(batchParams as any);
    return res.data.map((d) => d.embedding as number[]);
  }

  /**
   * Tests the connection to the configured embedding provider.
   * Invalidates the cache before testing to use the most recent config.
   *
   * @returns `{ ok: true }` if the provider responds, `{ ok: false, error }` otherwise.
   */
  async testConnection(): Promise<{ ok: boolean; error?: string; model?: string; dims?: number }> {
    try {
      const vec = await this.embed('test');
      const { config } = await this.getClient();
      return { ok: true, model: config.model, dims: vec.length };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  }
}
