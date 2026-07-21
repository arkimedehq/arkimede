/**
 * @file custom-tools.controller.ts
 *
 * REST controller for managing user-defined custom tools.
 *
 * ── Endpoints ─────────────────────────────────────────────────────────────────
 *
 *  Tool CRUD
 *  GET    /api/custom-tools              → lists all the user's tools
 *  POST   /api/custom-tools              → creates a new tool
 *  GET    /api/custom-tools/:id          → details of a tool
 *  PUT    /api/custom-tools/:id          → updates a tool
 *  DELETE /api/custom-tools/:id          → deletes a tool
 *  PATCH  /api/custom-tools/:id/toggle   → enable/disable in one click
 *
 *  Test (dry-run without LLM)
 *  POST   /api/custom-tools/:id/test     → runs the tool with the provided args
 *                                          and returns the raw result
 *
 *  Secrets (API keys, tokens, etc.)
 *  GET    /api/custom-tools/:id/secrets         → lists the keyNames (never the values)
 *  PUT    /api/custom-tools/:id/secrets         → upsert { KEY: "value" }
 *  DELETE /api/custom-tools/:id/secrets/:key    → deletes a secret
 *
 * ── Security ────────────────────────────────────────────────────────────────
 *  - All endpoints require a valid JWT
 *  - Ownership always verified before any operation
 *  - Encrypted values are never returned in the responses
 *  - The test endpoint is rate-limit friendly (10s timeout enforced in the factory)
 */
import {
  Controller, Get, Post, Put, Patch, Delete,
  Body, Param, UseGuards, HttpCode, HttpStatus,
  Inject, Logger, ForbiddenException,
} from '@nestjs/common';
import {
  ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiParam, ApiBody,
} from '@nestjs/swagger';
import {
  IsString, IsOptional, IsArray, IsObject,
  IsEnum, IsBoolean, ValidateNested, IsIn, IsUUID,
} from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { TeamsService } from '../teams/teams.service';
import { CustomToolsService } from './custom-tools.service';

// ── DTOs ──────────────────────────────────────────────────────────────────────

class ToolParameterDto {
  @IsString()
  name: string;

  @IsIn(['string', 'number', 'boolean'])
  type: 'string' | 'number' | 'boolean';

  @IsString()
  description: string;

  @IsBoolean()
  required: boolean;

  @IsOptional()
  default?: string | number | boolean;
}

class CreateToolDto {
  /** Snake_case, e.g. "search_brave" — must be unique per user */
  @IsString()
  name: string;

  /**
   * Description read by the LLM — determines when the tool is invoked.
   * Must be precise: what it does, when to use it, when NOT to use it.
   */
  @IsString()
  description: string;

  /** List of parameters the LLM must fill in before execution */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ToolParameterDto)
  parameters?: ToolParameterDto[];

  @IsEnum(['http', 'sql', 'prompt', 'rag'])
  executorType: 'http' | 'sql' | 'prompt' | 'rag';

  /**
   * Executor config (structure depends on executorType).
   * See HttpExecutorConfig in custom-tool.types.ts for details.
   * ⚠ Do NOT include plaintext API keys here — use the secrets field.
   */
  @IsObject()
  executorConfig: Record<string, unknown>;

  /**
   * Visibility scope.
   *   personal — default, visible only to the creator
   *   team     — visible to team members (teamId); requires admin or team owner
   *   org      — visible to everyone; requires admin role
   */
  @IsOptional()
  @IsString()
  @IsIn(['personal', 'team', 'org'])
  scope?: 'personal' | 'team' | 'org';

  /** Reference team (mandatory if scope='team'). */
  @IsOptional()
  @IsUUID()
  teamId?: string | null;

  /** If false, the tool does not enter the flat chat context (default true). */
  @IsOptional()
  @IsBoolean()
  loadOnFirst?: boolean;

  /**
   * Plaintext secrets — they are encrypted with AES-256 before saving.
   * Format: { "KEY_NAME": "secret-value" }
   * E.g.: { "TAVILY_API_KEY": "tvl-xxx..." }
   * The names will be used as {{secret.KEY_NAME}} placeholders in the config.
   */
  @IsOptional()
  @IsObject()
  secrets?: Record<string, string>;
}

class UpdateToolDto {
  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ToolParameterDto)
  parameters?: ToolParameterDto[];

  @IsOptional()
  @IsEnum(['http', 'sql', 'prompt', 'rag'])
  executorType?: 'http' | 'sql' | 'prompt' | 'rag';

  @IsOptional()
  @IsObject()
  executorConfig?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  loadOnFirst?: boolean;

  @IsOptional()
  @IsString()
  @IsIn(['personal', 'team', 'org'])
  scope?: 'personal' | 'team' | 'org';

  @IsOptional()
  @IsUUID()
  teamId?: string | null;

  @IsOptional()
  @IsObject()
  secrets?: Record<string, string>;
}

class TestToolDto {
  /**
   * Arguments to pass to the tool — must respect the defined parameters.
   * E.g. for a tool with params [query: string, maxResults: number]:
   *   { "query": "2024 industry regulations", "maxResults": 5 }
   */
  @IsOptional()
  @IsObject()
  args?: Record<string, unknown>;
}

class UpsertSecretsDto {
  /**
   * Map keyName → plaintext value.
   * Empty values ("") are ignored (they do not overwrite existing secrets).
   * E.g.: { "BRAVE_API_KEY": "BSA-...", "OTHER_KEY": "" }
   *      → updates BRAVE_API_KEY, ignores OTHER_KEY
   */
  @IsObject()
  secrets: Record<string, string>;
}

// ── Controller ────────────────────────────────────────────────────────────────

@ApiTags('custom-tools')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/custom-tools')
export class CustomToolsController {
  private readonly logger = new Logger(CustomToolsController.name);

  constructor(
    @Inject(CustomToolsService)
    private readonly service: CustomToolsService,
    @Inject(TeamsService)
    private readonly teams: TeamsService,
  ) {}

  /**
   * Verifies that the user can MANAGE (create with this scope / modify /
   * delete) a resource with the given scope/teamId:
   *   - personal → only the creator (ownerId)
   *   - org      → only admin
   *   - team     → admin or team owner
   */
  private async assertCanManage(
    user: { id: string; role: string },
    scope: 'personal' | 'team' | 'org',
    teamId: string | null | undefined,
    ownerId?: string,
  ): Promise<void> {
    if (scope === 'org') {
      if (user.role !== 'admin') {
        throw new ForbiddenException('tools.orgForbidden');
      }
      return;
    }
    if (scope === 'team') {
      if (!teamId) throw new ForbiddenException('tools.teamIdMissing');
      if (user.role === 'admin') return;
      if (await this.teams.isOwner(teamId, user.id)) return;
      throw new ForbiddenException('tools.teamForbidden');
    }
    // personal
    if (ownerId !== undefined && ownerId !== user.id) {
      throw new ForbiddenException('tools.ownerOnly');
    }
  }

  // ── List ────────────────────────────────────────────────────────────────

  @Get()
  @ApiOperation({ summary: 'List accessible tools: own + shared' })
  @ApiResponse({ status: 200, description: 'Array of tools (without secret values)' })
  findAll(@CurrentUser() user: any) {
    return this.service.findAll(user.id);
  }

  // ── Creation ─────────────────────────────────────────────────────────────

  @Post()
  @ApiOperation({ summary: 'Create a new custom tool (scope=shared requires admin)' })
  @ApiResponse({ status: 201, description: 'Tool created' })
  @ApiResponse({ status: 400, description: 'Invalid name or missing parameters' })
  @ApiResponse({ status: 403, description: 'Only admins can create shared tools' })
  @ApiResponse({ status: 409, description: 'Name already in use or reserved by the system' })
  async create(@Body() dto: CreateToolDto, @CurrentUser() user: any) {
    const scope = dto.scope ?? 'personal';
    await this.assertCanManage(user, scope, dto.teamId);
    return this.service.create(user.id, {
      name:           dto.name,
      description:    dto.description,
      parameters:     dto.parameters ?? [],
      executorType:   dto.executorType,
      executorConfig: dto.executorConfig as any,
      loadOnFirst:    dto.loadOnFirst,
      scope,
      teamId:         dto.teamId ?? null,
      secrets:        dto.secrets,
    });
  }

  // ── Detail ─────────────────────────────────────────────────────────────

  @Get(':id')
  @ApiOperation({ summary: 'Tool detail (own or shared). Secret keyNames yes, values no.' })
  @ApiParam({ name: 'id', description: 'Tool UUID' })
  findOne(@Param('id') id: string, @CurrentUser() user: any) {
    // Also accessible for shared tools of others
    return this.service.findOneAccessible(id, user.id);
  }

  // ── Update ─────────────────────────────────────────────────────────

  @Put(':id')
  @ApiOperation({ summary: 'Update the tool (the name is not editable; scope=shared requires admin)' })
  @ApiParam({ name: 'id', description: 'Tool UUID' })
  @ApiResponse({ status: 403, description: 'Only admins can modify shared tools' })
  @ApiResponse({ status: 404, description: 'Tool not found or not owned by the user' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateToolDto,
    @CurrentUser() user: any,
  ) {
    const existing = await this.service.findById(id);

    // Authorization on the CURRENT scope and on the destination one
    await this.assertCanManage(user, existing.scope, existing.teamId, existing.userId);
    if (dto.scope !== undefined && dto.scope !== existing.scope) {
      await this.assertCanManage(user, dto.scope, dto.teamId ?? existing.teamId, existing.userId);
    }

    return this.service.update(id, user.id, {
      description:    dto.description,
      parameters:     dto.parameters,
      executorType:   dto.executorType,
      executorConfig: dto.executorConfig as any,
      enabled:        dto.enabled,
      loadOnFirst:    dto.loadOnFirst,
      scope:          dto.scope,
      teamId:         dto.teamId,
      secrets:        dto.secrets,
    });
  }

  // ── Toggle enabled/disabled ─────────────────────────────────────────

  @Patch(':id/toggle')
  @ApiOperation({ summary: 'Enable/disable the tool (owner only; shared requires admin)' })
  @ApiParam({ name: 'id', description: 'Tool UUID' })
  @ApiResponse({ status: 200, description: 'Tool updated with enabled toggled' })
  async toggle(@Param('id') id: string, @CurrentUser() user: any) {
    const tool = await this.service.findById(id);
    await this.assertCanManage(user, tool.scope, tool.teamId, tool.userId);
    return this.service.update(id, user.id, { enabled: !tool.enabled });
  }

  // ── Deletion ──────────────────────────────────────────────────────────

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete the tool and its secrets (shared requires admin)' })
  @ApiParam({ name: 'id', description: 'Tool UUID' })
  async remove(@Param('id') id: string, @CurrentUser() user: any) {
    const tool = await this.service.findById(id);
    await this.assertCanManage(user, tool.scope, tool.teamId, tool.userId);
    await this.service.remove(id, user.id);
    return { message: 'Tool deleted' };
  }

  // ── Test / dry-run ────────────────────────────────────────────────────────

  /**
   * Executes the tool directly without involving the LLM.
   *
   * Flow:
   *   1. Loads the tool from the DB with the decrypted secrets
   *   2. Builds the DynamicStructuredTool via buildDynamicTool()
   *   3. Calls tool.invoke(args) → runs the HTTP/SQL/Prompt executor
   *   4. Returns the raw result + timing
   *
   * Always responds HTTP 200 with `{ success: boolean }`:
   *   - success: true  → result contains the response of the external API
   *   - success: false → error describes what went wrong (schema, network, etc.)
   *
   * ⚠ Works also for disabled tools — so the user can test
   *   before enabling.
   */
  @Post(':id/test')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Test the tool with the provided args (dry-run without LLM)',
    description:
      'Runs the tool executor directly and returns the raw response. ' +
      'Useful to verify URL, headers, body template and response path before enabling the tool. ' +
      'Works also on disabled tools.',
  })
  @ApiParam({ name: 'id', description: 'Tool UUID' })
  @ApiBody({ type: TestToolDto })
  @ApiResponse({
    status: 200,
    description: 'Test result (success=true) or error description (success=false)',
    schema: {
      type: 'object',
      properties: {
        success:       { type: 'boolean' },
        tool_name:     { type: 'string' },
        executor_type: { type: 'string', enum: ['http', 'sql', 'prompt'] },
        args_used:     { type: 'object' },
        result:        { type: 'string', description: 'Present only if success=true' },
        error:         { type: 'string', description: 'Present only if success=false' },
        elapsed_ms:    { type: 'number' },
      },
    },
  })
  async test(
    @Param('id') id: string,
    @Body() dto: TestToolDto,
    @CurrentUser() user: any,
  ) {
    const args = dto.args ?? {};
    this.logger.log(`Test tool "${id}" for user ${user.id} — args: ${JSON.stringify(args).slice(0, 200)}`);

    // We first load the detail to have name/executorType to return in the response,
    // even if the test fails for schema or network reasons.
    // findOneAccessible: own tool OR shared (no ownership needed for the test)
    const toolDef = await this.service.findOneAccessible(id, user.id);

    const t0 = Date.now();

    try {
      // Builds the DynamicStructuredTool with decrypted secrets
      // (buildToolForTest works also for disabled tools)
      const tool = await this.service.buildToolForTest(id, user.id);

      // Invokes the executor directly — LangChain validates the Zod schema internally
      // and then runs the func (executeHttp in this case)
      const result = await tool.invoke(args);

      const elapsed_ms = Date.now() - t0;
      this.logger.log(`Test tool "${toolDef.name}" → success in ${elapsed_ms}ms`);

      return {
        success:       true,
        tool_name:     toolDef.name,
        executor_type: toolDef.executorType,
        args_used:     args,
        result,
        elapsed_ms,
      };
    } catch (err: any) {
      const elapsed_ms = Date.now() - t0;

      // We distinguish Zod validation errors (wrong args) from execution errors
      const isValidationError =
        err?.name === 'ZodError' ||
        (err?.message ?? '').toLowerCase().includes('validation');

      this.logger.warn(
        `Test tool "${toolDef.name}" → ${isValidationError ? 'validation' : 'execution'} failed: ${err.message}`,
      );

      return {
        success:       false,
        tool_name:     toolDef.name,
        executor_type: toolDef.executorType,
        args_used:     args,
        error:         err?.message ?? 'Unknown error',
        error_type:    isValidationError ? 'validation' : 'execution',
        elapsed_ms,
      };
    }
  }

  // ── Secrets ─────────────────────────────────────────────────────────────────

  @Get(':id/secrets')
  @ApiOperation({ summary: 'List the names of configured secrets (never the values). Accessible also for shared tools.' })
  @ApiParam({ name: 'id', description: 'Tool UUID' })
  @ApiResponse({
    status: 200,
    description: 'Array of keyNames',
    schema: { type: 'object', properties: { keys: { type: 'array', items: { type: 'string' } } } },
  })
  async getSecretKeys(@Param('id') id: string, @CurrentUser() user: any) {
    // getSecretKeys internally uses findOneAccessible
    const keys = await this.service.getSecretKeys(id, user.id);
    return { keys };
  }

  @Put(':id/secrets')
  @ApiOperation({
    summary: 'Upsert secrets — encrypts and saves API keys and tokens',
    description:
      'Values are encrypted with AES-256-CBC before saving. ' +
      'Empty-string values ("") are ignored — the existing secret is not touched. ' +
      'This lets the frontend send the full list of keys without overwriting ' +
      'the values the user has not modified.',
  })
  @ApiParam({ name: 'id', description: 'Tool UUID' })
  @ApiBody({ type: UpsertSecretsDto })
  async upsertSecrets(
    @Param('id') id: string,
    @Body() dto: UpsertSecretsDto,
    @CurrentUser() user: any,
  ) {
    await this.service.findOne(id, user.id); // verify ownership before the upsert
    await this.service.upsertSecrets(id, dto.secrets);
    const keys = await this.service.getSecretKeys(id, user.id);
    return { message: 'Secrets updated', keys };
  }

  @Delete(':id/secrets/:key')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a single secret by keyName' })
  @ApiParam({ name: 'id',  description: 'Tool UUID' })
  @ApiParam({ name: 'key', description: 'Secret name (e.g. TAVILY_API_KEY)' })
  async removeSecret(
    @Param('id')  id: string,
    @Param('key') key: string,
    @CurrentUser() user: any,
  ) {
    await this.service.removeSecret(id, key, user.id);
    return { message: `Secret "${key}" deleted` };
  }
}
