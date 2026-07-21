import { Injectable, Logger, OnModuleInit, Inject, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AppConfigEntity, EmbeddingProvider, ToolLoadingStrategy, ToolSchemaFormat, TranscriptionProvider } from './app-config.entity';
import { SYSTEM_PROMPT } from '../prompts/prompts';
import { encrypt, decrypt } from '../custom-tools/crypto.utils';
import { LlmConfigsService } from '../llm-configs/llm-configs.service';
import { AuditService } from '../audit/audit.service';

const CONFIG_ID = 1;

export interface ToolLoadingConfigDto {
  toolLoadingStrategy: ToolLoadingStrategy;
  toolLoadingMaxTools: number;
  toolSchemaFormat:    ToolSchemaFormat;
  /** Conversation history token limit (global default). */
  maxHistoryTokens:    number;
  /** If true, beyond the threshold the old turns are summarized instead of discarded. */
  historyCompactionEnabled: boolean;
  /** % of maxHistoryTokens beyond which compaction triggers (50–95). */
  historyCompactionThreshold: number;
  /** Global default of the user-memory extraction threshold (no. of new messages). */
  autoMemoryThreshold: number;
}

export interface SandboxConfigDto {
  /** Global master switch for the sandbox tool. Default false. */
  sandboxEnabled: boolean;
  /** Authorized teams (besides admins). */
  sandboxAllowedTeamIds: string[];
  /** Authorized projects. */
  sandboxAllowedProjectIds: string[];
  /** Network tier: none | internal (backend) | internet (allowlist) | open (full internet). */
  sandboxNetwork: 'none' | 'internal' | 'internet' | 'open';
  /** Execution profile: hardened (isolated, default) | trusted (writable rootfs + root). */
  sandboxExecMode: 'hardened' | 'trusted';
}

export interface DataSourceSecurityConfigDto {
  /** Allow DataSources to target private/loopback/CGNAT hosts (metadata always blocked). */
  dataSourceAllowPrivateHosts: boolean;
  /** Host/IP/CIDR allowed even when private hosts are disallowed. */
  dataSourceHostAllowlist: string[];
}

export interface EmbeddingConfigDto {
  embeddingProvider:   EmbeddingProvider;
  embeddingModel:      string | null;
  /** Plaintext key — encrypted before saving. Null = remove. Undefined = leave untouched. */
  embeddingApiKey?:    string | null;
  embeddingBaseUrl:    string | null;
  embeddingVectorSize: number;
  embeddingQueryPrefix: string | null;
  embeddingChunkSize:  number;
  embeddingChunkOverlap: number;
}

export interface TranscriptionConfigDto {
  transcriptionEnabled:  boolean;
  transcriptionProvider: TranscriptionProvider;
  transcriptionModel:    string | null;
  /** Plaintext key — encrypted before saving. Null = remove. Undefined = leave untouched. */
  transcriptionApiKey?:  string | null;
  transcriptionBaseUrl:  string | null;
}

@Injectable()
export class AppConfigService implements OnModuleInit {
  private readonly logger = new Logger(AppConfigService.name);

  /** In-memory cache of the base prompt — avoids a DB query on every request. */
  private cachedSystemPrompt: string | null = null;

  constructor(
    @InjectRepository(AppConfigEntity)
    private readonly repo: Repository<AppConfigEntity>,
    @Inject(LlmConfigsService)
    private readonly llmConfigsService: LlmConfigsService,
    @Optional() private readonly audit?: AuditService,
  ) {}

  /**
   * At boot: if the app_config table is empty, inserts the singleton row
   * with the value of SYSTEM_PROMPT as default (TypeScript file → DB).
   * This makes the first startup transparent: no prompt is lost.
   */
  async onModuleInit(): Promise<void> {
    const existing = await this.repo.findOne({ where: { id: CONFIG_ID } });
    if (!existing) {
      await this.repo.save({ id: CONFIG_ID, systemPrompt: SYSTEM_PROMPT });
      this.logger.log('AppConfig: singleton row created with default SYSTEM_PROMPT');
    } else {
      // Pre-warm cache at startup
      this.cachedSystemPrompt = existing.systemPrompt;
      this.logger.log('AppConfig: configuration loaded');
    }
  }

  // ── System Prompt ──────────────────────────────────────────────────────────

  /**
   * Returns the current base prompt.
   * First read: loads from the DB and populates the cache.
   * Subsequent reads: returns from the cache (no query).
   */
  async getSystemPrompt(): Promise<string> {
    if (this.cachedSystemPrompt !== null) return this.cachedSystemPrompt;

    const config = await this.repo.findOne({ where: { id: CONFIG_ID } });
    this.cachedSystemPrompt = config?.systemPrompt ?? SYSTEM_PROMPT;
    return this.cachedSystemPrompt;
  }

  /**
   * Updates the base prompt in the database and invalidates the cache.
   * The new value is immediately active for all subsequent requests.
   * Uses merge to preserve all other fields (LLM, embedding).
   */
  async updateSystemPrompt(prompt: string, actorId?: string): Promise<void> {
    const current = await this.repo.findOne({ where: { id: CONFIG_ID } });
    await this.repo.save({ ...current, id: CONFIG_ID, systemPrompt: prompt });
    this.cachedSystemPrompt = prompt;
    this.logger.log('AppConfig: base prompt updated');
    await this.audit?.record({
      actorId: actorId ?? null,
      action: 'appconfig.update',
      resource: 'app-config',
      outcome: 'ok',
      ctx: { changed: ['systemPrompt'] },
    });
  }

  // ── Full Config ────────────────────────────────────────────────────────────

  /** Returns the complete configuration row (including `updatedAt`). */
  async getConfig(): Promise<AppConfigEntity> {
    const config = await this.repo.findOne({ where: { id: CONFIG_ID } });
    // Should never be null thanks to onModuleInit, but a safe fallback
    if (!config) {
      return this.repo.save({ id: CONFIG_ID, systemPrompt: SYSTEM_PROMPT });
    }
    return config;
  }

  /**
   * Decrypts and returns the API key of the default LLM config (internal use only).
   * Used by CustomToolsService for the Prompt executor (Anthropic sub-call).
   * Delegates to LlmConfigsService.getDefaultRawApiKey().
   */
  async getRawApiKey(): Promise<string | null> {
    return this.llmConfigsService.getDefaultRawApiKey();
  }

  // ── Embedding Configuration ─────────────────────────────────────────────────

  /**
   * Returns the current embedding configuration.
   * embeddingApiKey is masked: only `hasEmbeddingApiKey` (boolean) is returned.
   */
  async getEmbeddingConfig(): Promise<{
    embeddingProvider:    EmbeddingProvider;
    embeddingModel:       string | null;
    hasEmbeddingApiKey:   boolean;
    embeddingBaseUrl:     string | null;
    embeddingVectorSize:  number;
    embeddingQueryPrefix: string | null;
    embeddingChunkSize:   number;
    embeddingChunkOverlap: number;
  }> {
    const config = await this.repo.findOne({ where: { id: CONFIG_ID } });
    return {
      embeddingProvider:     config?.embeddingProvider    ?? 'internal',
      embeddingModel:        config?.embeddingModel       ?? null,
      hasEmbeddingApiKey:    !!config?.embeddingApiKey,
      embeddingBaseUrl:      config?.embeddingBaseUrl     ?? null,
      embeddingVectorSize:   config?.embeddingVectorSize  ?? 1024,
      embeddingQueryPrefix:  config?.embeddingQueryPrefix ?? null,
      embeddingChunkSize:    config?.embeddingChunkSize   ?? 500,
      embeddingChunkOverlap: config?.embeddingChunkOverlap ?? 50,
    };
  }

  /**
   * Updates the embedding configuration.
   *
   * embeddingApiKey:
   *   - Non-empty string → encrypt and save
   *   - null              → clear the key
   *   - undefined         → leave the existing key untouched
   */
  async updateEmbeddingConfig(
    dto: EmbeddingConfigDto,
    actorId?: string,
  ): Promise<ReturnType<typeof this.getEmbeddingConfig>> {
    const current = await this.repo.findOne({ where: { id: CONFIG_ID } });

    let encryptedKey = current?.embeddingApiKey ?? null;

    if (dto.embeddingApiKey === null) {
      encryptedKey = null;
    } else if (typeof dto.embeddingApiKey === 'string' && dto.embeddingApiKey.trim() !== '') {
      encryptedKey = encrypt(dto.embeddingApiKey.trim());
    }

    await this.repo.save({
      id: CONFIG_ID,
      systemPrompt: current?.systemPrompt ?? SYSTEM_PROMPT,
      // New embedding values
      embeddingProvider:    dto.embeddingProvider,
      embeddingModel:       dto.embeddingModel    || null,
      embeddingApiKey:      encryptedKey,
      embeddingBaseUrl:     dto.embeddingBaseUrl  || null,
      embeddingVectorSize:  dto.embeddingVectorSize,
      embeddingQueryPrefix: dto.embeddingQueryPrefix || null,
      embeddingChunkSize:   dto.embeddingChunkSize,
      embeddingChunkOverlap: dto.embeddingChunkOverlap,
    });

    this.logger.log(`EmbeddingConfig: updated — provider=${dto.embeddingProvider}`);
    await this.audit?.record({
      actorId: actorId ?? null,
      action: 'appconfig.update',
      resource: 'embedding',
      outcome: 'ok',
      ctx: {
        section: 'embedding',
        provider: dto.embeddingProvider,
        apiKeyChanged: dto.embeddingApiKey !== undefined,
      },
    });
    return this.getEmbeddingConfig();
  }

  // ── Transcription Configuration (Whisper) ───────────────────────────────────

  /**
   * Returns the current transcription configuration.
   * transcriptionApiKey is masked: only `hasTranscriptionApiKey` (boolean).
   */
  async getTranscriptionConfig(): Promise<{
    transcriptionEnabled:    boolean;
    transcriptionProvider:   TranscriptionProvider;
    transcriptionModel:      string | null;
    hasTranscriptionApiKey:  boolean;
    transcriptionBaseUrl:    string | null;
  }> {
    const config = await this.repo.findOne({ where: { id: CONFIG_ID } });
    return {
      transcriptionEnabled:   config?.transcriptionEnabled  ?? true,
      transcriptionProvider:  config?.transcriptionProvider ?? 'internal',
      transcriptionModel:     config?.transcriptionModel    ?? null,
      hasTranscriptionApiKey: !!config?.transcriptionApiKey,
      transcriptionBaseUrl:   config?.transcriptionBaseUrl  ?? null,
    };
  }

  /**
   * Updates the transcription configuration.
   *
   * transcriptionApiKey:
   *   - Non-empty string → encrypt and save
   *   - null              → clear the key
   *   - undefined         → leave the existing key untouched
   */
  async updateTranscriptionConfig(
    dto: TranscriptionConfigDto,
    actorId?: string,
  ): Promise<ReturnType<typeof this.getTranscriptionConfig>> {
    const current = await this.repo.findOne({ where: { id: CONFIG_ID } });

    let encryptedKey = current?.transcriptionApiKey ?? null;
    if (dto.transcriptionApiKey === null) {
      encryptedKey = null;
    } else if (typeof dto.transcriptionApiKey === 'string' && dto.transcriptionApiKey.trim() !== '') {
      encryptedKey = encrypt(dto.transcriptionApiKey.trim());
    }

    await this.repo.save({
      ...current,
      id: CONFIG_ID,
      systemPrompt: current?.systemPrompt ?? SYSTEM_PROMPT,
      transcriptionEnabled:  dto.transcriptionEnabled,
      transcriptionProvider: dto.transcriptionProvider,
      transcriptionModel:    dto.transcriptionModel || null,
      transcriptionApiKey:   encryptedKey,
      transcriptionBaseUrl:  dto.transcriptionBaseUrl || null,
    });

    this.logger.log(`TranscriptionConfig: updated — provider=${dto.transcriptionProvider} enabled=${dto.transcriptionEnabled}`);
    await this.audit?.record({
      actorId: actorId ?? null,
      action: 'appconfig.update',
      resource: 'transcription',
      outcome: 'ok',
      ctx: {
        section: 'transcription',
        provider: dto.transcriptionProvider,
        enabled: dto.transcriptionEnabled,
        apiKeyChanged: dto.transcriptionApiKey !== undefined,
      },
    });
    return this.getTranscriptionConfig();
  }

  /**
   * Decrypts and returns the plaintext transcription API key (internal use only).
   * Used by TranscriptionService to build the OpenAI client.
   */
  async getRawTranscriptionApiKey(): Promise<string | null> {
    const config = await this.repo.findOne({ where: { id: CONFIG_ID } });
    if (!config?.transcriptionApiKey) return null;
    try {
      return decrypt(config.transcriptionApiKey);
    } catch {
      return null;
    }
  }

  // ── Tool Loading Configuration ─────────────────────────────────────────────

  /**
   * Returns the current tool loading configuration.
   * Used by AgentService as a fallback when the user has no override.
   */
  async getToolLoadingConfig(): Promise<ToolLoadingConfigDto> {
    const config = await this.repo.findOne({ where: { id: CONFIG_ID } });
    return {
      toolLoadingStrategy: config?.toolLoadingStrategy ?? 'always_inject_all',
      toolLoadingMaxTools: config?.toolLoadingMaxTools ?? 15,
      toolSchemaFormat:    config?.toolSchemaFormat    ?? 'full',
      maxHistoryTokens:    config?.maxHistoryTokens    ?? 30000,
      historyCompactionEnabled: config?.historyCompactionEnabled ?? true,
      historyCompactionThreshold: config?.historyCompactionThreshold ?? 80,
      autoMemoryThreshold: config?.autoMemoryThreshold ?? 6,
    };
  }

  /**
   * Updates the tool loading configuration.
   * Preserves all other fields (LLM, embedding, prompt).
   */
  async updateToolLoadingConfig(dto: ToolLoadingConfigDto, actorId?: string): Promise<ToolLoadingConfigDto> {
    const current = await this.repo.findOne({ where: { id: CONFIG_ID } });
    await this.repo.save({
      ...current,
      id: CONFIG_ID,
      toolLoadingStrategy: dto.toolLoadingStrategy,
      toolLoadingMaxTools: dto.toolLoadingMaxTools,
      toolSchemaFormat:    dto.toolSchemaFormat,
      maxHistoryTokens:    dto.maxHistoryTokens,
      historyCompactionEnabled: dto.historyCompactionEnabled,
      historyCompactionThreshold: dto.historyCompactionThreshold,
      autoMemoryThreshold: dto.autoMemoryThreshold,
    });
    this.logger.log(
      `ToolLoadingConfig: strategy=${dto.toolLoadingStrategy} ` +
      `maxTools=${dto.toolLoadingMaxTools} format=${dto.toolSchemaFormat} ` +
      `maxHistoryTokens=${dto.maxHistoryTokens} compaction=${dto.historyCompactionEnabled}` +
      `(threshold=${dto.historyCompactionThreshold}%)`,
    );
    await this.audit?.record({
      actorId: actorId ?? null,
      action: 'appconfig.update',
      resource: 'tool-loading',
      outcome: 'ok',
      ctx: {
        section: 'toolLoading',
        toolLoadingStrategy: dto.toolLoadingStrategy,
        toolSchemaFormat: dto.toolSchemaFormat,
        historyCompactionEnabled: dto.historyCompactionEnabled,
      },
    });
    return this.getToolLoadingConfig();
  }

  /** Sandbox gating configuration (master switch + authorized teams/projects). */
  async getSandboxConfig(): Promise<SandboxConfigDto> {
    const config = await this.repo.findOne({ where: { id: CONFIG_ID } });
    return {
      sandboxEnabled:           config?.sandboxEnabled ?? false,
      sandboxAllowedTeamIds:    config?.sandboxAllowedTeamIds ?? [],
      sandboxAllowedProjectIds: config?.sandboxAllowedProjectIds ?? [],
      sandboxNetwork:           config?.sandboxNetwork ?? 'none',
      sandboxExecMode:          config?.sandboxExecMode ?? 'hardened',
    };
  }

  /** Updates the sandbox gating. Preserves the other fields. */
  async updateSandboxConfig(dto: SandboxConfigDto, actorId?: string): Promise<SandboxConfigDto> {
    const current = await this.repo.findOne({ where: { id: CONFIG_ID } });
    await this.repo.save({
      ...current,
      id: CONFIG_ID,
      sandboxEnabled:           dto.sandboxEnabled,
      sandboxAllowedTeamIds:    dto.sandboxAllowedTeamIds ?? [],
      sandboxAllowedProjectIds: dto.sandboxAllowedProjectIds ?? [],
      sandboxNetwork:           dto.sandboxNetwork ?? 'none',
      sandboxExecMode:          dto.sandboxExecMode ?? 'hardened',
    });
    this.logger.log(
      `SandboxConfig: enabled=${dto.sandboxEnabled} net=${dto.sandboxNetwork ?? 'none'} mode=${dto.sandboxExecMode ?? 'hardened'} ` +
      `teams=${(dto.sandboxAllowedTeamIds ?? []).length} projects=${(dto.sandboxAllowedProjectIds ?? []).length}`,
    );
    await this.audit?.record({
      actorId: actorId ?? null,
      action: 'appconfig.update',
      resource: 'sandbox',
      outcome: 'ok',
      ctx: {
        section: 'sandbox',
        sandboxEnabled: dto.sandboxEnabled,
        sandboxNetwork: dto.sandboxNetwork ?? 'none',
        allowedTeams: (dto.sandboxAllowedTeamIds ?? []).length,
        allowedProjects: (dto.sandboxAllowedProjectIds ?? []).length,
      },
    });
    return this.getSandboxConfig();
  }

  // ── DataSource anti-SSRF security ─────────────────────────────────────────────

  async getDataSourceSecurityConfig(): Promise<DataSourceSecurityConfigDto> {
    const config = await this.repo.findOne({ where: { id: CONFIG_ID } });
    return {
      dataSourceAllowPrivateHosts: config?.dataSourceAllowPrivateHosts ?? true,
      dataSourceHostAllowlist:     config?.dataSourceHostAllowlist ?? [],
    };
  }

  async updateDataSourceSecurityConfig(
    dto: DataSourceSecurityConfigDto,
    actorId?: string,
  ): Promise<DataSourceSecurityConfigDto> {
    const current = await this.repo.findOne({ where: { id: CONFIG_ID } });
    const allowlist = Array.isArray(dto.dataSourceHostAllowlist)
      ? dto.dataSourceHostAllowlist.map((s) => String(s).trim()).filter(Boolean)
      : [];
    await this.repo.save({
      ...current,
      id: CONFIG_ID,
      dataSourceAllowPrivateHosts: !!dto.dataSourceAllowPrivateHosts,
      dataSourceHostAllowlist:     allowlist,
    });
    this.logger.log(
      `DataSourceSecurity: allowPrivateHosts=${!!dto.dataSourceAllowPrivateHosts} allowlist=${allowlist.length}`,
    );
    await this.audit?.record({
      actorId: actorId ?? null,
      action: 'appconfig.update',
      resource: 'datasource-security',
      outcome: 'ok',
      ctx: { section: 'datasource-security', allowPrivateHosts: !!dto.dataSourceAllowPrivateHosts, allowlist: allowlist.length },
    });
    return this.getDataSourceSecurityConfig();
  }

  /** Global toggle for active feedback-memory (default false). */
  async getFeedbackMemoryEnabled(): Promise<boolean> {
    const config = await this.repo.findOne({ where: { id: CONFIG_ID } });
    return config?.feedbackMemoryEnabled ?? false;
  }

  /** Sets the feedback-memory toggle (preserves the other fields). */
  async setFeedbackMemoryEnabled(enabled: boolean, actorId?: string): Promise<void> {
    const current = await this.repo.findOne({ where: { id: CONFIG_ID } });
    await this.repo.save({ ...current, id: CONFIG_ID, feedbackMemoryEnabled: enabled });
    this.logger.log(`FeedbackMemory: ${enabled ? 'enabled' : 'disabled'}`);
    await this.audit?.record({
      actorId: actorId ?? null,
      action: 'appconfig.update',
      resource: 'feedback-memory',
      outcome: 'ok',
      ctx: { section: 'feedbackMemory', enabled },
    });
  }

  /**
   * Decrypts and returns the plaintext embedding API key (internal use only).
   * Used by EmbeddingProviderService to build the embedding client.
   */
  async getRawEmbeddingApiKey(): Promise<string | null> {
    const config = await this.repo.findOne({ where: { id: CONFIG_ID } });
    if (!config?.embeddingApiKey) return null;
    try {
      return decrypt(config.embeddingApiKey);
    } catch {
      return null;
    }
  }
}
