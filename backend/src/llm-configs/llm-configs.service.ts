import {
  Injectable, Logger, NotFoundException, BadRequestException, Optional,
} from '@nestjs/common';
import { I18nContext } from 'nestjs-i18n';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { LlmConfigEntity } from './llm-config.entity';
import { LlmProvider } from '../app-config/app-config.entity';
import { encrypt, decrypt } from '../custom-tools/crypto.utils';
import { AuditService } from '../audit/audit.service';
import { LlmMetricsService } from '../usage/llm-metrics.service';
import { LlmDispatcherService } from '../usage/llm-dispatcher.service';

export interface CreateLlmConfigDto {
  name: string;
  provider: LlmProvider;
  model?: string | null;
  apiKey?: string | null;
  baseUrl?: string | null;
  maxTokens?: number | null;
  maxConcurrency?: number | null;
  inputPricePerM?: number | null;
  outputPricePerM?: number | null;
  cacheReadPricePerM?: number | null;
  cacheWritePricePerM?: number | null;
}

export interface UpdateLlmConfigDto extends Partial<CreateLlmConfigDto> {}

/** DTO returned by the API — apiKey masked with hasApiKey */
export interface LlmConfigDto {
  id: string;
  name: string;
  provider: LlmProvider;
  model: string | null;
  hasApiKey: boolean;
  baseUrl: string | null;
  maxTokens: number | null;
  maxConcurrency: number | null;
  inputPricePerM: number | null;
  outputPricePerM: number | null;
  cacheReadPricePerM: number | null;
  cacheWritePricePerM: number | null;
  isDefault: boolean;
  isSummarizer: boolean;
  isVision: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const PROVIDER_DEFAULTS: Record<LlmProvider, { model: string }> = {
  anthropic:           { model: 'claude-sonnet-4-6' },
  openai:              { model: 'gpt-4o' },
  gemini:              { model: 'gemini-2.0-flash' },
  ollama:              { model: 'llama3.2' },
  lmstudio:            { model: 'local-model' },
  'openai-compatible': { model: 'local-model' },
  deepseek:            { model: 'deepseek-chat' },
};

const DEFAULT_BASE_URLS: Partial<Record<LlmProvider, string>> = {
  ollama:   'http://localhost:11434',
  lmstudio: 'http://localhost:1234/v1',
  deepseek: 'https://api.deepseek.com/v1',
};

function toDto(e: LlmConfigEntity): LlmConfigDto {
  return {
    id:         e.id,
    name:       e.name,
    provider:   e.provider,
    model:      e.model,
    hasApiKey:  !!e.apiKey,
    baseUrl:    e.baseUrl,
    maxTokens:  e.maxTokens,
    maxConcurrency: e.maxConcurrency,
    inputPricePerM:  e.inputPricePerM != null ? Number(e.inputPricePerM) : null,
    outputPricePerM: e.outputPricePerM != null ? Number(e.outputPricePerM) : null,
    cacheReadPricePerM:  e.cacheReadPricePerM != null ? Number(e.cacheReadPricePerM) : null,
    cacheWritePricePerM: e.cacheWritePricePerM != null ? Number(e.cacheWritePricePerM) : null,
    isDefault:  e.isDefault,
    isSummarizer: e.isSummarizer,
    isVision:   e.isVision,
    createdAt:  e.createdAt,
    updatedAt:  e.updatedAt,
  };
}

@Injectable()
export class LlmConfigsService {
  private readonly logger = new Logger(LlmConfigsService.name);

  constructor(
    @InjectRepository(LlmConfigEntity)
    private readonly repo: Repository<LlmConfigEntity>,
    @Optional() private readonly audit?: AuditService,
    @Optional() private readonly metrics?: LlmMetricsService,
    @Optional() private readonly dispatcher?: LlmDispatcherService,
  ) {}

  // ── CRUD ──────────────────────────────────────────────────────────────────

  async list(): Promise<LlmConfigDto[]> {
    const rows = await this.repo.find({ order: { isDefault: 'DESC', createdAt: 'ASC' } });
    return rows.map(toDto);
  }

  async findOne(id: string): Promise<LlmConfigEntity> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) throw new NotFoundException(
      I18nContext.current()?.t('llmConfigs.notFound', { args: { id } }) ?? `LlmConfig "${id}" not found`,
    );
    return row;
  }

  async create(dto: CreateLlmConfigDto, actorId?: string): Promise<LlmConfigDto> {
    const count = await this.repo.count();

    const encryptedKey = dto.apiKey?.trim()
      ? encrypt(dto.apiKey.trim())
      : null;

    const entity = this.repo.create({
      name:      dto.name.trim(),
      provider:  dto.provider,
      model:     dto.model?.trim() || null,
      apiKey:    encryptedKey,
      baseUrl:   dto.baseUrl?.trim() || null,
      maxTokens: dto.maxTokens ?? null,
      maxConcurrency: dto.maxConcurrency ?? null,
      inputPricePerM:  dto.inputPricePerM ?? null,
      outputPricePerM: dto.outputPricePerM ?? null,
      cacheReadPricePerM:  dto.cacheReadPricePerM ?? null,
      cacheWritePricePerM: dto.cacheWritePricePerM ?? null,
      isDefault: count === 0,  // first inserted → becomes default
    });

    const saved = await this.repo.save(entity);
    this.logger.log(`LlmConfig creata: "${saved.name}" (${saved.provider})${saved.isDefault ? ' [default]' : ''}`);
    await this.audit?.record({
      actorId: actorId ?? null,
      action: 'llmconfig.create',
      resource: saved.name,
      outcome: 'ok',
      ctx: { id: saved.id, provider: saved.provider, model: saved.model, isDefault: saved.isDefault },
    });
    return toDto(saved);
  }

  async update(id: string, dto: UpdateLlmConfigDto, actorId?: string): Promise<LlmConfigDto> {
    const entity = await this.findOne(id);

    if (dto.name !== undefined)      entity.name     = dto.name.trim();
    if (dto.provider !== undefined)  entity.provider = dto.provider;
    if (dto.model !== undefined)     entity.model    = dto.model?.trim() || null;
    if (dto.baseUrl !== undefined)   entity.baseUrl  = dto.baseUrl?.trim() || null;
    if (dto.maxTokens !== undefined) entity.maxTokens = dto.maxTokens ?? null;
    if (dto.maxConcurrency !== undefined) entity.maxConcurrency = dto.maxConcurrency ?? null;
    if (dto.inputPricePerM !== undefined)  entity.inputPricePerM  = dto.inputPricePerM ?? null;
    if (dto.outputPricePerM !== undefined) entity.outputPricePerM = dto.outputPricePerM ?? null;
    if (dto.cacheReadPricePerM !== undefined)  entity.cacheReadPricePerM  = dto.cacheReadPricePerM ?? null;
    if (dto.cacheWritePricePerM !== undefined) entity.cacheWritePricePerM = dto.cacheWritePricePerM ?? null;

    if (dto.apiKey === null) {
      entity.apiKey = null;  // remove key
    } else if (dto.apiKey?.trim()) {
      entity.apiKey = encrypt(dto.apiKey.trim());  // new key
    }
    // dto.apiKey undefined → leave untouched

    const saved = await this.repo.save(entity);
    this.logger.log(`LlmConfig updated: "${saved.name}"`);
    await this.audit?.record({
      actorId: actorId ?? null,
      action: 'llmconfig.update',
      resource: saved.name,
      outcome: 'ok',
      ctx: { id: saved.id, provider: saved.provider, model: saved.model, isDefault: saved.isDefault },
    });
    return toDto(saved);
  }

  async remove(id: string, actorId?: string): Promise<void> {
    const entity = await this.findOne(id);
    const count  = await this.repo.count();

    if (count <= 1) {
      throw new BadRequestException('llmConfigs.cannotDeleteLast');
    }

    const removedId = entity.id;
    await this.repo.remove(entity);
    await this.audit?.record({
      actorId: actorId ?? null,
      action: 'llmconfig.delete',
      resource: entity.name,
      outcome: 'ok',
      ctx: { id: removedId, provider: entity.provider, model: entity.model, isDefault: entity.isDefault },
    });

    // If it was the default, promote the oldest remaining one.
    // NB: repo.findOne() requires a `where` clause (throws "You must provide selection
    // conditions" otherwise) — use find({ take: 1 }) to fetch the first by order.
    if (entity.isDefault) {
      const [oldest] = await this.repo.find({ order: { createdAt: 'ASC' }, take: 1 });
      if (oldest) {
        oldest.isDefault = true;
        await this.repo.save(oldest);
        this.logger.log(`LlmConfig default promossa: "${oldest.name}"`);
      }
    }

    this.logger.log(`LlmConfig deleted: "${entity.name}"`);
  }

  async setDefault(id: string): Promise<LlmConfigDto[]> {
    const entity = await this.findOne(id);

    // Reset the current default, then set the new one.
    // Non-empty criterion: TypeORM forbids update({}) — we filter the rows already at true.
    await this.repo.update({ isDefault: true }, { isDefault: false });
    entity.isDefault = true;
    await this.repo.save(entity);

    this.logger.log(`LlmConfig default impostata: "${entity.name}" (${entity.provider})`);
    return this.list();
  }

  /**
   * Designates the config to use for history compaction summaries.
   * Invariant: only one `isSummarizer = true`. Passing `null` clears the
   * designation (compaction will use the `isDefault` config).
   */
  async setSummarizer(id: string | null): Promise<LlmConfigDto[]> {
    // Non-empty criterion: TypeORM forbids update({}) — resets only the rows at true.
    await this.repo.update({ isSummarizer: true }, { isSummarizer: false });
    if (id) {
      const entity = await this.findOne(id);
      entity.isSummarizer = true;
      await this.repo.save(entity);
      this.logger.log(`LlmConfig summarizer impostata: "${entity.name}" (${entity.provider})`);
    } else {
      this.logger.log('LlmConfig summarizer cleared (will use the default)');
    }
    return this.list();
  }

  /**
   * Designates the config to use for vision/multimodal tasks (e.g. image OCR).
   * Invariant: only one `isVision = true`. Passing `null` clears the
   * designation (vision tasks will use the `isDefault` config).
   */
  async setVision(id: string | null): Promise<LlmConfigDto[]> {
    // Non-empty criterion: TypeORM forbids update({}) — resets only the rows at true.
    await this.repo.update({ isVision: true }, { isVision: false });
    if (id) {
      const entity = await this.findOne(id);
      entity.isVision = true;
      await this.repo.save(entity);
      this.logger.log(`LlmConfig vision impostata: "${entity.name}" (${entity.provider})`);
    } else {
      this.logger.log('LlmConfig vision cleared (will use the default)');
    }
    return this.list();
  }

  // ── Reads for internal services ───────────────────────────────────────────

  /** Returns the default record (full entity, with encrypted apiKey). */
  async getDefault(): Promise<LlmConfigEntity | null> {
    return this.repo.findOne({ where: { isDefault: true } });
  }

  /**
   * Config to use for vision/multimodal tasks: the designated `isVision`,
   * otherwise fallback to `isDefault`. null only if the table is empty.
   */
  async getVision(): Promise<LlmConfigEntity | null> {
    return (
      (await this.repo.findOne({ where: { isVision: true } })) ??
      (await this.getDefault())
    );
  }

  /**
   * Config to use for summaries: the designated `isSummarizer`, otherwise
   * fallback to `isDefault`. null only if the table is empty.
   */
  async getSummarizer(): Promise<LlmConfigEntity | null> {
    return (
      (await this.repo.findOne({ where: { isSummarizer: true } })) ??
      (await this.getDefault())
    );
  }

  /** Decrypts and returns the default config's API key (internal use only). */
  async getDefaultRawApiKey(): Promise<string | null> {
    const def = await this.getDefault();
    if (!def?.apiKey) return null;
    try {
      return decrypt(def.apiKey);
    } catch {
      return null;
    }
  }

  /** Decrypts and returns the API key of a specific config (internal use only). */
  async getRawApiKey(entity: LlmConfigEntity): Promise<string | null> {
    if (!entity.apiKey) return null;
    try {
      return decrypt(entity.apiKey);
    } catch {
      return null;
    }
  }

  // ── Build LangChain model ─────────────────────────────────────────────────

  /**
   * Builds a LangChain instance for the given config.
   * Used by LlmProviderService (for the default), by the test endpoint and by the
   * Prompt executor (custom tool), which passes per-call overrides.
   *
   * @param overrides - Parameters that take precedence over the config values.
   *   `maxTokens` overrides the record default; `temperature` is applied
   *   only if defined (otherwise the provider default is used, behavior
   *   unchanged for the main agent).
   */
  async buildModelForConfig(
    entity: LlmConfigEntity,
    overrides?: { maxTokens?: number; temperature?: number; maxRetries?: number; streaming?: boolean },
  ): Promise<BaseChatModel> {
    const model = await this.instantiateModelForConfig(entity, overrides);
    // Serving metrics (P2): one handler per built model, latency/tokens/errors
    // recorded per call in llm_calls. Models are cached upstream → the handler
    // lives as long as the model; per-run state is keyed by runId.
    if (this.metrics) {
      const handler = this.metrics.createHandler({
        llmConfigId: entity.id ?? null,
        provider:    entity.provider,
        model:       entity.model ?? null,
      });
      (model as any).callbacks = [
        ...(Array.isArray((model as any).callbacks) ? (model as any).callbacks : []),
        handler,
      ];
    }
    // Request scheduler (P1): per-config concurrency cap; pass-through when
    // maxConcurrency is null (unlimited — the default for cloud providers).
    // register() feeds the prototype-level gate: bindTools CLONES the model,
    // so nothing attached to this instance would survive into the agent graph.
    if (this.dispatcher && entity.id) {
      this.dispatcher.register(model, {
        llmConfigId: entity.id,
        maxConcurrency: entity.maxConcurrency ?? null,
      });
    }
    return model;
  }

  private async instantiateModelForConfig(
    entity: LlmConfigEntity,
    overrides?: { maxTokens?: number; temperature?: number; maxRetries?: number; streaming?: boolean },
  ): Promise<BaseChatModel> {
    const provider  = entity.provider;
    const maxTokens = overrides?.maxTokens ?? entity.maxTokens ?? 4096;
    const apiKey    = await this.getRawApiKey(entity) ?? undefined;
    const modelName = entity.model ?? PROVIDER_DEFAULTS[provider]?.model;

    // Applied only if explicitly provided: this way the main agent's path
    // (no override) keeps the current default behavior.
    const tempOpt = overrides?.temperature !== undefined
      ? { temperature: overrides.temperature }
      : {};

    // Extra options spread into every provider constructor. Empty on the agent
    // path (no override), so nothing changes there. `streaming` overrides the
    // per-case default because it is spread AFTER it. maxRetries must be set at
    // construction time — LangChain freezes its retry policy into an internal
    // AsyncCaller in the constructor, so mutating the instance later is ignored.
    const common: Record<string, any> = {
      ...(overrides?.maxRetries !== undefined ? { maxRetries: overrides.maxRetries } : {}),
      ...(overrides?.streaming   !== undefined ? { streaming:  overrides.streaming  } : {}),
    };

    const CLOUD_FIXED: LlmProvider[] = ['anthropic', 'openai', 'gemini'];
    const baseUrl = CLOUD_FIXED.includes(provider)
      ? undefined
      : (entity.baseUrl ?? DEFAULT_BASE_URLS[provider]);

    this.logger.log(`buildModel: provider=${provider} model=${modelName}${baseUrl ? ` url=${baseUrl}` : ''}`);

    switch (provider) {
      case 'anthropic': {
        const { ChatAnthropic } = require('@langchain/anthropic');
        return new ChatAnthropic({
          apiKey: apiKey ?? '',
          model: modelName, streaming: true, maxTokens, ...tempOpt,
          invocationKwargs: { top_p: undefined },
          ...common,
        });
      }
      case 'openai': {
        const { ChatOpenAI } = require('@langchain/openai');
        return new ChatOpenAI({
          apiKey: apiKey ?? '',
          model: modelName, streaming: true, maxTokens, ...tempOpt, ...common,
        });
      }
      case 'gemini': {
        const { ChatGoogleGenerativeAI } = require('@langchain/google-genai');
        return new ChatGoogleGenerativeAI({
          apiKey: apiKey ?? '',
          model: modelName, streaming: true, maxOutputTokens: maxTokens, ...tempOpt, ...common,
        });
      }
      case 'ollama': {
        const { ChatOllama } = require('@langchain/ollama');
        // Local Ollama has no native auth, but behind a reverse-proxy (or ollama.com
        // cloud) a Bearer token is used: if configured we send it as a header.
        return new ChatOllama({
          model: modelName, baseUrl: baseUrl ?? 'http://localhost:11434', numPredict: maxTokens, ...tempOpt, ...common,
          ...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
        });
      }
      case 'deepseek': {
        const { ChatOpenAI } = require('@langchain/openai');
        const logger = this.logger;
        const fetchWithReasoning = async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          if (init?.body && typeof init.body === 'string') {
            try {
              const body = JSON.parse(init.body);
              if (Array.isArray(body.messages)) {
                let injected = 0;
                body.messages = body.messages.map((msg: any) => {
                  if (msg.role === 'assistant' && msg.reasoning_content === undefined) {
                    injected++;
                    return { ...msg, reasoning_content: '' };
                  }
                  return msg;
                });
                if (injected > 0) {
                  logger.debug(`DeepSeek fetch: injected reasoning_content on ${injected} message(s)`);
                  init = { ...init, body: JSON.stringify(body) };
                }
              }
            } catch { /* non-JSON body */ }
          }
          return fetch(url as any, init as any);
        };
        return new ChatOpenAI({
          apiKey: apiKey ?? '',
          model: modelName, streaming: true, maxTokens, ...tempOpt, ...common,
          configuration: { baseURL: baseUrl ?? 'https://api.deepseek.com/v1', fetch: fetchWithReasoning },
        });
      }
      case 'lmstudio':
      case 'openai-compatible': {
        const { ChatOpenAI } = require('@langchain/openai');
        return new ChatOpenAI({
          apiKey: apiKey ?? 'lm-studio',
          model: modelName, streaming: true, maxTokens, ...tempOpt, ...common,
          configuration: { baseURL: baseUrl ?? 'http://localhost:1234/v1' },
        });
      }
      default:
        // The provider enum is exhaustive: this is reached only with corrupted data in llm_configs.
        throw new Error(`Provider LLM sconosciuto: "${provider}"`);
    }
  }

  /** Duration after which a connection test is aborted (ms). */
  private static readonly TEST_TIMEOUT_MS = 20_000;

  /** Tests the connection for a specific config. */
  async testConnection(id: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const entity = await this.findOne(id);
      // A connection test must fail fast. In production the model retries ~6× with
      // exponential backoff, so a 429 / quota error keeps the request open for
      // ~100s and the UI (which times out sooner) shows no result at all. Build a
      // test-only model with retries disabled and streaming off — a streaming 429
      // otherwise holds the SSE channel open — so the real provider error surfaces
      // in seconds. maxRetries must be set at construction: LangChain freezes it
      // into an internal AsyncCaller, so mutating the instance afterwards is ignored.
      const model = await this.buildModelForConfig(entity, { maxRetries: 0, streaming: false });

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), LlmConfigsService.TEST_TIMEOUT_MS);
      try {
        await model.invoke('Reply only with "ok"', { signal: ac.signal });
      } finally {
        clearTimeout(timer);
      }
      return { ok: true };
    } catch (err: any) {
      const msg = isAbortError(err)
        ? `No response within ${LlmConfigsService.TEST_TIMEOUT_MS / 1000}s (the provider did not answer in time).`
        : (err?.message ?? String(err));
      return { ok: false, error: msg };
    }
  }
}

/** True when the error is an AbortController timeout (name/message varies by runtime). */
function isAbortError(err: any): boolean {
  return err?.name === 'AbortError'
    || /aborted/i.test(err?.message ?? '');
}
