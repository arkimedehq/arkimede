/**
 * @file llm-provider.service.ts
 *
 * Cache wrapper around LlmConfigsService.buildModelForConfig().
 * Builds and caches the LangChain model for the LLM config
 * marked as "default" in llm_configs.
 *
 * Depends on LlmConfigsService (which holds the build logic for
 * each provider). It is invalidated whenever the default changes.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { LlmConfigsService } from '../llm-configs/llm-configs.service';
import { LlmProvider } from './app-config.entity';

@Injectable()
export class LlmProviderService {
  private readonly logger = new Logger(LlmProviderService.name);
  private cachedModel: BaseChatModel | null = null;
  /** Identity of the cached model: `${config.id}:${config.updatedAt}`. */
  private cachedKey: string | null = null;

  constructor(
    @Inject(LlmConfigsService)
    private readonly llmConfigsService: LlmConfigsService,
  ) {}

  /**
   * Returns the current LLM model instance (default config).
   *
   * Self-healing cache: the config row is re-read on every call (one indexed
   * SELECT, negligible next to an LLM call) and the model is rebuilt whenever
   * the default config changes — id OR updatedAt. Historically invalidateCache()
   * had no callers, so edits to the default config silently kept serving the
   * stale model until a backend restart.
   */
  async getModel(): Promise<BaseChatModel> {
    const def = await this.llmConfigsService.getDefault();
    if (!def) {
      throw new Error('No LLM configuration found. Add one in the settings.');
    }
    const key = `${def.id}:${def.updatedAt?.toISOString?.() ?? ''}`;
    if (this.cachedModel && this.cachedKey === key) return this.cachedModel;
    this.cachedModel = await this.llmConfigsService.buildModelForConfig(def);
    this.cachedKey   = key;
    return this.cachedModel;
  }

  /**
   * Model to use for the history compaction summaries: the `isSummarizer`
   * config if designated, otherwise the default. Not cached: compaction
   * triggers rarely and building the instance involves no network I/O.
   */
  async getSummarizerModel(): Promise<BaseChatModel> {
    const cfg = await this.llmConfigsService.getSummarizer();
    if (!cfg) {
      throw new Error('No LLM configuration found for the summarizer.');
    }
    return this.llmConfigsService.buildModelForConfig(cfg);
  }

  /**
   * Invalidates the cache — call after every change to the default config.
   */
  invalidateCache(): void {
    if (this.cachedModel === null) return;
    this.cachedModel = null;
    this.cachedKey   = null;
    this.logger.log('Cache modello LLM invalidata');
  }

  /**
   * True if the default model requires `reasoning_content` in the history
   * (DeepSeek-R1, OpenAI o1/o3).
   */
  async isReasoningModel(): Promise<boolean> {
    const def = await this.llmConfigsService.getDefault();
    if (!def) return false;

    const provider  = def.provider;
    const modelName = (def.model ?? '').toLowerCase();

    if (provider === 'deepseek') return true;

    if (provider === 'openai') {
      return /^o[13](-|$)/.test(modelName) || modelName.startsWith('o1-');
    }

    return false;
  }

  /** Provider of the default config. */
  async getProvider(): Promise<LlmProvider> {
    const def = await this.llmConfigsService.getDefault();
    return (def?.provider ?? 'anthropic') as LlmProvider;
  }

  /** Provider + model name of the default config (to attribute the cost in usage). */
  async getProviderAndModel(): Promise<{ provider: LlmProvider; model: string | null }> {
    const def = await this.llmConfigsService.getDefault();
    return {
      provider: (def?.provider ?? 'anthropic') as LlmProvider,
      model: def?.model ?? null,
    };
  }
}
