import {
  Controller, Get, Patch, Post, Body, UseGuards, Inject, forwardRef,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { IsString, IsOptional, IsIn, IsInt, Min, Max, IsPositive, IsBoolean, IsArray } from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AppConfigService } from './app-config.service';
import { EmbeddingProvider, ToolLoadingStrategy, ToolSchemaFormat, TranscriptionProvider } from './app-config.entity';
import { EmbeddingProviderService } from '../embed/embedding.provider.service';
import { TranscriptionService } from '../transcription/transcription.service';
import { SkillExecutorClient } from '../skills/skill-executor.client';

class UpdateSystemPromptDto {
  @IsString() systemPrompt: string;
}

const EMBEDDING_PROVIDERS: EmbeddingProvider[] = [
  'internal', 'openai', 'voyage', 'ollama', 'lmstudio', 'openai-compatible',
];

const TRANSCRIPTION_PROVIDERS: TranscriptionProvider[] = ['internal', 'openai', 'groq', 'openai-compatible'];

const TOOL_LOADING_STRATEGIES: ToolLoadingStrategy[] = ['always_inject_all', 'top_k_rag', 'auto'];
const TOOL_SCHEMA_FORMATS: ToolSchemaFormat[]         = ['full', 'compressed', 'deferred'];

class UpdateToolLoadingConfigDto {
  @IsIn(TOOL_LOADING_STRATEGIES)
  toolLoadingStrategy: ToolLoadingStrategy;

  @IsInt() @Min(1) @Max(100) @Type(() => Number)
  toolLoadingMaxTools: number;

  @IsIn(TOOL_SCHEMA_FORMATS)
  toolSchemaFormat: ToolSchemaFormat;

  @IsInt() @Min(500) @Max(32000) @Type(() => Number)
  maxHistoryTokens: number;

  @IsBoolean()
  historyCompactionEnabled: boolean;

  @IsInt() @Min(50) @Max(95) @Type(() => Number)
  historyCompactionThreshold: number;

  @IsInt() @Min(1) @Max(100) @Type(() => Number)
  autoMemoryThreshold: number;
}

class UpdateSandboxConfigDto {
  @IsBoolean()
  sandboxEnabled: boolean;

  @IsOptional() @IsArray() @IsString({ each: true })
  sandboxAllowedTeamIds?: string[];

  @IsOptional() @IsArray() @IsString({ each: true })
  sandboxAllowedProjectIds?: string[];

  @IsOptional() @IsIn(['none', 'internal', 'internet', 'open'])
  sandboxNetwork?: 'none' | 'internal' | 'internet' | 'open';

  @IsOptional() @IsIn(['hardened', 'trusted'])
  sandboxExecMode?: 'hardened' | 'trusted';
}

class UpdateDataSourceSecurityConfigDto {
  @IsBoolean()
  dataSourceAllowPrivateHosts: boolean;

  @IsOptional() @IsArray() @IsString({ each: true })
  dataSourceHostAllowlist?: string[];
}

class UpdateEmbeddingConfigDto {
  @IsIn(EMBEDDING_PROVIDERS)
  embeddingProvider: EmbeddingProvider;

  @IsOptional() @IsString()
  embeddingModel?: string | null;

  /** Plaintext API key. String → encrypt; null → remove; undefined → leave untouched. */
  @IsOptional() @IsString()
  embeddingApiKey?: string | null;

  @IsOptional() @IsString()
  embeddingBaseUrl?: string | null;

  @IsInt() @IsPositive() @Type(() => Number)
  embeddingVectorSize: number;

  @IsOptional() @IsString()
  embeddingQueryPrefix?: string | null;

  @IsInt() @IsPositive() @Min(100) @Max(10000) @Type(() => Number)
  embeddingChunkSize: number;

  @IsInt() @Min(0) @Max(5000) @Type(() => Number)
  embeddingChunkOverlap: number;
}

class UpdateTranscriptionConfigDto {
  @IsBoolean()
  transcriptionEnabled: boolean;

  @IsIn(TRANSCRIPTION_PROVIDERS)
  transcriptionProvider: TranscriptionProvider;

  @IsOptional() @IsString()
  transcriptionModel?: string | null;

  /** Plaintext API key. String → encrypt; null → remove; undefined → leave untouched. */
  @IsOptional() @IsString()
  transcriptionApiKey?: string | null;

  @IsOptional() @IsString()
  transcriptionBaseUrl?: string | null;
}

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('api/admin/config')
export class AppConfigController {
  constructor(
    @Inject(AppConfigService)
    private readonly service: AppConfigService,

    @Inject(forwardRef(() => EmbeddingProviderService))
    private readonly embeddingProvider: EmbeddingProviderService,

    @Inject(forwardRef(() => TranscriptionService))
    private readonly transcription: TranscriptionService,

    @Inject(SkillExecutorClient)
    private readonly executorClient: SkillExecutorClient,
  ) {}

  // ── System Prompt ──────────────────────────────────────────────────────────

  /** GET /api/admin/config — reads the current configuration */
  @Get()
  @ApiOperation({ summary: 'Global configuration (admin)' })
  async getConfig() {
    const config = await this.service.getConfig();
    return {
      id:           config.id,
      systemPrompt: config.systemPrompt,
      updatedAt:    config.updatedAt,
    };
  }

  /** PATCH /api/admin/config — updates the base prompt */
  @Patch()
  @ApiOperation({ summary: 'Update system base prompt (admin)' })
  async updateSystemPrompt(@Body() dto: UpdateSystemPromptDto, @CurrentUser() user: any) {
    await this.service.updateSystemPrompt(dto.systemPrompt, user?.id);
    return this.getConfig();
  }

  // The LLM configuration is handled by the `llm-configs` module (multi-record CRUD
  // default/summarizer): see LlmConfigsController. Only prompt, embedding and
  // tool-loading remain here.

  // ── Tool Loading Config ─────────────────────────────────────────────────────

  /** GET /api/admin/config/tool-loading — current strategy */
  @Get('tool-loading')
  @ApiOperation({ summary: 'Tool loading configuration (admin)' })
  getToolLoadingConfig() {
    return this.service.getToolLoadingConfig();
  }

  /** PATCH /api/admin/config/tool-loading — updates the strategy */
  @Patch('tool-loading')
  @ApiOperation({ summary: 'Update tool loading configuration (admin)' })
  updateToolLoadingConfig(@Body() dto: UpdateToolLoadingConfigDto, @CurrentUser() user: any) {
    return this.service.updateToolLoadingConfig({
      toolLoadingStrategy: dto.toolLoadingStrategy,
      toolLoadingMaxTools: dto.toolLoadingMaxTools,
      toolSchemaFormat:    dto.toolSchemaFormat,
      maxHistoryTokens:    dto.maxHistoryTokens,
      historyCompactionEnabled: dto.historyCompactionEnabled,
      historyCompactionThreshold: dto.historyCompactionThreshold,
      autoMemoryThreshold: dto.autoMemoryThreshold,
    }, user?.id);
  }

  // ── Sandbox Config ──────────────────────────────────────────────────────────

  /** GET /api/admin/config/sandbox — sandbox tool gating (admin) */
  @Get('sandbox')
  @ApiOperation({ summary: 'Sandbox gating configuration (admin)' })
  async getSandboxConfig() {
    const cfg = await this.service.getSandboxConfig();
    // Runtime mode from the executor (best-effort, null if unreachable):
    // lets the UI declare when execution is in-process (dev, NOT isolated).
    const sandboxRuntimeMode = await this.executorClient.sandboxRuntimeMode();
    return { ...cfg, sandboxRuntimeMode };
  }

  /** PATCH /api/admin/config/sandbox — enables and defines the allowlists (admin) */
  @Patch('sandbox')
  @ApiOperation({ summary: 'Update sandbox gating (admin)' })
  updateSandboxConfig(@Body() dto: UpdateSandboxConfigDto, @CurrentUser() user: any) {
    return this.service.updateSandboxConfig({
      sandboxEnabled:           dto.sandboxEnabled,
      sandboxAllowedTeamIds:    dto.sandboxAllowedTeamIds ?? [],
      sandboxAllowedProjectIds: dto.sandboxAllowedProjectIds ?? [],
      sandboxNetwork:           dto.sandboxNetwork ?? 'none',
      sandboxExecMode:          dto.sandboxExecMode ?? 'hardened',
    }, user?.id);
  }

  // ── DataSource Security (anti-SSRF) ───────────────────────────────────────────

  /** GET /api/admin/config/datasource-security — anti-SSRF policy (admin) */
  @Get('datasource-security')
  @ApiOperation({ summary: 'DataSource anti-SSRF policy (admin)' })
  getDataSourceSecurityConfig() {
    return this.service.getDataSourceSecurityConfig();
  }

  /** PATCH /api/admin/config/datasource-security — updates the anti-SSRF policy (admin) */
  @Patch('datasource-security')
  @ApiOperation({ summary: 'Update DataSource anti-SSRF policy (admin)' })
  updateDataSourceSecurityConfig(@Body() dto: UpdateDataSourceSecurityConfigDto, @CurrentUser() user: any) {
    return this.service.updateDataSourceSecurityConfig({
      dataSourceAllowPrivateHosts: dto.dataSourceAllowPrivateHosts,
      dataSourceHostAllowlist:     dto.dataSourceHostAllowlist ?? [],
    }, user?.id);
  }

  // ── Embedding Config ────────────────────────────────────────────────────────

  /** GET /api/admin/config/embedding — current embedding configuration */
  @Get('embedding')
  @ApiOperation({ summary: 'Current embedding configuration' })
  getEmbeddingConfig() {
    return this.service.getEmbeddingConfig();
  }

  /** PATCH /api/admin/config/embedding — updates the embedding configuration */
  @Patch('embedding')
  @ApiOperation({ summary: 'Update embedding configuration' })
  async updateEmbeddingConfig(@Body() dto: UpdateEmbeddingConfigDto, @CurrentUser() user: any) {
    const result = await this.service.updateEmbeddingConfig({
      embeddingProvider:    dto.embeddingProvider,
      embeddingModel:       dto.embeddingModel    ?? null,
      embeddingApiKey:      dto.embeddingApiKey,          // undefined = leave the key untouched
      embeddingBaseUrl:     dto.embeddingBaseUrl   ?? null,
      embeddingVectorSize:  dto.embeddingVectorSize,
      embeddingQueryPrefix: dto.embeddingQueryPrefix ?? null,
      embeddingChunkSize:   dto.embeddingChunkSize,
      embeddingChunkOverlap: dto.embeddingChunkOverlap,
    }, user?.id);
    // Invalidate the embedding client cache
    this.embeddingProvider.invalidateCache();
    return result;
  }

  /**
   * POST /api/admin/config/embedding/test — checks the connection to the embedding provider.
   * Invalidates the cache before the test to use the most recent configuration.
   */
  @Post('embedding/test')
  @ApiOperation({ summary: 'Test the connection to the configured embedding provider' })
  async testEmbeddingConnection() {
    this.embeddingProvider.invalidateCache();
    return this.embeddingProvider.testConnection();
  }

  // ── Transcription Config (Whisper) ──────────────────────────────────────────

  /** GET /api/admin/config/transcription — current transcription configuration */
  @Get('transcription')
  @ApiOperation({ summary: 'Current voice transcription configuration' })
  getTranscriptionConfig() {
    return this.service.getTranscriptionConfig();
  }

  /** PATCH /api/admin/config/transcription — updates the transcription configuration */
  @Patch('transcription')
  @ApiOperation({ summary: 'Update voice transcription configuration' })
  async updateTranscriptionConfig(@Body() dto: UpdateTranscriptionConfigDto, @CurrentUser() user: any) {
    const result = await this.service.updateTranscriptionConfig({
      transcriptionEnabled:  dto.transcriptionEnabled,
      transcriptionProvider: dto.transcriptionProvider,
      transcriptionModel:    dto.transcriptionModel ?? null,
      transcriptionApiKey:   dto.transcriptionApiKey,   // undefined = leave the key untouched
      transcriptionBaseUrl:  dto.transcriptionBaseUrl ?? null,
    }, user?.id);
    this.transcription.invalidateCache();
    return result;
  }

  /** POST /api/admin/config/transcription/test — checks the Whisper endpoint */
  @Post('transcription/test')
  @ApiOperation({ summary: 'Test the connection to the configured transcription provider' })
  async testTranscriptionConnection() {
    this.transcription.invalidateCache();
    return this.transcription.testConnection();
  }
}
