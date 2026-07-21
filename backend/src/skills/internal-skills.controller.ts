/**
 * @file internal-skills.controller.ts
 *
 * Internal endpoints for the skill-executor sidecar and for inter-skill invocation.
 *
 * These endpoints are NOT exposed to end users: they are called
 * exclusively by skill scripts via a signed run token (x-internal-token).
 *
 * ── Endpoint ────────────────────────────────────────────────────────────────
 *  POST /internal/skills/:id/save-config
 *    Saves a map of config vars for the given skill without requiring
 *    a user JWT. Used by auth_complete.py (and similar scripts) to
 *    persist OAuth tokens/credentials directly into the DB without the
 *    values ever passing through the chat context.
 *
 *  POST /internal/skills/:id/invoke
 *    Executes a skill script on-demand (inter-skill invocation).
 *    Allows a skill to invoke another skill as a "service"
 *    without going through the LangGraph agent.
 *    Input: { script, input, timeout_ms? }
 *    Output: { success, output, raw, duration_ms, exit_code, stderr? }
 *
 * ── Sicurezza ────────────────────────────────────────────────────────────────
 *  - Protected by InternalTokenGuard (x-internal-token header, signed run/daemon token)
 *  - NOT exposed via JwtAuthGuard — unreachable from browser/users
 *  - The /internal/ prefix must be kept out of the CORS whitelist
 */
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { I18nContext } from 'nestjs-i18n';
import {InjectRepository} from '@nestjs/typeorm';
import {Repository} from 'typeorm';
import {IsNumber, IsObject, IsOptional, IsPositive, IsString, Min} from 'class-validator';

import {InternalTokenGuard, internalUserId} from '../common/guards/internal-token.guard';
import {SkillConfigVar} from './skill-config-var.entity';
import {SkillsService} from './skills.service';
import {SkillExecutorUnavailableError} from './skill-executor.client';

// ─── DTO ─────────────────────────────────────────────────────────────────────

class SaveConfigDto {
  /** Key → value map of the config vars to save. */
  @IsObject()
  config: Record<string, string>;
}

class InvokeSkillDto {
  /**
   * Filename of the script to execute (with or without the "scripts/" prefix).
   * Examples: "recommend.py", "scripts/recommend.py", "train.py"
   */
  @IsString()
  script: string;

  /**
   * Input parameters passed to the script via stdin (JSON).
   * Must match the input_schema declared in SKILL.md.
   */
  @IsObject()
  input: Record<string, unknown>;

  /**
   * Execution timeout in milliseconds. Default: 30000 (30s).
   * Increase for training scripts or long-running operations.
   */
  @IsOptional()
  @IsNumber()
  @IsPositive()
  @Min(1000)
  timeout_ms?: number;
}

// ─── Controller ───────────────────────────────────────────────────────────────

@UseGuards(InternalTokenGuard)
@Controller('internal/skills')
export class InternalSkillsController {
  private readonly logger = new Logger(InternalSkillsController.name);

  constructor(
    @InjectRepository(SkillConfigVar)
    private readonly configVarRepo: Repository<SkillConfigVar>,

    private readonly skillsService: SkillsService,
  ) {}

  /**
   * POST /internal/skills/:id/save-config
   *
   * Saves (upserts) a map of config vars for the skill.
   * Respects the `secret` spec declared in SKILL.md: if a key
   * is marked as `secret: true`, it is saved with isSecret=true.
   *
   * Bound to the run-token identity (like `invoke`): the caller may only write
   * config vars on a skill it can access (owner / approved-org / team member),
   * so one skill's run cannot overwrite another skill's stored secrets/config.
   * Fail-closed: no identity → denied.
   */
  @Post(':id/save-config')
  @HttpCode(HttpStatus.OK)
  async saveConfig(
    @Param('id') skillId: string,
    @Body() dto: SaveConfigDto,
    @Req() req: { internalAuth?: { sub?: string } },
  ): Promise<{ ok: boolean; saved: number }> {
    if (!dto.config || typeof dto.config !== 'object') {
      throw new BadRequestException('skills.internalConfigNotObject');
    }

    const callerId = internalUserId(req);
    if (!callerId) {
      throw new ForbiddenException('Run without identity: save-config denied.');
    }
    // Access gate (throws NotFound if the caller cannot reach this skill).
    const skill = await this.skillsService.findOne(skillId, callerId);

    const spec     = skill.configSpec ?? [];
    const entries  = Object.entries(dto.config);
    let   saved    = 0;

    for (const [key, value] of entries) {
      // Determine isSecret from the spec (default: false)
      const specEntry = spec.find((s) => s.key === key);
      const isSecret  = specEntry?.secret ?? false;

      const existing = await this.configVarRepo.findOne({ where: { skillId, key } });
      if (existing) {
        await this.configVarRepo.update(existing.id, { value: String(value), isSecret });
      } else {
        await this.configVarRepo.save(
          this.configVarRepo.create({ skillId, key, value: String(value), isSecret }),
        );
      }
      saved++;
    }

    this.logger.log(
      `[internal] Salvate ${saved} config var(s) per skill ${skillId}: ${Object.keys(dto.config).join(', ')}`,
    );

    return { ok: true, saved };
  }

  /**
   * POST /internal/skills/:id/invoke
   *
   * Executes a skill script on-demand — inter-skill invocation bus.
   *
   * Allows a Python/Node script to invoke another skill as a service:
   *   url = f"{BACKEND_INTERNAL_URL}/internal/skills/{SKILL_ID}/invoke"
   *   body = { "script": "recommend.py", "input": { "seed_categories": [...] } }
   *
   * Constraints:
   *   - The skill must have status='ready'
   *   - The script must exist with mode='task' (not daemon)
   *   - Authenticated by the run token (x-internal-token); skill ownership not
   *     yet verified (TODO F5: bind the invoke to the token identity)
   *
   * Response 200 (success):
   *   { success: true, output: {...}, raw: "...", duration_ms: 123, exit_code: 0 }
   *
   * Response 200 (script error, exit_code != 0):
   *   { success: false, output: null, raw: "", exit_code: 1, stderr: "...", duration_ms: 50 }
   *
   * Response 404: skill not found or not ready
   * Response 400: script not found, daemon script, malformed input
   * Response 503: skill-executor unreachable
   */
  @Post(':id/invoke')
  @HttpCode(HttpStatus.OK)
  async invoke(
    @Param('id') skillId: string,
    @Body() dto: InvokeSkillDto,
    @Req() req: { internalAuth?: { sub?: string } },
  ) {
    // S2: bind the inter-skill invoke to the run-token identity. A skill may only
    // invoke another skill the CALLER can access (owner / approved-org / team member).
    // Fail-closed: no identity → no invoke.
    const callerId = internalUserId(req);
    if (!callerId) {
      throw new ForbiddenException('Run without identity: skill invoke denied.');
    }
    this.logger.log(
      `[internal] invoke skill=${skillId} script="${dto.script}" timeout=${dto.timeout_ms ?? 30000}ms caller=${callerId}`,
    );

    try {
      return await this.skillsService.invoke(
        skillId,
        dto.script,
        dto.input ?? {},
        dto.timeout_ms ?? 30_000,
        callerId,
      );
    } catch (err: any) {
      // Executor unreachable → explicit 503
      if (err instanceof SkillExecutorUnavailableError) {
        throw new ServiceUnavailableException(
          I18nContext.current()?.t('skills.internalExecutorUnavailable', { args: { message: err.message } })
          ?? `skill-executor non raggiungibile: ${err.message}`,
        );
      }
      // NotFoundException and BadRequestException are re-thrown as-is
      throw err;
    }
  }
}
