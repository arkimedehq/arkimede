/**
 * @file skills.controller.ts
 *
 * REST controller for the Skills system.
 *
 * ── Endpoints ───────────────────────────────────────────────────────────────
 *
 *  Skill (CRUD + upload)
 *  POST   /api/skills/upload               → upload ZIP package
 *  GET    /api/skills                      → list skills (own + shared approved)
 *  GET    /api/skills/:id                  → skill detail + scripts + log
 *  PATCH  /api/skills/:id                  → update description / scope
 *  DELETE /api/skills/:id                  → delete skill + volume files
 *  POST   /api/skills/:id/reinstall        → re-trigger installation
 *
 *  Project assignments
 *  GET    /api/skills/project/:projectId   → skills assigned to a project
 *  POST   /api/skills/:id/assign/:projectId   → assign to the project
 *  DELETE /api/skills/:id/assign/:projectId   → remove from the project
 *
 *  Admin — shared skill review
 *  GET    /api/skills/pending-review        → shared skills pending (admin only)
 *  POST   /api/skills/:id/approve          → approve (admin only)
 *  POST   /api/skills/:id/reject           → reject (admin only)
 *
 * ── Security ────────────────────────────────────────────────────────────────
 *  - All endpoints require a valid JWT
 *  - Ownership verified before writes
 *  - Approval/rejection reserved for admins (AdminGuard)
 *  - Upload limited to 50 MB, .zip only
 */
import {
  Controller, Get, Post, Patch, Put, Delete,
  Param, Body, UseGuards, UseInterceptors, UploadedFile, UploadedFiles,
  HttpCode, HttpStatus, Inject, Logger, BadRequestException, ForbiddenException,
} from '@nestjs/common';
import { I18nContext } from 'nestjs-i18n';
import { FileInterceptor, AnyFilesInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import * as fsPromises from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { SkillExecutorUnavailableError } from './skill-executor.client';
import {
  ApiTags, ApiBearerAuth, ApiOperation, ApiConsumes, ApiBody,
  ApiParam, ApiResponse,
} from '@nestjs/swagger';
import { IsOptional, IsString, IsIn, IsUrl, IsBoolean, IsUUID, IsArray } from 'class-validator';

import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { SkillsService } from './skills.service';
import { RegistryService } from './registry.service';
import { AuditService } from '../audit/audit.service';

// ─── DTOs ─────────────────────────────────────────────────────────────────────

class UpdateSkillDto {
  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  @IsIn(['personal', 'team', 'org'])
  scope?: 'personal' | 'team' | 'org';

  @IsOptional()
  @IsUUID()
  teamId?: string | null;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  loadOnFirst?: boolean;
}

class SetEnabledDto {
  @IsBoolean()
  enabled: boolean;
}

class SetScriptLlmCallableDto {
  @IsBoolean()
  llmCallable: boolean;
}

class SetScriptContextNoteDto {
  @IsOptional()
  @IsString()
  contextNote?: string | null;
}

class RejectSkillDto {
  @IsOptional()
  @IsString()
  reason?: string;
}

class RegistryInstallDto {
  @IsUrl({ require_tld: true, protocols: ['https'] })
  downloadUrl: string;
}

class UpsertConfigVarDto {
  @IsString()
  value: string;
}

/** Confirmed typed manifest (S3): input_schema is arbitrary JSON Schema. */
class CompileSkillDto {
  @IsArray()
  scripts: Array<{ filename: string; language: string; description: string; input_schema: Record<string, unknown>; llm_callable?: boolean }>;
}

// ─── Controller ───────────────────────────────────────────────────────────────

@ApiTags('skills')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/skills')
export class SkillsController {
  private readonly logger = new Logger(SkillsController.name);

  constructor(
    @Inject(SkillsService)
    private readonly service: SkillsService,
    private readonly registry: RegistryService,
    private readonly audit: AuditService,
  ) {}

  // ── Public registry ────────────────────────────────────────────────────

  @Get('registry')
  @ApiOperation({
    summary: 'Index of the public skill registry',
    description:
      'Returns the list of skills available in the configured GitHub registry. ' +
      'The result is cached (default 5 min) to reduce requests to GitHub.',
  })
  @ApiResponse({ status: 200, description: 'Registry index with skill list' })
  @ApiResponse({ status: 502, description: 'Registry unreachable' })
  getRegistry() {
    return this.registry.fetchIndex();
  }

  @Post('registry/install')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Install a skill from the public registry',
    description:
      'Downloads the ZIP from the GitHub registry and installs it into the personal collection. ' +
      'The downloadUrl must come from a domain in the whitelist (raw.githubusercontent.com, etc.).',
  })
  @ApiResponse({ status: 201, description: 'Skill installed, dependencies installing' })
  @ApiResponse({ status: 403, description: 'Domain not allowed' })
  @ApiResponse({ status: 409, description: 'A skill with the same name is already installed' })
  @ApiResponse({ status: 502, description: 'Download failed' })
  async installFromRegistry(
    @Body() dto: RegistryInstallDto,
    @CurrentUser() user: any,
  ) {
    // E3: download + checksum verification (mismatch → 403; missing → admin only, unless strict)
    try {
      const zipBuffer = await this.registry.downloadVerified(dto.downloadUrl, user.role === 'admin');
      const result = await this.service.uploadAndCreate(user.id, zipBuffer);
      await this.audit.record({
        actorId: user.id, action: 'skill.registry_install', resource: dto.downloadUrl,
        outcome: 'ok', ctx: { skillId: (result as any)?.id },
      });
      return result;
    } catch (err: any) {
      await this.audit.record({
        actorId: user.id, action: 'skill.registry_install', resource: dto.downloadUrl,
        outcome: 'denied', ctx: { reason: err?.message?.slice(0, 200) },
      });
      throw err;
    }
  }

  @Post('registry/refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Force refresh of the registry cache (all authenticated users)' })
  refreshRegistry() {
    this.registry.invalidateCache();
    return { message: 'Registry cache invalidated — it will be reloaded from GitHub on next access' };
  }

  @Get('egress/allowlist')
  @UseGuards(AdminGuard)
  @ApiOperation({
    summary: 'Aggregated egress allowlist of skills (C1, admin)',
    description: 'Union of the domains declared (SKILL.md → runtime.network) by the enabled skills. ' +
      'Used to populate the SKILL_DOMAINS section of egress-proxy/squid.conf.',
  })
  async egressAllowlist() {
    return { domains: await this.service.getEgressAllowlist() };
  }

  // ── Upload ────────────────────────────────────────────────────────────────

  @Post('upload')
  @ApiOperation({
    summary: 'Upload a skill package (.zip)',
    description:
      'The package must contain: SKILL.md (agentskills.io format: YAML frontmatter with metadata + ' +
      '`runtime` block for deps/script/config, followed by the instructions for the AI), scripts/ (optional: executable files). ' +
      'The response is immediate (status: installing) — use GET /skills/:id to monitor the installation.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary', description: 'ZIP archive of the skill package' } },
    },
  })
  @ApiResponse({ status: 201, description: 'Skill created, installation started' })
  @ApiResponse({ status: 400, description: 'Invalid ZIP, missing SKILL.md or malformed frontmatter' })
  @ApiResponse({ status: 409, description: 'Skill name already in use' })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits:  { fileSize: 50 * 1024 * 1024 }, // 50 MB
      fileFilter: (_req, file, cb) => {
        const isZip = file.mimetype === 'application/zip'
          || file.mimetype === 'application/x-zip-compressed'
          || file.originalname.toLowerCase().endsWith('.zip');
        if (isZip) cb(null, true);
        else cb(new BadRequestException('skills.onlyZipAccepted'), false);
      },
    }),
  )
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: any,
  ) {
    if (!file) throw new BadRequestException('skills.noFileUploaded');
    this.logger.log(`Skill upload from user ${user.id} (${file.size} bytes)`);
    return this.service.uploadAndCreate(user.id, file.buffer);
  }

  // ── List ─────────────────────────────────────────────────────────────────

  @Get()
  @ApiOperation({ summary: 'List of accessible skills: own + shared approved' })
  findAll(@CurrentUser() user: any) {
    return this.service.findAll(user.id);
  }

  // ── Skills assigned to a project ─────────────────────────────────────────

  @Get('project/:projectId')
  @ApiOperation({ summary: 'List the skills assigned to a project' })
  @ApiParam({ name: 'projectId', description: 'Project UUID' })
  findByProject(@Param('projectId') projectId: string, @CurrentUser() user: any) {
    return this.service.findByProject(projectId, user.id);
  }

  // ── Admin: pending review list ───────────────────────────────────────────

  @Get('pending-review')
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: '[ADMIN] List the shared skills pending approval' })
  @ApiResponse({ status: 200, description: 'Array of shared skills not yet approved' })
  @ApiResponse({ status: 403, description: 'Admins only' })
  findPendingReview() {
    return this.service.findPendingReview();
  }

  // ── Admin: reserved networks (Phase 3) ────────────────────────────────────

  @Get('networks/catalog')
  @UseGuards(AdminGuard)
  @ApiOperation({
    summary: '[ADMIN] Catalog of assignable reserved networks',
    description: 'The operator-provisioned reserved networks (LAN/VPN/subnets) declared in ' +
      'SKILL_NETWORK_CATALOG, grantable per-skill via PUT /skills/:id/networks.',
  })
  networkCatalog() {
    return this.service.getNetworkCatalog();
  }

  @Put(':id/networks')
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: '[ADMIN] Set the reserved networks granted to a skill' })
  @ApiParam({ name: 'id', description: 'Skill UUID' })
  @ApiResponse({ status: 200, description: 'Updated grantedNetworks (valid catalog ids only)' })
  @ApiResponse({ status: 404, description: 'Skill not found' })
  setNetworks(
    @Param('id') id: string,
    @Body() body: { grantedNetworks?: string[] },
    @CurrentUser() user: any,
  ) {
    return this.service.setGrantedNetworks(id, body?.grantedNetworks ?? [], user.id);
  }

  // ── Detail ────────────────────────────────────────────────────────────────

  @Get(':id')
  @ApiOperation({ summary: 'Skill detail (own or shared approved)' })
  @ApiParam({ name: 'id', description: 'Skill UUID' })
  findOne(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.findOne(id, user.id);
  }

  // ── Update ─────────────────────────────────────────────────────────────────

  @Patch(':id')
  @ApiOperation({ summary: 'Update the skill description and/or scope (owner only)' })
  @ApiParam({ name: 'id', description: 'Skill UUID' })
  @ApiResponse({ status: 403, description: 'You are not the owner' })
  @ApiResponse({ status: 400, description: 'Skill not ready for sharing (status != ready)' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateSkillDto,
    @CurrentUser() user: any,
  ) {
    // org → requires admin review (isApproved=false); team → direct publication
    // if the user is admin or team owner; personal → private.
    // org approval happens via POST /api/skills/:id/approve (admin-only).
    return this.service.update(id, user.id, dto, user.role === 'admin');
  }

  // ── Script llmCallable toggle ─────────────────────────────────────────────

  /**
   * PATCH /api/skills/:id/scripts/:scriptId/llm-callable
   *
   * Bidirectional LLM visibility toggle (owner only).
   * true  → the script becomes a LangGraph tool (visible to the agent).
   * false → the script is invisible to the agent (inter-skill bus or manual execution only).
   */
  @Patch(':id/scripts/:scriptId/llm-callable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Toggle the LLM visibility of a script (owner only)',
    description:
      'Sets llmCallable true/false. ' +
      'false = the script is not exposed as a LangGraph tool. ' +
      'The original value declared in the SKILL.md frontmatter is restored by reinstall.',
  })
  @ApiParam({ name: 'id',       description: 'Skill UUID' })
  @ApiParam({ name: 'scriptId', description: 'Script UUID' })
  @ApiResponse({ status: 200,  description: 'Script updated' })
  @ApiResponse({ status: 403,  description: 'You are not the owner' })
  @ApiResponse({ status: 404,  description: 'Script not found' })
  async setScriptLlmCallable(
    @Param('id')        skillId:  string,
    @Param('scriptId')  scriptId: string,
    @Body()             dto:      SetScriptLlmCallableDto,
    @CurrentUser()      user:     any,
  ) {
    return this.service.setScriptLlmCallable(skillId, scriptId, user.id, dto.llmCallable);
  }

  /**
   * PATCH /api/skills/:id/scripts/:scriptId/context-note
   *
   * Saves (or clears) the LLM context note for a specific script (owner only).
   * The note is injected into the DynamicStructuredTool's description at agent
   * build time, so the LLM knows available models, profiles, etc.
   */
  @Patch(':id/scripts/:scriptId/context-note')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Set the LLM context note for a script (owner only)',
    description:
      'The note is appended to the LangGraph tool description — ' +
      'use it to communicate runtime details to the LLM: trained models, profiles, active dataset.',
  })
  @ApiParam({ name: 'id',       description: 'Skill UUID' })
  @ApiParam({ name: 'scriptId', description: 'Script UUID' })
  @ApiResponse({ status: 200,  description: 'Script updated' })
  @ApiResponse({ status: 403,  description: 'You are not the owner' })
  @ApiResponse({ status: 404,  description: 'Script not found' })
  async setScriptContextNote(
    @Param('id')        skillId:  string,
    @Param('scriptId')  scriptId: string,
    @Body()             dto:      SetScriptContextNoteDto,
    @CurrentUser()      user:     any,
  ) {
    return this.service.setScriptContextNote(skillId, scriptId, user.id, dto.contextNote ?? null);
  }

  // ── Enable / Disable ──────────────────────────────────────────────────────

  @Patch(':id/enabled')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Enable or disable a skill (owner only)',
    description:
      'A disabled skill is not loaded as a LangGraph tool ' +
      'nor injected into the system prompt. Semantically equivalent to PATCH /:id with { enabled }.',
  })
  @ApiParam({ name: 'id', description: 'Skill UUID' })
  @ApiResponse({ status: 200, description: 'Skill updated' })
  @ApiResponse({ status: 403, description: 'You are not the owner' })
  async setEnabled(
    @Param('id') id: string,
    @Body() dto: SetEnabledDto,
    @CurrentUser() user: any,
  ) {
    return this.service.setEnabled(id, user.id, dto.enabled);
  }

  // ── Deletion ──────────────────────────────────────────────────────────────

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete skill and files from the volume (owner or admin only)' })
  @ApiParam({ name: 'id', description: 'Skill UUID' })
  async remove(@Param('id') id: string, @CurrentUser() user: any) {
    // Admins can delete any skill (e.g. for inappropriate content)
    if (user.role === 'admin') {
      const skill = await this.service.findOne(id, user.id);
      await this.service.remove(skill.id, skill.ownerId); // use ownerId to bypass ownership check
    } else {
      await this.service.remove(id, user.id);
    }
    return { message: 'Skill deleted' };
  }

  // ── Marketplace install ───────────────────────────────────────────────────

  @Post(':id/install')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Install a skill from the marketplace into your own collection',
    description:
      'Creates an independent copy of the shared+approved skill in the user\'s personal ' +
      'collection. The copy has its own lifecycle, configuration and assignments.',
  })
  @ApiParam({ name: 'id', description: 'UUID of the skill to install' })
  @ApiResponse({ status: 201, description: 'Skill installed, dependency installation started' })
  @ApiResponse({ status: 404, description: 'Skill not found or not approved' })
  @ApiResponse({ status: 409, description: 'A skill with the same name is already present in the collection' })
  installFromMarketplace(
    @Param('id') id: string,
    @CurrentUser() user: any,
  ) {
    return this.service.installFromMarketplace(id, user.id);
  }

  // ── Re-install ────────────────────────────────────────────────────────────

  @Post(':id/reinstall')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Restart the dependency installation (owner only)' })
  @ApiParam({ name: 'id', description: 'Skill UUID' })
  reinstall(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.reinstall(id, user.id);
  }

  // ── S3: descriptive → typed compilation ───────────────────────────────

  @Post(':id/propose-compilation')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'The AI proposes a typed manifest (input_schema) for the skill scripts (owner only)' })
  @ApiParam({ name: 'id', description: 'Skill UUID' })
  proposeCompilation(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.proposeCompilation(id, user.id);
  }

  @Post(':id/compile')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Apply the confirmed compilation: writes runtime.scripts into SKILL.md and reinstalls (owner only)' })
  @ApiParam({ name: 'id', description: 'Skill UUID' })
  compile(@Param('id') id: string, @Body() dto: CompileSkillDto, @CurrentUser() user: any) {
    return this.service.applyCompilation(id, user.id, dto.scripts);
  }

  // ── Update from ZIP ───────────────────────────────────────────────────────

  @Post(':id/upload-update')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update an existing skill by uploading a new ZIP (owner only)',
    description:
      'Overwrites the files on the volume with the new ZIP and updates the metadata. ' +
      'The configuration values set by the user are preserved. ' +
      'The skill name in the ZIP must match the current skill.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary', description: 'Updated ZIP archive' } },
    },
  })
  @ApiParam({ name: 'id', description: 'UUID of the skill to update' })
  @ApiResponse({ status: 200, description: 'Skill updated, dependency reinstallation started' })
  @ApiResponse({ status: 400, description: 'Invalid ZIP or mismatched skill name' })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits:  { fileSize: 50 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        const isZip = file.mimetype === 'application/zip'
          || file.mimetype === 'application/x-zip-compressed'
          || file.originalname.toLowerCase().endsWith('.zip');
        if (isZip) cb(null, true);
        else cb(new BadRequestException('skills.onlyZipAccepted'), false);
      },
    }),
  )
  async uploadUpdate(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: any,
  ) {
    if (!file) throw new BadRequestException('skills.noFileUploaded');
    return this.service.updateFromZip(id, user.id, file.buffer);
  }

  // ── Sync from source ──────────────────────────────────────────────────────

  @Post(':id/sync-from-source')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sync the skill with the current version of the marketplace source (owner only)',
    description:
      'Overwrites the files with those of the source skill (shared+approved) and updates the metadata. ' +
      'The configuration values set by the user are preserved. ' +
      'Available only for skills installed from the marketplace.',
  })
  @ApiParam({ name: 'id', description: 'UUID of the skill to sync' })
  @ApiResponse({ status: 200, description: 'Skill synced, dependency reinstallation started' })
  @ApiResponse({ status: 400, description: 'Skill without a source or source not available' })
  syncFromSource(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.syncFromSource(id, user.id);
  }

  // ── Manual script execution ────────────────────────────────────────────────

  /**
   * POST /api/skills/:id/execute
   *
   * Manually executes a task script of the skill (owner only).
   * Used by the UI to run scripts without going through the LLM agent.
   *
   * Body: multipart/form-data
   *   script      (string) — script filename (e.g. "scripts/train.py")
   *   input       (string) — JSON of the textual parameters
   *   timeout_ms  (string) — timeout in ms, max 600000 (default: 120000)
   *   <fieldname> (file)   — optional files; the fieldname corresponds to the input
   *                          key (e.g. "csv_path" → input.csv_path = tmpPath)
   *
   * Response 200: { success, output, raw, duration_ms, exit_code, stderr? }
   */
  @Post(':id/execute')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Manually execute a task script (owner only)',
    description:
      'Allows invoking a skill script without going through the LLM agent. ' +
      'Supports file uploads (e.g. CSV for train.py). ' +
      'The body must be multipart/form-data.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiParam({ name: 'id', description: 'Skill UUID' })
  @ApiResponse({ status: 200, description: 'Script executed — see the success field for the outcome' })
  @ApiResponse({ status: 400, description: 'Script not found or is a daemon' })
  @ApiResponse({ status: 403, description: 'You are not the owner of the skill' })
  @ApiResponse({ status: 503, description: 'skill-executor unreachable' })
  @UseInterceptors(
    AnyFilesInterceptor({
      storage: memoryStorage(),
      limits: { fileSize: 200 * 1024 * 1024, files: 10 },
    }),
  )
  async executeScript(
    @Param('id')      id: string,
    @UploadedFiles()  files: Express.Multer.File[],
    @Body('script')   scriptFilename: string,
    @Body('input')    inputJson: string,
    @Body('timeout_ms') timeoutStr: string,
    @CurrentUser()    user: any,
  ) {
    // ── 1. Verify access and ownership ────────────────────────────────────
    const skill = await this.service.findOne(id, user.id);
    if (skill.ownerId !== user.id && user.role !== 'admin') {
      throw new ForbiddenException('skills.onlyOwnerCanExecute');
    }
    if (!scriptFilename) {
      throw new BadRequestException('skills.scriptFieldRequired');
    }

    // ── 2. Parse the input JSON ──────────────────────────────────────────
    let input: Record<string, unknown> = {};
    if (inputJson?.trim()) {
      try {
        input = JSON.parse(inputJson);
      } catch {
        throw new BadRequestException('skills.inputMustBeJson');
      }
    }

    // ── 3. Handle uploaded files → write to tmpdir and inject the paths ──────
    const tmpDir = files?.length
      ? await fsPromises.mkdtemp(path.join(os.tmpdir(), 'skill-exec-'))
      : null;
    const tmpPaths: string[] = [];

    try {
      if (files?.length && tmpDir) {
        for (const file of files) {
          // Sanitize: use only the basename without path traversal
          const safeName = path.basename(file.originalname);
          const tmpPath  = path.join(tmpDir, safeName);
          await fsPromises.writeFile(tmpPath, file.buffer);
          tmpPaths.push(tmpPath);
          // The file's fieldname becomes the input key
          // e.g. upload field "csv_path" → input.csv_path = "/tmp/skill-exec-xxx/file.csv"
          input[file.fieldname] = tmpPath;
        }
      }

      // ── 4. Timeout: default 120s, max 600s ──────────────────────────────
      const timeoutMs = timeoutStr
        ? Math.min(Math.max(parseInt(timeoutStr, 10) || 120_000, 5_000), 600_000)
        : 120_000;

      this.logger.log(
        `[execute] userId=${user.id} skill=${id} script="${scriptFilename}" ` +
        `files=${files?.length ?? 0} timeout=${timeoutMs}ms`,
      );

      return await this.service.invoke(id, scriptFilename, input, timeoutMs, user.id);

    } catch (err: any) {
      if (err instanceof SkillExecutorUnavailableError) {
        throw new BadRequestException(
          I18nContext.current()?.t('skills.internalExecutorUnavailable', { args: { message: err.message } })
          ?? `skill-executor unreachable: ${err.message}`,
        );
      }
      throw err;
    } finally {
      // ── 5. Cleanup temporary files ────────────────────────────────────────
      for (const p of tmpPaths) {
        await fsPromises.unlink(p).catch(() => {});
      }
      if (tmpDir) {
        await fsPromises.rmdir(tmpDir).catch(() => {});
      }
    }
  }

  // ── Project assignments ─────────────────────────────────────────────────

  @Post(':id/assign/:projectId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Assign the skill to a project' })
  @ApiParam({ name: 'id',        description: 'Skill UUID' })
  @ApiParam({ name: 'projectId', description: 'Project UUID' })
  @ApiResponse({ status: 400, description: 'Skill not ready (status != ready)' })
  @ApiResponse({ status: 409, description: 'Skill already assigned to the project' })
  assignToProject(
    @Param('id')        id: string,
    @Param('projectId') projectId: string,
    @CurrentUser()      user: any,
  ) {
    return this.service.assignToProject(id, projectId, user.id);
  }

  @Delete(':id/assign/:projectId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove the skill from a project' })
  @ApiParam({ name: 'id',        description: 'Skill UUID' })
  @ApiParam({ name: 'projectId', description: 'Project UUID' })
  async removeFromProject(
    @Param('id')        id: string,
    @Param('projectId') projectId: string,
    @CurrentUser()      user: any,
  ) {
    await this.service.removeFromProject(id, projectId, user.id);
    return { message: 'Assignment removed' };
  }

  // ── Documentation (README / SKILL.md) ───────────────────────────────────

  /**
   * GET /api/skills/:id/docs
   *
   * Returns the content of the skill's documentation file.
   * Looks for SKILL.md first, then README.md in the package root.
   * Accessible by the owner and by anyone who can see the skill (shared+approved).
   */
  @Get(':id/docs')
  @ApiOperation({
    summary: 'Content of the skill documentation file (SKILL.md or README.md)',
    description:
      'Looks for SKILL.md in the package root, then README.md. ' +
      'Returns { filename, content } with the UTF-8 content of the file found.',
  })
  @ApiParam({ name: 'id', description: 'Skill UUID' })
  @ApiResponse({ status: 200, description: '{ filename, content }' })
  @ApiResponse({ status: 404, description: 'No documentation file found' })
  getDocs(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.getDocs(id, user.id);
  }

  // ── Config vars ───────────────────────────────────────────────────────────

  /**
   * System variables always available.
   * The UI shows them as suggestions in the configuration editor.
   */
  @Get('system-vars')
  @ApiOperation({ summary: 'List of system variables available to skills' })
  getSystemVars() {
    return this.service.getSystemVars();
  }

  @Get(':id/config')
  @ApiOperation({ summary: 'Skill configuration state (spec + current values + resolved)' })
  @ApiParam({ name: 'id', description: 'Skill UUID' })
  getConfig(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.getConfigVarsForApi(id, user.id);
  }

  @Put(':id/config/:key')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Set or update a configuration value (owner only)' })
  @ApiParam({ name: 'id',  description: 'Skill UUID' })
  @ApiParam({ name: 'key', description: 'Variable name (must be in runtime.config of SKILL.md)' })
  async upsertConfigVar(
    @Param('id')  id:  string,
    @Param('key') key: string,
    @Body()       dto: UpsertConfigVarDto,
    @CurrentUser() user: any,
  ) {
    await this.service.upsertConfigVar(id, user.id, key, dto.value);
    return { message: `Variable "${key}" updated` };
  }

  @Delete(':id/config/:key')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove the user override — revert to the default value' })
  @ApiParam({ name: 'id',  description: 'Skill UUID' })
  @ApiParam({ name: 'key', description: 'Variable name' })
  async deleteConfigVar(
    @Param('id')  id:  string,
    @Param('key') key: string,
    @CurrentUser() user: any,
  ) {
    await this.service.deleteConfigVar(id, user.id, key);
    return { message: `Override "${key}" removed — the default value will be used` };
  }

  // ── Admin: approve / reject ───────────────────────────────────────────────

  @Post(':id/approve')
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[ADMIN] Approve a shared skill' })
  @ApiParam({ name: 'id', description: 'Skill UUID' })
  async approve(@Param('id') id: string, @CurrentUser() user: any) {
    const result = await this.service.approve(id);
    await this.audit.record({
      actorId: user.id, action: 'skill.review', resource: id,
      outcome: 'ok', ctx: { skillId: id, decision: 'approved' },
    });
    return result;
  }

  @Post(':id/reject')
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[ADMIN] Reject a shared skill (revert it to personal)' })
  @ApiParam({ name: 'id', description: 'Skill UUID' })
  async reject(@Param('id') id: string, @Body() dto: RejectSkillDto, @CurrentUser() user: any) {
    const result = await this.service.reject(id, dto.reason);
    await this.audit.record({
      actorId: user.id, action: 'skill.review', resource: id,
      outcome: 'ok', ctx: { skillId: id, decision: 'rejected' },
    });
    return result;
  }
}
