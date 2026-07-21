/**
 * @file custom-tools.service.ts
 *
 * NestJS service for managing custom tools.
 *
 * Responsibilities:
 *   - Load a user's enabled tools (personal + shared) with decrypted secrets
 *   - Name validation (uniqueness + reserved names)
 *   - Basic CRUD on CustomTool and ToolSecret
 *
 * Scope:
 *   personal — only the creator can use/modify the tool
 *   shared   — visible to everyone; creation/modification reserved to admins
 *              → the controller verifies the admin role before calling these methods
 *
 * Used by AgentService to obtain the DynamicStructuredTool on every request.
 */
import {
  Injectable, Logger, ConflictException, NotFoundException, BadRequestException, Inject, Optional,
} from '@nestjs/common';
import { I18nContext } from 'nestjs-i18n';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not } from 'typeorm';
import { CustomTool } from './custom-tool.entity';
import { ToolSecret } from './tool-secret.entity';
import { encrypt, decrypt } from './crypto.utils';
import { buildDynamicTool, PromptContext, RagContext, RESERVED_TOOL_NAMES } from './custom-tool.factory';
import {
  ExecutorType, ExecutorConfig, ToolParameter, ToolScope,
  SqlExecutorConfig, ResolvedDataSource,
} from './custom-tool.types';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { DataSourcesService } from '../datasources/datasources.service';
import { EmbeddingProviderService } from '../embed/embedding.provider.service';
import { EmbedService } from '../embed/embed.service';
import { VectorStoreProviderService } from '../vector-db/vector-store-provider.service';
import { AppConfigService } from '../app-config/app-config.service';
import { LlmConfigsService } from '../llm-configs/llm-configs.service';
import { TeamsService } from '../teams/teams.service';
import { AuditService } from '../audit/audit.service';
import { In } from 'typeorm';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';

/** Regex to validate tool names: snake_case, starts with a lowercase letter */
const VALID_TOOL_NAME = /^[a-z][a-z0-9_]{1,63}$/;

export interface CreateCustomToolDto {
  name: string;
  description: string;
  parameters: ToolParameter[];
  executorType: ExecutorType;
  executorConfig: ExecutorConfig;
  /** Visibility scope — default 'personal' */
  scope?: ToolScope;
  /** Reference team (mandatory if scope='team'). */
  teamId?: string | null;
  /** If false, the tool does not enter the flat chat context — default true. */
  loadOnFirst?: boolean;
  /** Plaintext secrets to encrypt — format: { KEY_NAME: "value" } */
  secrets?: Record<string, string>;
}

export interface UpdateCustomToolDto extends Partial<Omit<CreateCustomToolDto, 'name'>> {
  enabled?: boolean;
}

@Injectable()
export class CustomToolsService {
  private readonly logger = new Logger(CustomToolsService.name);

  constructor(
    @InjectRepository(CustomTool)
    private readonly toolRepo: Repository<CustomTool>,
    @InjectRepository(ToolSecret)
    private readonly secretRepo: Repository<ToolSecret>,
    @Inject(DataSourcesService)
    private readonly dataSourcesService: DataSourcesService,
    @Inject(EmbeddingProviderService)
    private readonly embeddingProvider: EmbeddingProviderService,
    @Inject(EmbedService)
    private readonly embedService: EmbedService,
    @Inject(VectorStoreProviderService)
    private readonly vectorStore: VectorStoreProviderService,
    @Inject(AppConfigService)
    private readonly appConfigService: AppConfigService,
    @Inject(LlmConfigsService)
    private readonly llmConfigsService: LlmConfigsService,
    @Inject(TeamsService)
    private readonly teamsService: TeamsService,
    @Optional() private readonly audit?: AuditService,
  ) {}

  // ── Read for the agent ──────────────────────────────────────────────────────

  /**
   * Loads the user's enabled tools (personal + shared) and converts them into
   * DynamicStructuredTool for the ReAct agent.
   *
   * Merge logic:
   *   1. Load all the enabled tools owned by the user              (scope: personal)
   *   2. Load all the enabled shared tools                         (scope: shared)
   *   3. Dedup by name: the personal tool takes precedence over the shared namesake
   *
   * @param userId - current user ID
   */
  async loadToolsForUser(
    userId: string,
    projectId?: string,
    opts: { flatOnly?: boolean } = {},
  ): Promise<DynamicStructuredTool[]> {
    const selectFields = {
      id: true, name: true, description: true,
      parameters: true as any,
      executorType: true, executorConfig: true as any,
      enabled: true, userId: true, scope: true,
      secrets: { id: true, toolId: true, keyName: true, encryptedValue: true },
    };

    // `flatOnly` (main chat) excludes tools with loadOnFirst=false: they remain
    // usable only via the agent. The per-agent path does NOT pass flatOnly → it sees them.
    const baseWhere = opts.flatOnly ? { enabled: true, loadOnFirst: true } : { enabled: true };

    // Visibility: personal (own) + team (of the user's teams) + org (everyone)
    const teamIds = await this.teamsService.teamIdsForUser(userId);
    const allCandidates = await this.toolRepo.find({
      where: this.visibilityWhere(userId, teamIds, baseWhere),
      relations: { secrets: true },
      select: selectFields,
    });

    if (!allCandidates.length) return [];

    // Dedup by name with precedence personal > team > org (the most specific wins)
    const rank = (t: CustomTool) => (t.userId === userId ? 0 : t.scope === 'team' ? 1 : 2);
    const byName = new Map<string, CustomTool>();
    for (const t of allCandidates) {
      const cur = byName.get(t.name);
      if (!cur || rank(t) < rank(cur)) byName.set(t.name, t);
    }
    const tools = [...byName.values()];

    this.logger.log(
      `Loaded ${tools.length} tools (${tools.filter((t) => t.userId === userId).length} personal, ` +
      `${tools.filter((t) => t.userId !== userId).length} team/org) for user ${userId}`,
    );

    const ragCtx    = this.buildRagContext();
    const promptCtx = this.buildPromptContext();

    return Promise.all(tools.map(async (tool) => {
      const secrets = this.decryptSecrets(tool);
      const dataSource = await this.resolveDataSourceForTool(tool, userId);
      return buildDynamicTool(tool, secrets, dataSource, ragCtx, userId, promptCtx, projectId, false, this.audit);
    }));
  }

  // ── Read for the test endpoint ────────────────────────────────────────────

  /**
   * Loads a single tool accessible by the user (own OR shared)
   * and builds it as a DynamicStructuredTool with the decrypted secrets.
   *
   * Works also for disabled tools.
   */
  async buildToolForTest(id: string, userId: string): Promise<DynamicStructuredTool> {
    const teamIds = await this.teamsService.teamIdsForUser(userId);
    const tool = await this.toolRepo.findOne({
      where: this.visibilityWhere(userId, teamIds, { id }),
      relations: { secrets: true },
      select: {
        id: true, name: true, description: true,
        parameters: true as any,
        executorType: true, executorConfig: true as any,
        enabled: true, userId: true, scope: true,
        secrets: { id: true, toolId: true, keyName: true, encryptedValue: true },
      },
    });

    if (!tool) throw new NotFoundException(
      I18nContext.current()?.t('tools.notFound', { args: { id } })
        ?? `Tool "${id}" not found`,
    );

    const secrets    = this.decryptSecrets(tool);
    const dataSource = await this.resolveDataSourceForTool(tool, userId);
    const ragCtx     = this.buildRagContext();
    const promptCtx  = this.buildPromptContext();
    // throwOnError=true: the /test must distinguish failure (e.g. SSRF block)
    // from success, not receive the error as the result text.
    return buildDynamicTool(tool, secrets, dataSource, ragCtx, userId, promptCtx, undefined, true);
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  /**
   * Creates a new custom tool.
   * The controller is responsible for verifying that only admins can
   * create tools with scope='shared'.
   */
  async create(userId: string, dto: CreateCustomToolDto): Promise<CustomTool> {
    const scope = dto.scope ?? 'personal';
    // teamId relevant only for scope='team'
    const teamId = scope === 'team' ? (dto.teamId ?? null) : null;
    if (scope === 'team' && !teamId) {
      throw new BadRequestException('tools.teamIdRequired');
    }
    this.validateName(dto.name);
    await this.assertNameAvailable(userId, dto.name, scope, teamId);

    const tool = this.toolRepo.create({
      userId,
      name:           dto.name,
      description:    dto.description,
      parameters:     dto.parameters ?? [],
      executorType:   dto.executorType,
      executorConfig: dto.executorConfig,
      enabled:        true,
      loadOnFirst:    dto.loadOnFirst ?? true,
      scope,
      teamId,
    });

    const saved = await this.toolRepo.save(tool);

    if (dto.secrets && Object.keys(dto.secrets).length > 0) {
      await this.upsertSecrets(saved.id, dto.secrets);
    }

    this.logger.log(`Custom tool created: "${dto.name}" scope=${scope}${teamId ? ` team=${teamId}` : ''} (user: ${userId})`);
    await this.audit?.record({
      actorId: userId,
      action: 'customtool.create',
      resource: saved.name,
      outcome: 'ok',
      ctx: { id: saved.id, scope: saved.scope, teamId: saved.teamId, executorType: saved.executorType },
    });
    return this.findOne(saved.id, userId);
  }

  /**
   * True if any 'rag' tool (any user, any scope) already targets the given
   * collection. Used by the vector-db admin flow to keep the auto-created
   * search tool idempotent.
   */
  async existsRagToolForCollection(collection: string): Promise<boolean> {
    const count = await this.toolRepo
      .createQueryBuilder('t')
      .where('t.executorType = :type', { type: 'rag' })
      .andWhere(`t.executorConfig ->> 'collection' = :collection`, { collection })
      .getCount();
    return count > 0;
  }

  /**
   * Returns all the tools accessible by the user:
   *   - the user's own tools (any scope)
   *   - the shared tools of others
   */
  async findAll(userId: string): Promise<CustomTool[]> {
    const teamIds = await this.teamsService.teamIdsForUser(userId);
    return this.toolRepo.find({
      where: this.visibilityWhere(userId, teamIds),
      relations: { secrets: true },
      order: { createdAt: 'DESC' },
      select: {
        id: true, name: true, description: true,
        parameters: true as any,
        executorType: true, executorConfig: true as any,
        enabled: true, loadOnFirst: true, userId: true, scope: true, teamId: true,
        createdAt: true, updatedAt: true,
        // keyName yes, encryptedValue never
        secrets: { id: true, toolId: true, keyName: true },
      },
    });
  }

  /**
   * Returns a single tool owned by the user (without encryptedValue).
   * Used for write operations (update, delete, upsertSecrets).
   */
  async findOne(id: string, userId: string): Promise<CustomTool> {
    const tool = await this.toolRepo.findOne({
      where: { id, userId },
      relations: { secrets: true },
      select: {
        id: true, name: true, description: true,
        parameters: true as any,
        executorType: true, executorConfig: true as any,
        enabled: true, loadOnFirst: true, userId: true, scope: true, teamId: true,
        createdAt: true, updatedAt: true,
        secrets: { id: true, toolId: true, keyName: true },
      },
    });
    if (!tool) throw new NotFoundException(
      I18nContext.current()?.t('tools.notFound', { args: { id } })
        ?? `Tool "${id}" not found`,
    );
    return tool;
  }

  /**
   * Returns a tool accessible by the user (own OR shared).
   * Used for read-only operations: detail, test, secrets list.
   */
  async findOneAccessible(id: string, userId: string): Promise<CustomTool> {
    const teamIds = await this.teamsService.teamIdsForUser(userId);
    const tool = await this.toolRepo.findOne({
      where: this.visibilityWhere(userId, teamIds, { id }),
      relations: { secrets: true },
      select: {
        id: true, name: true, description: true,
        parameters: true as any,
        executorType: true, executorConfig: true as any,
        enabled: true, loadOnFirst: true, userId: true, scope: true, teamId: true,
        createdAt: true, updatedAt: true,
        secrets: { id: true, toolId: true, keyName: true },
      },
    });
    if (!tool) throw new NotFoundException(
      I18nContext.current()?.t('tools.notFound', { args: { id } })
        ?? `Tool "${id}" not found`,
    );
    return tool;
  }

  /** Updates a tool (all fields except the name are editable). */
  async update(id: string, userId: string, dto: UpdateCustomToolDto): Promise<CustomTool> {
    // Authorization (owner/admin/team-owner) handled by the controller; here lookup by id.
    const tool = await this.findById(id);

    // Effective scope/teamId after the update (to validate name uniqueness)
    const nextScope  = dto.scope ?? tool.scope;
    const nextTeamId = nextScope === 'team'
      ? (dto.teamId !== undefined ? dto.teamId : tool.teamId)
      : null;
    if (nextScope === 'team' && !nextTeamId) {
      throw new BadRequestException('tools.teamIdRequired');
    }

    // Name uniqueness in the new scope (the name does not change, but the scope/team does)
    if (nextScope === 'org' && tool.scope !== 'org') {
      const clash = await this.toolRepo.findOne({ where: { name: tool.name, scope: 'org' as any, id: Not(id) } });
      if (clash) throw new ConflictException(
        I18nContext.current()?.t('tools.orgNameTakenUpdate', { args: { name: tool.name } })
          ?? `An org tool with the name "${tool.name}" already exists.`,
      );
    }
    if (nextScope === 'team' && (tool.scope !== 'team' || tool.teamId !== nextTeamId)) {
      const clash = await this.toolRepo.findOne({ where: { name: tool.name, scope: 'team' as any, teamId: nextTeamId!, id: Not(id) } });
      if (clash) throw new ConflictException(
        I18nContext.current()?.t('tools.teamNameTakenUpdate', { args: { name: tool.name } })
          ?? `A team tool with the name "${tool.name}" already exists.`,
      );
    }

    if (dto.description   !== undefined) tool.description    = dto.description;
    if (dto.parameters    !== undefined) tool.parameters     = dto.parameters;
    if (dto.executorType  !== undefined) tool.executorType   = dto.executorType;
    if (dto.executorConfig !== undefined) tool.executorConfig = dto.executorConfig;
    if (dto.enabled       !== undefined) tool.enabled        = dto.enabled;
    if (dto.loadOnFirst   !== undefined) tool.loadOnFirst    = dto.loadOnFirst;
    if (dto.scope         !== undefined) tool.scope          = nextScope;
    if (dto.scope !== undefined || dto.teamId !== undefined) tool.teamId = nextTeamId;

    await this.toolRepo.save(tool);

    if (dto.secrets) {
      await this.upsertSecrets(id, dto.secrets);
    }

    await this.audit?.record({
      actorId: userId,
      action: 'customtool.update',
      resource: tool.name,
      outcome: 'ok',
      ctx: { id: tool.id, scope: tool.scope, teamId: tool.teamId, executorType: tool.executorType },
    });
    return this.findById(id);
  }

  /** Deletes a tool and its secrets (CASCADE). Authorization handled by the controller. */
  async remove(id: string, userId: string): Promise<void> {
    const tool = await this.findById(id);
    const removedId = tool.id;
    await this.toolRepo.remove(tool);
    this.logger.log(`Custom tool deleted: "${tool.name}" (user: ${userId})`);
    await this.audit?.record({
      actorId: userId,
      action: 'customtool.delete',
      resource: tool.name,
      outcome: 'ok',
      ctx: { id: removedId, scope: tool.scope, teamId: tool.teamId, executorType: tool.executorType },
    });
  }

  /** Lookup by id without an ownership constraint (authorization is the controller's). */
  async findById(id: string): Promise<CustomTool> {
    const tool = await this.toolRepo.findOne({
      where: { id },
      relations: { secrets: true },
      select: {
        id: true, name: true, description: true,
        parameters: true as any,
        executorType: true, executorConfig: true as any,
        enabled: true, loadOnFirst: true, userId: true, scope: true, teamId: true,
        createdAt: true, updatedAt: true,
        secrets: { id: true, toolId: true, keyName: true },
      },
    });
    if (!tool) throw new NotFoundException(
      I18nContext.current()?.t('tools.notFound', { args: { id } })
        ?? `Tool "${id}" not found`,
    );
    return tool;
  }

  // ── Secrets management ────────────────────────────────────────────────────

  /**
   * Upsert of the secrets: if the keyName already exists, updates the encrypted value;
   * otherwise creates a new record.
   * Empty-string values ("") are ignored.
   */
  async upsertSecrets(toolId: string, secrets: Record<string, string>): Promise<void> {
    for (const [keyName, plaintext] of Object.entries(secrets)) {
      if (!plaintext) continue;

      const encryptedValue = encrypt(plaintext);
      const existing = await this.secretRepo.findOne({ where: { toolId, keyName } });
      if (existing) {
        existing.encryptedValue = encryptedValue;
        await this.secretRepo.save(existing);
      } else {
        await this.secretRepo.save(
          this.secretRepo.create({ toolId, keyName, encryptedValue }),
        );
      }
    }
  }

  /** Returns the keyNames of a tool's secrets (without the encrypted values). */
  async getSecretKeys(toolId: string, userId: string): Promise<string[]> {
    await this.findOneAccessible(toolId, userId); // verify access (own or shared)
    const secrets = await this.secretRepo.find({ where: { toolId } });
    return secrets.map((s) => s.keyName);
  }

  /** Deletes a single secret (only the owner can do it). */
  async removeSecret(toolId: string, keyName: string, userId: string): Promise<void> {
    await this.findOne(toolId, userId); // ownership check
    await this.secretRepo.delete({ toolId, keyName });
  }

  // ── Validation ────────────────────────────────────────────────────────────

  // ── Internal helpers ──────────────────────────────────────────────────────

  private decryptSecrets(tool: CustomTool): Record<string, string> {
    const secrets: Record<string, string> = {};
    for (const s of tool.secrets ?? []) {
      try {
        secrets[s.keyName] = decrypt(s.encryptedValue);
      } catch (err: any) {
        this.logger.warn(
          `Unable to decrypt secret "${s.keyName}" for tool "${tool.name}": ${err.message}`,
        );
      }
    }
    return secrets;
  }

  /**
   * Builds the RagContext with the closures for 'rag' tools.
   *
   * search mode: embed + search
   * index mode:  embedDoc + upsert + ensureCollection + chunkText
   *
   * embedDoc uses embedBatch([text])[0] which applies docPrefix / inputType='document',
   * unlike embed() which uses queryPrefix / inputType='query'.
   */
  private buildRagContext(): RagContext {
    return {
      // ── search mode ────────────────────────────────────────────────────────
      embed:  (text) => this.embeddingProvider.embed(text),
      search: (col, vec, lim, filter) => this.vectorStore.search(col, vec, lim, filter),

      // ── index mode ─────────────────────────────────────────────────────────
      embedDoc: (text) =>
        this.embeddingProvider.embedBatch([text]).then((r) => r[0]),

      upsert: (col, points) =>
        this.vectorStore.upsert(col, points),

      ensureCollection: async (name) =>
        this.vectorStore.ensureCollection(name, await this.embeddingProvider.getVectorSize()),

      chunkText: async (text) => {
        const size    = await this.embeddingProvider.getChunkSize();
        const overlap = await this.embeddingProvider.getChunkOverlap();
        const chunks: string[] = [];
        const step = size - overlap;
        for (let i = 0; i < text.length; i += step) {
          chunks.push(text.slice(i, i + size));
          if (i + size >= text.length) break;
        }
        return chunks;
      },

      // Indexes a file already present in the system via its ID.
      // Uses EmbedService.ingestFileById() which extracts the text natively
      // (pdf-parse, mammoth, OCR, XLSX) — much more reliable than the
      // LLM transcription of the native content block.
      ingestFile: (fileId, userId, collection, opts) =>
        this.embedService.ingestFileById(fileId, userId, collection, opts),
    };
  }

  /**
   * Builds the PromptContext with the callLlm closure for 'prompt' tools.
   *
   * Resolves the LlmConfig by ID (or the default one if omitted), builds the
   * corresponding LangChain model and invokes the call with system + user message.
   */
  private buildPromptContext(): PromptContext {
    return {
      callLlm: async (system, user, llmConfigId, maxTokens, temperature) => {
        const entity = llmConfigId
          ? await this.llmConfigsService.findOne(llmConfigId)
          : await this.llmConfigsService.getDefault();

        if (!entity) throw new Error('No LLM config available for the Prompt executor');

        // Per-tool override (maxTokens/temperature) configured in the PromptExecutorConfig.
        const model = await this.llmConfigsService.buildModelForConfig(entity, { maxTokens, temperature });

        const result = await model.invoke([
          new SystemMessage(system),
          new HumanMessage(user),
        ]);

        const content = result.content;
        if (typeof content === 'string') return content;
        const textBlock = (content as any[]).find((b: any) => b.type === 'text');
        return textBlock?.text ?? '';
      },
    };
  }

  private async resolveDataSourceForTool(
    tool:   CustomTool,
    userId: string,
  ): Promise<ResolvedDataSource | undefined> {
    if (tool.executorType !== 'sql') return undefined;
    const config = tool.executorConfig as SqlExecutorConfig;
    if (!config?.dataSourceId) return undefined;
    try {
      return await this.dataSourcesService.resolveDataSource(config.dataSourceId, userId);
    } catch (err: any) {
      this.logger.warn(
        `Tool "${tool.name}": unable to resolve DataSource "${config.dataSourceId}": ${err.message}`,
      );
      return undefined;
    }
  }

  private validateName(name: string): void {
    if (!VALID_TOOL_NAME.test(name)) {
      throw new BadRequestException(
        I18nContext.current()?.t('tools.invalidName', { args: { name } })
          ?? `Invalid tool name: "${name}". Use snake_case, ` +
             `start with a lowercase letter, only letters/numbers/underscore, max 64 characters.`,
      );
    }
    if (RESERVED_TOOL_NAMES.has(name)) {
      throw new ConflictException(
        I18nContext.current()?.t('tools.reservedName', { args: { name } })
          ?? `The name "${name}" is reserved for system tools. Choose a different name.`,
      );
    }
  }

  /**
   * Builds the OR visibility conditions for a user:
   *   - the user's own tools (any scope)
   *   - tools with scope='team' of a team the user belongs to
   *   - tools with scope='org' (the whole organization)
   * `extra` is merged into every branch (e.g. { enabled: true } or { id }).
   */
  private visibilityWhere(
    userId: string,
    teamIds: string[],
    extra: Record<string, unknown> = {},
  ): Record<string, unknown>[] {
    const where: Record<string, unknown>[] = [
      { ...extra, userId },
      { ...extra, scope: 'org' },
    ];
    if (teamIds.length) {
      where.push({ ...extra, scope: 'team', teamId: In(teamIds) });
    }
    return where;
  }

  private async assertNameAvailable(
    userId: string,
    name: string,
    scope: ToolScope,
    teamId: string | null,
  ): Promise<void> {
    // Conflict for the current user (any scope)
    const userConflict = await this.toolRepo.findOne({ where: { userId, name } });
    if (userConflict) {
      throw new ConflictException(
        I18nContext.current()?.t('tools.nameTaken', { args: { name } })
          ?? `You already have a tool with the name "${name}".`,
      );
    }

    // org: globally unique name among the org tools
    if (scope === 'org') {
      const clash = await this.toolRepo.findOne({ where: { name, scope: 'org' as any } });
      if (clash) {
        throw new ConflictException(
          I18nContext.current()?.t('tools.orgNameTaken', { args: { name } })
            ?? `An org tool with the name "${name}" already exists. Org names must be globally unique.`,
        );
      }
    }

    // team: unique name within the same team
    if (scope === 'team' && teamId) {
      const clash = await this.toolRepo.findOne({ where: { name, scope: 'team' as any, teamId } });
      if (clash) {
        throw new ConflictException(
          I18nContext.current()?.t('tools.teamNameTaken', { args: { name } })
            ?? `A team tool with the name "${name}" already exists.`,
        );
      }
    }
  }
}
