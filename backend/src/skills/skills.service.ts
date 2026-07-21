/**
 * @file skills.service.ts
 *
 * NestJS service for the Skills system.
 *
 * Responsibilities:
 *   1. Upload and parsing of ZIP packages (SKILL.md with frontmatter + scripts/)
 *   2. Structure and metadata validation
 *   3. Extraction onto the shared volume /app/skills/{id}/
 *   4. Asynchronous trigger of dependency installation (skill-executor)
 *   5. DB CRUD: skill, script, project assignments
 *   6. Loading LangGraph tools for AgentService
 *   7. Building the system prompt portion (Level 1 + Level 2)
 *   8. Admin review for shared skills
 *
 * Upload flow:
 *   ZIP buffer → validate → parse YAML → save DB (pending)
 *   → extract to volume → save scripts → trigger install (background)
 *   → return skill (status: installing)
 *
 * Agent flow:
 *   loadToolsForUser(userId, projectId)
 *     → query DB: personal ready + shared approved ready
 *     → if projectId: add skills assigned to the project
 *     → for each script → buildSkillTool() → DynamicStructuredTool
 *   buildSkillSystemPrompt(userId, projectId)
 *     → Level 1: <available_skills> with metadata of all accessible skills
 *     → Level 2: <skill_instructions> with SKILL.md for skills assigned to the project
 */
import {
  Injectable, Logger, BadRequestException, NotFoundException,
  ForbiddenException, ConflictException, OnModuleInit, Optional,
} from '@nestjs/common';
import { I18nContext } from 'nestjs-i18n';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, Not } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import AdmZip from 'adm-zip';
import * as yaml from 'js-yaml';
import * as fs from 'fs';
import * as path from 'path';
import { DynamicStructuredTool } from '@langchain/core/tools';

import { Skill, SkillScope, SkillConfigSpec } from './skill.entity';
import { SkillScript } from './skill-script.entity';
import { SkillProjectAssignment } from './skill-project-assignment.entity';
import { SkillConfigVar } from './skill-config-var.entity';
import { SkillExecutorClient } from './skill-executor.client';
import { skillNetworkParams, networkCatalog, validNetworkIds, SkillNetwork } from './skill-networks';
import { EgressSyncService } from './egress-sync.service';
import { buildSkillTool, buildToolName } from './skill-tool.factory';
import { mintRunToken } from '../common/internal-token/internal-token';
import { TeamsService } from '../teams/teams.service';
import { ProjectsService } from '../projects/projects.service';
import { FilesService } from '../files/files.service';
import { LlmProviderService } from '../app-config/llm-provider.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { runWithLlmCallContext } from '../usage/llm-call-context';

// ─── Internal types ─────────────────────────────────────────────────────────────

interface SkillYaml {
  name:        string;
  version?:    string;
  description: string;
  author?:     string;
  license?:    string;
  dependencies?: {
    python?:     string[];
    javascript?: string[];
    system?: {
      nix?: string[];   // nixpkgs package names (e.g. ["cowsay", "imagemagick"])
    };
  };
  /** Allowed network domains (C1). Absent/[] = no egress. */
  network?: string[];
  config?: Array<{
    key:          string;
    description:  string;
    default?:     string;
    required?:    boolean;
    secret?:      boolean;
    type?:        'text' | 'json' | 'datasource' | 'collection';
    family?:      'relational' | 'document' | 'keyvalue' | 'fileshare';
  }>;
  scripts?: Array<{
    filename:      string;
    language:      'python' | 'javascript' | 'node';
    description:   string;
    mode?:         'task' | 'daemon';
    llm_callable?: boolean;
    input_schema?: Record<string, unknown>;
  }>;
}

/** Names of the system variables always available in the scripts */
const SYSTEM_VAR_NAMES = ['UPLOAD_DIR', 'SKILLS_OUTPUT_DIR', 'SKILLS_DIR', 'APP_NAME', 'APP_URL'] as const;

// ─── Name validation ─────────────────────────────────────────────────────────

/** Skill name format: lowercase, digits, hyphens. E.g.: "data-analyzer" */
const VALID_SKILL_NAME = /^[a-z][a-z0-9-]{0,63}$/;

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class SkillsService implements OnModuleInit {
  private readonly logger       = new Logger(SkillsService.name);
  private readonly skillsBase:  string;

  constructor(
    @InjectRepository(Skill)
    private readonly skillRepo:      Repository<Skill>,
    @InjectRepository(SkillScript)
    private readonly scriptRepo:     Repository<SkillScript>,
    @InjectRepository(SkillProjectAssignment)
    private readonly assignmentRepo: Repository<SkillProjectAssignment>,
    @InjectRepository(SkillConfigVar)
    private readonly configVarRepo:  Repository<SkillConfigVar>,
    private readonly executorClient: SkillExecutorClient,
    private readonly config:         ConfigService,
    private readonly teamsService:   TeamsService,
    private readonly projectsService: ProjectsService,
    private readonly filesService:   FilesService,
    private readonly egressSync:     EgressSyncService,
    private readonly llmProvider:    LlmProviderService,
    private readonly notifications:  NotificationsService,
    @Optional() private readonly audit?: AuditService,
  ) {
    this.skillsBase = config.get<string>('SKILLS_BASE_PATH', '/app/skills');

    // Create the base directory at boot if it does not exist.
    // In Docker it is an already-mounted volume; in local development it is created here.
    try {
      fs.mkdirSync(this.skillsBase, { recursive: true });
    } catch (err: any) {
      this.logger.warn(
        `Unable to create SKILLS_BASE_PATH "${this.skillsBase}": ${err.message}. ` +
        `Set SKILLS_BASE_PATH=./uploads/skills in the .env for local development.`,
      );
    }
  }

  // ── Upload & install ───────────────────────────────────────────────────────

  /**
   * Processes a ZIP file uploaded by the user:
   *   1. Validates the package structure
   *   2. Creates the DB record
   *   3. Extracts the files onto the volume
   *   4. Starts the installation in background
   *
   * @returns The created skill (status: 'installing')
   */
  async uploadAndCreate(userId: string, fileBuffer: Buffer): Promise<Skill> {
    // ─ ZIP analysis ────────────────────────────────────────────────────────────
    const { manifest: skillYaml, entries } = this.parseAndValidateZip(fileBuffer);

    // Manifest validation (SKILL.md frontmatter)
    this.validateSkillYaml(skillYaml);

    // Name uniqueness for the user
    await this.assertNameAvailable(userId, skillYaml.name, 'personal', null);

    // ─ DB record creation ───────────────────────────────────────────────────
    const configSpec: SkillConfigSpec[] | null = skillYaml.config?.length
      ? skillYaml.config.map((c) => ({
          key:         c.key,
          description: c.description,
          default:     c.default,
          required:    c.required ?? false,
          secret:      c.secret   ?? false,
          ...(c.type ? { type: c.type } : {}),
          ...(c.family ? { family: c.family } : {}),
        }))
      : null;

    const skill = this.skillRepo.create({
      ownerId:     userId,
      name:        skillYaml.name,
      version:     skillYaml.version ?? '1.0.0',
      description: skillYaml.description,
      author:      skillYaml.author ?? null,
      license:     skillYaml.license ?? null,
      status:      'pending',
      // No script in the manifest → descriptive skill (pure agentskills.io, via sandbox).
      kind:        (skillYaml.scripts?.length ?? 0) > 0 ? 'typed' : 'descriptive',
      scope:       'personal',
      isApproved:  false,
      pythonDeps:  skillYaml.dependencies?.python        ?? [],
      jsDeps:      skillYaml.dependencies?.javascript    ?? [],
      nixDeps:     skillYaml.dependencies?.system?.nix   ?? [],
      networkDomains: skillYaml.network                  ?? [],
      configSpec,
    });

    const saved = await this.skillRepo.save(skill);

    // ─ Extraction onto the volume ────────────────────────────────────────────
    const skillDir = path.join(this.skillsBase, saved.id);
    this.extractZipToVolume(entries, skillDir);
    try { fs.chmodSync(skillDir, 0o777); } catch { /* ignore on filesystems without chmod support */ }

    // ─ Script records ────────────────────────────────────────────────────────
    const scripts: SkillScript[] = [];
    for (const s of skillYaml.scripts ?? []) {
      const scriptRecord = this.scriptRepo.create({
        skillId:     saved.id,
        filename:    s.filename,
        language:    s.language,
        description: s.description,
        mode:        s.mode ?? 'task',
        llmCallable: s.llm_callable ?? true,
        inputSchema: s.input_schema ?? { type: 'object', properties: {} },
      });
      scripts.push(scriptRecord);
    }
    if (scripts.length > 0) await this.scriptRepo.save(scripts);

    // Update packagePath
    await this.skillRepo.update(saved.id, { packagePath: skillDir });

    // ─ Trigger install in background ─────────────────────────────────────────
    this.triggerInstallBackground(
      saved.id,
      skillYaml.dependencies?.python      ?? [],
      skillYaml.dependencies?.javascript  ?? [],
      skillYaml.dependencies?.system?.nix ?? [],
    );

    this.logger.log(`Skill "${skillYaml.name}" uploaded (id: ${saved.id}, user: ${userId})`);

    await this.audit?.record({
      actorId: userId, action: 'skill.create', resource: saved.name,
      outcome: 'ok', ctx: { skillId: saved.id },
    });

    return this.findOne(saved.id, userId);
  }

  /**
   * Installs a skill from the marketplace into the user's personal collection.
   *
   * The source skill must be shared+approved.
   * The installation creates a fully independent copy:
   *   - New directory on the volume with the skill files (excluding .deps/)
   *   - New Skill record in the DB (ownerId = userId, scope = personal)
   *   - Dependencies reinstalled by the package manager
   *
   * The copy is independent from the original: it has its own lifecycle,
   * configuration and project assignments.
   */
  async installFromMarketplace(sourceId: string, userId: string): Promise<Skill> {
    const source = await this.skillRepo.findOne({
      where: { id: sourceId, scope: 'org', isApproved: true },
      relations: { scripts: true },
    });
    if (!source) throw new NotFoundException('skills.notFoundInMarketplace');
    if (!source.packagePath || !fs.existsSync(source.packagePath)) {
      throw new BadRequestException('skills.filesNotAvailable');
    }

    // Name uniqueness for the user
    await this.assertNameAvailable(userId, source.name, 'personal', null);

    // Create the DB record (copy metadata from the source)
    const skill = this.skillRepo.create({
      ownerId:      userId,
      name:         source.name,
      version:      source.version,
      description:  source.description,
      author:       source.author,
      license:      source.license,
      status:       'pending',
      kind:         source.kind,
      scope:        'personal',
      isApproved:   false,
      pythonDeps:   source.pythonDeps,
      jsDeps:       source.jsDeps,
      nixDeps:      source.nixDeps ?? [],
      configSpec:   source.configSpec,
      sourceSkillId: source.id,
    });
    const saved = await this.skillRepo.save(skill);

    // Copy the skill files (excluding .deps/ — it will be reinstalled)
    const targetDir = path.join(this.skillsBase, saved.id);
    this.copySkillFiles(source.packagePath, targetDir);
    await this.skillRepo.update(saved.id, { packagePath: targetDir });

    // Copy the script records
    const scripts = (source.scripts ?? []).map((s) =>
      this.scriptRepo.create({
        skillId:     saved.id,
        filename:    s.filename,
        language:    s.language,
        description: s.description,
        mode:        s.mode ?? 'task',
        llmCallable: s.llmCallable ?? true,
        inputSchema: s.inputSchema,
      }),
    );
    if (scripts.length > 0) await this.scriptRepo.save(scripts);

    // Start dependency installation in background
    this.triggerInstallBackground(saved.id, source.pythonDeps, source.jsDeps, source.nixDeps ?? []);

    this.logger.log(
      `Skill "${source.name}" installed from the marketplace (user: ${userId}, source: ${source.id})`,
    );
    return this.findOne(saved.id, userId);
  }

  /**
   * Recursive copy of a skill directory excluding `.deps/`.
   * `.deps/` contains the installed dependencies — they are reinstalled
   * in the target directory by triggerInstallBackground.
   */
  private copySkillFiles(sourceDir: string, targetDir: string): void {
    fs.mkdirSync(targetDir, { recursive: true });
    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
      // Exclude installed dependencies: they will be reinstalled in the target dir
      if (entry.name === '.deps' || entry.name === '.nix') continue;
      const src = path.join(sourceDir, entry.name);
      const dst = path.join(targetDir, entry.name);
      if (entry.isDirectory()) {
        this.copySkillFiles(src, dst);
      } else {
        fs.copyFileSync(src, dst);
      }
    }
  }

  /**
   * Reinstalls the skill: updates metadata from disk (SKILL.md + script descriptions)
   * and re-runs the installation of Python/JS/Nix dependencies.
   *
   * What gets updated from the new SKILL.md:
   *   - version, description, author, license
   *   - pythonDeps, jsDeps, nixDeps (used for reinstallation)
   *   - configSpec (schema of the configuration variables)
   *   - script: description, inputSchema, language, mode of each script
   *   - new scripts → added; scripts removed from the yaml → deleted from the DB
   *
   * What is NEVER touched:
   *   - name, ownerId, scope, isApproved, enabled, packagePath
   *   - SkillConfigVar: the values set by the user remain unchanged
   *
   * Only the owner can reinstall their own skill.
   */
  async reinstall(id: string, userId: string): Promise<Skill> {
    const skill = await this.findOwned(id, userId);

    if (skill.status === 'installing') {
      throw new BadRequestException('skills.installingInProgress');
    }

    // ── 1. Update metadata from disk (non-blocking: if SKILL.md is missing, proceed) ──
    await this.refreshMetadataFromDisk(skill);

    // ── 2. Re-read the updated deps (they may have changed in the new yaml) ──
    const refreshed = await this.skillRepo.findOne({ where: { id } });
    const pythonDeps = refreshed?.pythonDeps ?? skill.pythonDeps;
    const jsDeps     = refreshed?.jsDeps     ?? skill.jsDeps;
    const nixDeps    = refreshed?.nixDeps    ?? skill.nixDeps ?? [];

    // ── 3. Start dependency reinstallation ─────────────────────────────────────
    await this.skillRepo.update(id, { status: 'pending', installLog: null });
    this.triggerInstallBackground(id, pythonDeps, jsDeps, nixDeps);

    return this.findOne(id, userId);
  }

  /**
   * Updates an existing skill by uploading a new ZIP.
   *
   * The files on the volume are overwritten; the metadata is re-read from the new
   * SKILL.md via refreshMetadataFromDisk. The user's SkillConfigVar are
   * preserved. The skill name cannot change.
   *
   * Only the owner can update their own skill.
   */
  async updateFromZip(id: string, userId: string, fileBuffer: Buffer): Promise<Skill> {
    const skill = await this.findOwned(id, userId);

    if (skill.status === 'installing') {
      throw new BadRequestException('skills.installingInProgress');
    }

    const { manifest: skillYaml, entries } = this.parseAndValidateZip(fileBuffer);
    this.validateSkillYaml(skillYaml);

    if (skillYaml.name !== skill.name) {
      throw new BadRequestException(
        I18nContext.current()?.t('skills.zipNameMismatch', { args: { zipName: skillYaml.name, skillName: skill.name } })
        ?? `The skill name in the ZIP ("${skillYaml.name}") does not match the current skill ("${skill.name}")`,
      );
    }

    const skillDir = skill.packagePath ?? path.join(this.skillsBase, skill.id);
    this.extractZipToVolume(entries, skillDir);
    try { fs.chmodSync(skillDir, 0o777); } catch { /* ignore */ }

    await this.refreshMetadataFromDisk(skill);

    const refreshed  = await this.skillRepo.findOne({ where: { id } });
    const pythonDeps = refreshed?.pythonDeps ?? skill.pythonDeps;
    const jsDeps     = refreshed?.jsDeps     ?? skill.jsDeps;
    const nixDeps    = refreshed?.nixDeps    ?? skill.nixDeps ?? [];

    await this.skillRepo.update(id, { status: 'pending', installLog: null });
    this.triggerInstallBackground(id, pythonDeps, jsDeps, nixDeps);

    this.logger.log(`Skill "${skill.name}" updated from ZIP (user: ${userId})`);
    return this.findOne(id, userId);
  }

  /**
   * Synchronizes a skill installed from the marketplace with the current version of the source.
   *
   * Overwrites the files with those of the source skill (shared+approved) and updates
   * the metadata via refreshMetadataFromDisk. The user's SkillConfigVar are preserved.
   *
   * Requires that the skill has sourceSkillId set (installed from the marketplace).
   */
  async syncFromSource(id: string, userId: string): Promise<Skill> {
    const skill = await this.findOwned(id, userId);

    if (!skill.sourceSkillId) {
      throw new BadRequestException('skills.notInstalledFromMarketplace');
    }

    if (skill.status === 'installing') {
      throw new BadRequestException('skills.installingInProgress');
    }

    const source = await this.skillRepo.findOne({
      where: { id: skill.sourceSkillId, scope: 'org', isApproved: true },
    });
    if (!source) {
      throw new BadRequestException('skills.sourceNoLongerAvailable');
    }
    if (!source.packagePath || !fs.existsSync(source.packagePath)) {
      throw new BadRequestException('skills.sourceFilesNotAvailable');
    }

    const skillDir = skill.packagePath ?? path.join(this.skillsBase, skill.id);
    this.copySkillFiles(source.packagePath, skillDir);
    try { fs.chmodSync(skillDir, 0o777); } catch { /* ignore */ }

    await this.refreshMetadataFromDisk(skill);

    const refreshed  = await this.skillRepo.findOne({ where: { id } });
    const pythonDeps = refreshed?.pythonDeps ?? skill.pythonDeps;
    const jsDeps     = refreshed?.jsDeps     ?? skill.jsDeps;
    const nixDeps    = refreshed?.nixDeps    ?? skill.nixDeps ?? [];

    await this.skillRepo.update(id, { status: 'pending', installLog: null });
    this.triggerInstallBackground(id, pythonDeps, jsDeps, nixDeps);

    this.logger.log(
      `Skill "${skill.name}" synced from source (user: ${userId}, source: ${source.id}, ` +
      `v${skill.version} → v${source.version})`,
    );
    return this.findOne(id, userId);
  }

  /**
   * Updates the skill metadata by reading SKILL.md from the volume.
   *
   * Preserves all identity fields (name, ownerId, scope, isApproved, enabled,
   * packagePath) and the user values (SkillConfigVar).
   * Updates: version, description, author, license, deps, configSpec and script records.
   *
   * If SKILL.md is not found or is invalid, logs a warning and returns without error
   * — the reinstallation of dependencies proceeds anyway.
   */
  private async refreshMetadataFromDisk(skill: Skill): Promise<void> {
    const skillDir    = skill.packagePath ?? path.join(this.skillsBase, skill.id);
    const skillMdPath = this.findSkillMdPath(skillDir);

    if (!skillMdPath) {
      this.logger.warn(
        `SKILL.md not found for "${skill.name}" (${skillDir}) — ` +
        `metadata update skipped, dependency reinstallation continues.`,
      );
      return;
    }

    let skillYaml: SkillYaml;
    try {
      ({ manifest: skillYaml } = parseSkillMd(fs.readFileSync(skillMdPath, 'utf-8')));
      this.validateSkillYaml(skillYaml);
    } catch (err: any) {
      this.logger.warn(
        `Invalid SKILL.md frontmatter for "${skill.name}": ${err.message} — ` +
        `metadata update skipped, dependency reinstallation continues.`,
      );
      return;
    }

    // ── Update the skill columns (NO name/ownerId/scope/isApproved/enabled) ──
    const configSpec: SkillConfigSpec[] | null = skillYaml.config?.length
      ? skillYaml.config.map((c) => ({
          key:         c.key,
          description: c.description,
          default:     c.default,
          required:    c.required ?? false,
          secret:      c.secret   ?? false,
          ...(c.type ? { type: c.type } : {}),
          ...(c.family ? { family: c.family } : {}),
        }))
      : null;

    await this.skillRepo.update(skill.id, {
      version:     skillYaml.version    ?? skill.version,
      description: skillYaml.description,
      author:      skillYaml.author     ?? null,
      license:     skillYaml.license    ?? null,
      kind:        (skillYaml.scripts?.length ?? 0) > 0 ? 'typed' : 'descriptive',
      pythonDeps:  skillYaml.dependencies?.python        ?? [],
      jsDeps:      skillYaml.dependencies?.javascript    ?? [],
      nixDeps:     skillYaml.dependencies?.system?.nix   ?? [],
      networkDomains: skillYaml.network                  ?? [],
      configSpec,
    });

    // ── Sync the scripts ─────────────────────────────────────────────────────────
    const existingScripts   = await this.scriptRepo.find({ where: { skillId: skill.id } });
    const existingByFilename = new Map(existingScripts.map((s) => [s.filename, s]));
    const yamlScripts        = skillYaml.scripts ?? [];
    const yamlFilenames      = new Set(yamlScripts.map((s) => s.filename));

    // Update or create scripts present in the new yaml
    for (const s of yamlScripts) {
      const existing = existingByFilename.get(s.filename);
      if (existing) {
        await this.scriptRepo.update(existing.id, {
          language:    s.language,
          description: s.description,
          mode:        s.mode ?? 'task',
          llmCallable: s.llm_callable ?? true,
          inputSchema: s.input_schema ?? existing.inputSchema,
        });
      } else {
        await this.scriptRepo.save(
          this.scriptRepo.create({
            skillId:     skill.id,
            filename:    s.filename,
            language:    s.language,
            description: s.description,
            mode:        s.mode ?? 'task',
            llmCallable: s.llm_callable ?? true,
            inputSchema: s.input_schema ?? { type: 'object', properties: {} },
          }),
        );
        this.logger.log(`Script "${s.filename}" added to skill "${skill.name}"`);
      }
    }

    // Remove scripts no longer present in the yaml
    for (const existing of existingScripts) {
      if (!yamlFilenames.has(existing.filename)) {
        await this.scriptRepo.remove(existing);
        this.logger.log(
          `Script "${existing.filename}" removed from skill "${skill.name}" (not present in the new SKILL.md)`,
        );
      }
    }

    this.logger.log(
      `Metadata updated from disk for skill "${skill.name}" ` +
      `(v${skill.version} → v${skillYaml.version ?? skill.version}, ` +
      `${yamlScripts.length} scripts)`,
    );
  }

  // ── S3: descriptive → typed compilation (AI proposes, owner confirms) ──

  /** Code scripts bundled in the skill, candidates to become typed tools. */
  private listBundledScripts(dir: string): { filename: string; language: 'python' | 'node' }[] {
    const out: { filename: string; language: 'python' | 'node' }[] = [];
    const SKIP = new Set(['.deps', '.nix', '.git', 'node_modules', '__pycache__']);
    const walk = (rel: string) => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (SKIP.has(e.name)) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) { walk(r); continue; }
        if (e.name.endsWith('.py')) out.push({ filename: r, language: 'python' });
        else if (/\.(c?js|mjs)$/.test(e.name)) out.push({ filename: r, language: 'node' });
      }
    };
    walk('');
    return out;
  }

  /** Lists ALL the skill files (relative paths): scripts, references, assets, templates… */
  private listAllSkillFiles(dir: string): string[] {
    const out: string[] = [];
    const SKIP = new Set(['.deps', '.nix', '.git', 'node_modules', '__pycache__']);
    const walk = (rel: string) => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (SKIP.has(e.name) || e.name === '.staged-version') continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(r);
        else if (e.isFile()) out.push(r);
      }
    };
    walk('');
    return out.slice(0, 200);
  }

  /** Extracts the first JSON array from the text (tolerant of code-fence / extra text). */
  private parseJsonArrayLoose(text: string): any[] | null {
    const cleaned = text.replace(/```(?:json)?/gi, '').trim();
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');
    if (start !== -1 && end > start) {
      try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { /* */ }
    }
    try { const o = JSON.parse(cleaned); return Array.isArray(o) ? o : (Array.isArray(o?.scripts) ? o.scripts : null); } catch { return null; }
  }

  /**
   * S3: the AI reads the bundled scripts + SKILL.md and PROPOSES a typed manifest
   * (filename/language/description/input_schema) for each. It applies nothing:
   * the proposal must be reviewed and confirmed, then passed to applyCompilation.
   */
  async proposeCompilation(id: string, userId: string): Promise<{
    scripts: Array<{ filename: string; language: string; description: string; input_schema: Record<string, unknown>; llm_callable: boolean; code?: string }>;
    synthesized: boolean;
  }> {
    const skill = await this.findOwned(id, userId);
    const dir = skill.packagePath ?? path.join(this.skillsBase, id);
    const bundled = this.listBundledScripts(dir);   // present scripts = RESOURCES (not tools)

    const mdPath  = this.findSkillMdPath(dir);
    const skillMd = mdPath ? stripFrontmatter(fs.readFileSync(mdPath, 'utf-8')).slice(0, 8000) : '';
    const docs    = this.gatherSkillDocs(dir, mdPath);
    const allFiles = this.listAllSkillFiles(dir);   // all files (assets/templates/data included)

    // The already-present scripts are CONTEXT/resources that the generated tool can use,
    // they are not "wrapped" 1:1. At runtime they live in the same folder as the entrypoint.
    const resourceBlocks = bundled.map((s) => {
      let code = '';
      try { code = fs.readFileSync(path.join(dir, s.filename), 'utf-8').slice(0, 4000); } catch { /* */ }
      return `### ${s.filename} (${s.language})\n\`\`\`\n${code}\n\`\`\``;
    }).join('\n\n');

    const prompt =
      'Compile a "skill" (agentskills.io format) into one or more COMPLETE typed TOOLs. ' +
      'DO NOT just wrap the existing scripts: GENERATE an entrypoint that implements the described functionality, ' +
      'USING if necessary ANY file present in the skill (scripts, documents in references/, assets, templates, data, etc.): ' +
      'at runtime ALL the skill files are in the SAME folder as the entrypoint, accessible with a relative path ' +
      '(import modules, read files with open()/fs, call scripts via subprocess, e.g. `scripts/<file>` or `assets/<file>`). ' +
      'Contract of each tool: it READS the input as JSON from stdin and PRINTS the result as JSON to stdout; prefer the standard library. ' +
      'For each one provide: filename (NEW, distinct from the existing files, e.g. scripts/tool.py), language (python|node), ' +
      'description (what it does and when to use it, in English), input_schema (JSON Schema {"type":"object","required":[...],"properties":{...}} with English descriptions), ' +
      'and code (COMPLETE source of the entrypoint).\n' +
      'Reply ONLY with a JSON array (no text, no code-fence):\n' +
      '[{"filename":"scripts/tool.py","language":"python","description":"...","input_schema":{...},"llm_callable":true,"code":"<complete source>"}]\n\n' +
      `INSTRUCTIONS (SKILL.md):\n${skillMd}` +
      (allFiles.length ? `\n\nFILES PRESENT IN THE SKILL (all available at runtime, relative path):\n${allFiles.join('\n')}` : '') +
      (resourceBlocks ? `\n\nSCRIPT/RESOURCE CONTENT (reusable by the entrypoint):\n${resourceBlocks}` : '') +
      (docs ? `\n\nDOCUMENTATION:\n${docs}` : '');

    const model = await this.llmProvider.getModel();
    // Compile proposals are batch work: they yield to interactive traffic (P1-F2).
    const res   = await runWithLlmCallContext({ priority: 'batch', origin: 'system' }, () => model.invoke(prompt));
    const text  = typeof res.content === 'string' ? res.content : JSON.stringify(res.content);
    const parsed = this.parseJsonArrayLoose(text);

    // Always SYNTHESIS: every tool has `code` (generated entrypoint). Filename sanitized and
    // distinct from the existing resource scripts (do not clobber a skill file).
    const knownNames = new Set(bundled.map((s) => s.filename));
    const result = (parsed ?? [])
      .filter((p: any) => p && typeof p.code === 'string')
      .map((p: any) => {
        const language = ['python', 'node', 'javascript'].includes(p.language) ? p.language : 'python';
        let fn = (typeof p.filename === 'string' ? p.filename : '').replace(/^\/+/, '');
        if (!fn || fn.includes('..')) fn = `scripts/tool.${language === 'python' ? 'py' : 'js'}`;
        if (!fn.includes('/')) fn = `scripts/${fn}`;
        if (knownNames.has(fn)) fn = fn.replace(/([^/]+)$/, 'tool_$1');   // avoid overwriting a resource
        return {
          filename:     fn,
          language,
          description:  typeof p.description === 'string' ? p.description : '',
          input_schema: (p.input_schema && typeof p.input_schema === 'object') ? p.input_schema : { type: 'object', properties: {} },
          llm_callable: p.llm_callable !== false,
          code:         p.code as string,
        };
      });

    if (result.length === 0) {
      throw new BadRequestException(
        I18nContext.current()?.t('skills.compileProposalFailed') ?? 'The AI did not produce a valid proposal. Try again or edit manually.',
      );
    }
    this.logger.log(`Compilation proposal for "${skill.name}": ${result.length} tools generated (bundle resources: ${bundled.length})`);
    return { scripts: result, synthesized: true };
  }

  /** Gathers the text of the bundled documentation files (references/*.md, *.txt) for the synthesis. */
  private gatherSkillDocs(dir: string, skillMdPath: string | null): string {
    const out: string[] = [];
    let budget = 6000;
    const walk = (rel: string) => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (budget <= 0) return;
        if (['.deps', '.nix', '.git', 'node_modules'].includes(e.name)) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        const abs = path.join(dir, r);
        if (e.isDirectory()) { walk(r); continue; }
        if (abs === skillMdPath) continue;
        if (/\.(md|txt|rst)$/i.test(e.name)) {
          try {
            const c = fs.readFileSync(abs, 'utf-8').slice(0, budget);
            out.push(`### ${r}\n${c}`);
            budget -= c.length;
          } catch { /* */ }
        }
      }
    };
    walk('');
    return out.join('\n\n');
  }

  /**
   * S3: applies the confirmed compilation — writes `runtime.scripts` into the frontmatter
   * of SKILL.md (source of truth, one-directional) and reinstalls → the skill becomes
   * `typed` and the scripts register as LangGraph tools.
   */
  async applyCompilation(
    id: string,
    userId: string,
    scripts: Array<{ filename: string; language: string; description: string; input_schema: Record<string, unknown>; llm_callable?: boolean; code?: string }>,
  ): Promise<Skill> {
    const skill = await this.findOwned(id, userId);
    if (!scripts?.length) {
      throw new BadRequestException(
        I18nContext.current()?.t('skills.compileNoScripts') ?? 'No script to compile.',
      );
    }

    const dir    = skill.packagePath ?? path.join(this.skillsBase, id);
    const mdPath = this.findSkillMdPath(dir);
    if (!mdPath) {
      throw new BadRequestException(
        I18nContext.current()?.t('skills.skillMdNotFound') ?? 'SKILL.md not found for this skill.',
      );
    }

    // SYNTHESIZED scripts (with `code`): write the source to disk (path-traversal guard).
    for (const s of scripts) {
      if (typeof s.code !== 'string') continue;
      const target = path.resolve(dir, s.filename);
      if (target !== dir && !target.startsWith(dir + path.sep)) {
        throw new BadRequestException(`Invalid filename: ${s.filename}`);
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, s.code);
      this.logger.log(`Generated script written: ${s.filename} (${s.code.length}B)`);
    }

    const raw  = fs.readFileSync(mdPath, 'utf-8');
    const fm   = extractFrontmatter(raw);
    const head: Record<string, any> = fm ? ((yaml.load(fm.frontmatter) as Record<string, any>) ?? {}) : { name: skill.name, description: skill.description };
    const body = fm ? fm.body : raw;

    head.runtime = {
      ...(head.runtime ?? {}),
      scripts: scripts.map((s) => ({
        filename:     s.filename,
        language:     s.language,
        description:  s.description,
        input_schema: s.input_schema,
        ...(s.llm_callable === false ? { llm_callable: false } : {}),
      })),
    };

    const newFm = yaml.dump(head, { lineWidth: -1, noRefs: true });
    fs.writeFileSync(mdPath, `---\n${newFm}---\n\n${body}`);
    this.logger.log(`Skill "${skill.name}" compiled to typed (${scripts.length} scripts): frontmatter updated`);

    // Compiled: the suggestion counter starts over (new typed life of the skill).
    await this.skillRepo.update(id, { sandboxRuns: 0 });

    // Re-derive from disk (kind→typed, create the SkillScript) and reinstall.
    return this.reinstall(id, userId);
  }

  // ── Compile-to-tool suggestion (descriptive skills) ────────────────────────

  /** Successful sandbox runs after which the owner is nudged to compile (reset by applyCompilation). */
  private static readonly COMPILE_SUGGEST_THRESHOLD = 5;

  /**
   * Attributes a successful sandbox execution to the named descriptive skills:
   * increments their counter and notifies the OWNER exactly once, when the
   * counter reaches the threshold. Fire-and-forget from the sandbox tool —
   * never throws.
   */
  async recordSandboxUse(names: string[]): Promise<void> {
    for (const name of new Set(names)) {
      try {
        const skill = await this.skillRepo.findOne({ where: { name, kind: 'descriptive' } });
        if (!skill) continue;
        await this.skillRepo.increment({ id: skill.id }, 'sandboxRuns', 1);
        const runs = skill.sandboxRuns + 1;
        if (runs === SkillsService.COMPILE_SUGGEST_THRESHOLD) {
          await this.notifications.create({
            userId:    skill.ownerId,
            source:    'skill',
            sourceId:  skill.id,
            eventType: 'compile_suggested',
            payload:   { skillName: skill.name, runs },
          });
          this.logger.log(`Skill "${skill.name}": ${runs} successful sandbox runs → compile-to-tool suggested to the owner`);
        }
      } catch (err: any) {
        this.logger.warn(`recordSandboxUse("${name}") failed: ${err?.message ?? err}`);
      }
    }
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  /**
   * Lists the skills accessible to the user:
   *   - Their own (any status and scope)
   *   - The shared approved ones (of others)
   */
  /**
   * Egress allowlist (C1): union of the domains declared by the enabled skills
   * (the `org` ones count only if approved). Used to generate the egress-proxy config
   * (`<<< SKILL_DOMAINS >>>` section of egress-proxy/squid.conf).
   */
  async getEgressAllowlist(): Promise<string[]> {
    const skills = await this.skillRepo.find({ where: { enabled: true } });
    const domains = new Set<string>();
    for (const s of skills) {
      if (s.scope === 'org' && !s.isApproved) continue;
      for (const d of s.networkDomains ?? []) {
        const clean = d.trim().toLowerCase();
        if (clean) domains.add(clean);
      }
    }
    return [...domains].sort();
  }

  /**
   * At boot, realigns the egress-proxy include file with the current DB state
   * (no-op if the egress overlay is not active). Covers the case of domains changed
   * while the backend was down.
   */
  async onModuleInit(): Promise<void> {
    await this.syncEgress();
  }

  /**
   * Regenerates the egress allowlist and writes it to the egress-proxy.
   * Must be called after every mutation that changes `getEgressAllowlist()`
   * (approve / enable / scope / remove / install ready). Best-effort: it must
   * never make the calling operation fail.
   */
  private async syncEgress(): Promise<void> {
    try {
      await this.egressSync.sync(await this.getEgressAllowlist());
    } catch (err: any) {
      this.logger.warn(`Egress allowlist sync failed: ${err.message}`);
    }
  }

  async findAll(userId: string): Promise<Skill[]> {
    const teamIds = await this.teamsService.teamIdsForUser(userId);
    const where: Record<string, unknown>[] = [
      { ownerId: userId },
      { scope: 'org', isApproved: true, ownerId: Not(userId) },
    ];
    if (teamIds.length) {
      where.push({ scope: 'team', teamId: In(teamIds), ownerId: Not(userId) });
    }
    return this.skillRepo.find({
      where,
      relations: { scripts: true },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Detail of a single skill:
   *   - own (any scope/status)
   *   - shared approved of other users
   */
  async findOne(id: string, userId: string): Promise<Skill> {
    const teamIds = await this.teamsService.teamIdsForUser(userId);
    const where: Record<string, unknown>[] = [
      { id, ownerId: userId },
      { id, scope: 'org', isApproved: true },
    ];
    if (teamIds.length) {
      where.push({ id, scope: 'team', teamId: In(teamIds) });
    }
    const skill = await this.skillRepo.findOne({
      where,
      relations: { scripts: true },
    });
    if (!skill) throw new NotFoundException(
      I18nContext.current()?.t('skills.notFound', { args: { id } }) ?? `Skill "${id}" not found`,
    );
    return skill;
  }

  /** Returns a skill only if the user is its owner (for write operations). */
  async findOwned(id: string, userId: string): Promise<Skill> {
    const skill = await this.skillRepo.findOne({
      where: { id, ownerId: userId },
      relations: { scripts: true },
    });
    if (!skill) throw new NotFoundException(
      I18nContext.current()?.t('skills.notFoundOrNotOwned', { args: { id } }) ?? `Skill "${id}" not found or not owned by you`,
    );
    return skill;
  }

  /**
   * Updates scope, description and/or enabled of a skill (only the skill owner).
   * Publishing:
   *   - team → requires status ready + that the user is admin or owner of the `teamId`; no review
   *   - org  → requires status ready; goes into the admin review queue (isApproved=false)
   *   - personal → reset approval and teamId
   * `isAdmin` comes from the controller (the user's role).
   */
  async update(
    id: string,
    userId: string,
    dto: { description?: string; scope?: SkillScope; teamId?: string | null; enabled?: boolean; loadOnFirst?: boolean },
    isAdmin = false,
  ): Promise<Skill> {
    const skill = await this.findOwned(id, userId);

    const nextScope  = dto.scope ?? skill.scope;
    const nextTeamId = nextScope === 'team'
      ? (dto.teamId !== undefined ? dto.teamId : skill.teamId)
      : null;

    const scopeChanged = dto.scope !== undefined && dto.scope !== skill.scope;
    const teamChanged  = nextScope === 'team' && nextTeamId !== skill.teamId;

    if ((scopeChanged || teamChanged) && nextScope !== 'personal') {
      if (skill.status !== 'ready') {
        throw new BadRequestException(
          I18nContext.current()?.t('skills.notReadyForPublish', { args: { status: skill.status } })
          ?? `The skill must have status "ready" to be published (current: "${skill.status}")`,
        );
      }
      if (nextScope === 'team') {
        if (!nextTeamId) throw new BadRequestException('skills.teamIdRequired');
        if (!isAdmin && !(await this.teamsService.isOwner(nextTeamId, userId))) {
          throw new ForbiddenException('skills.onlyAdminOrTeamOwnerCanPublish');
        }
      }
      await this.assertNameAvailable(userId, skill.name, nextScope, nextTeamId, skill.id);
    }

    if (dto.description !== undefined) skill.description = dto.description;
    if (dto.scope !== undefined || dto.teamId !== undefined) {
      skill.scope  = nextScope;
      skill.teamId = nextTeamId;
      // org requires review (isApproved=false until an admin approves);
      // team and personal do not use the gate → isApproved reset.
      if (nextScope !== 'org' || scopeChanged) skill.isApproved = false;
    }
    if (dto.enabled !== undefined) skill.enabled = dto.enabled;
    if (dto.loadOnFirst !== undefined) skill.loadOnFirst = dto.loadOnFirst;

    await this.skillRepo.save(skill);
    // scope/enabled can change the allowlist (a non-approved org does not count).
    await this.syncEgress();
    if ((scopeChanged || teamChanged) && nextScope !== 'personal') {
      await this.audit?.record({
        actorId: userId, action: 'skill.publish', resource: skill.name,
        outcome: 'ok', ctx: { skillId: skill.id, scope: nextScope, teamId: nextTeamId },
      });
    }
    return this.findOne(id, userId);
  }

  /**
   * Enables or disables a skill (only owner).
   * Semantic shortcut for update({ enabled }) — exposed as a dedicated endpoint
   * to allow a quick toggle from the UI without having to send the other fields.
   */
  async setEnabled(id: string, userId: string, enabled: boolean): Promise<Skill> {
    await this.findOwned(id, userId); // ownership check
    await this.skillRepo.update(id, { enabled });
    this.logger.log(`Skill ${id} ${enabled ? 'enabled' : 'disabled'} (user: ${userId})`);
    // enabled changes the union of domains → realign the egress-proxy.
    await this.syncEgress();
    await this.audit?.record({
      actorId: userId, action: 'skill.enable_toggle', resource: id,
      outcome: 'ok', ctx: { skillId: id, enabled },
    });
    return this.findOne(id, userId);
  }

  /**
   * Enables or disables the visibility of a script to the LLM (bidirectional toggle).
   *
   * Only the skill owner can modify it.
   * The original value declared in SKILL.md is restored by reinstall().
   */
  async setScriptLlmCallable(
    skillId:     string,
    scriptId:    string,
    userId:      string,
    llmCallable: boolean,
  ): Promise<SkillScript> {
    await this.findOwned(skillId, userId);

    const script = await this.scriptRepo.findOne({ where: { id: scriptId, skillId } });
    if (!script) {
      throw new NotFoundException(
        I18nContext.current()?.t('skills.scriptNotFound', { args: { scriptId, skillId } })
        ?? `Script "${scriptId}" not found in skill "${skillId}"`,
      );
    }

    if (script.llmCallable === llmCallable) {
      return script; // no change needed
    }

    await this.scriptRepo.update(scriptId, { llmCallable });
    this.logger.log(
      `Script "${script.filename}" (${scriptId}) → llmCallable=${llmCallable} (user: ${userId})`,
    );

    return this.scriptRepo.findOne({ where: { id: scriptId } });
  }

  async setScriptContextNote(
    skillId:     string,
    scriptId:    string,
    userId:      string,
    contextNote: string | null,
  ): Promise<SkillScript> {
    await this.findOwned(skillId, userId);

    const script = await this.scriptRepo.findOne({ where: { id: scriptId, skillId } });
    if (!script) {
      throw new NotFoundException(
        I18nContext.current()?.t('skills.scriptNotFound', { args: { scriptId, skillId } })
        ?? `Script "${scriptId}" not found in skill "${skillId}"`,
      );
    }

    await this.scriptRepo.update(scriptId, { contextNote: contextNote || null });
    return this.scriptRepo.findOne({ where: { id: scriptId } });
  }

  /**
   * Deletes the skill, its scripts and the files on the volume.
   * Only the owner can delete their own skill.
   */
  async remove(id: string, userId: string): Promise<void> {
    const skill = await this.findOwned(id, userId);

    // Stop all active daemons of this skill in the executor (best-effort)
    // before the cascading DB deletion — otherwise the processes
    // remain zombies in the executor without an associated DB record.
    try {
      const liveDaemons = await this.executorClient.listDaemons();
      const toKill = liveDaemons.filter(
        (d) => d.skill_id === id && d.user_id === userId && d.running,
      );
      await Promise.allSettled(
        toKill.map((d) => this.executorClient.stopDaemon(d.daemon_id)),
      );
      if (toKill.length > 0) {
        this.logger.log(
          `Stopped ${toKill.length} executor daemons for skill "${skill.name}"`,
        );
      }
    } catch (err: any) {
      // Executor unreachable or non-critical error — we can proceed
      this.logger.warn(`Unable to stop the daemons in the executor: ${err.message}`);
    }

    // Remove the files from the volume
    if (skill.packagePath && fs.existsSync(skill.packagePath)) {
      fs.rmSync(skill.packagePath, { recursive: true, force: true });
      this.logger.log(`Removed skill directory: ${skill.packagePath}`);
    }

    await this.skillRepo.remove(skill);
    this.logger.log(`Skill "${skill.name}" deleted (user: ${userId})`);
    // The skill's domains leave the allowlist.
    await this.syncEgress();
    await this.audit?.record({
      actorId: userId, action: 'skill.delete', resource: skill.name,
      outcome: 'ok', ctx: { skillId: id },
    });
  }

  // ── Admin: review shared skills ────────────────────────────────────────────

  /** Lists the shared skills awaiting admin approval. */
  async findPendingReview(): Promise<Skill[]> {
    return this.skillRepo.find({
      where: { scope: 'org', isApproved: false },
      relations: { scripts: true },
      order: { createdAt: 'ASC' },
    });
  }

  // ── Reserved networks (Phase 3) ─────────────────────────────────────────────

  /** Catalog of operator-provisioned reserved networks grantable per-skill (admin). */
  getNetworkCatalog(): SkillNetwork[] {
    return networkCatalog();
  }

  /**
   * Sets the reserved networks granted to a skill (admin). Only ids present in the
   * catalog are kept (unknown ids are dropped, deduped) — a skill can never be granted
   * a network the operator did not provision.
   */
  async setGrantedNetworks(id: string, ids: string[], actorId: string): Promise<Skill> {
    const skill = await this.skillRepo.findOne({ where: { id } });
    if (!skill) throw new NotFoundException(
      I18nContext.current()?.t('skills.notFound', { args: { id } }) ?? `Skill "${id}" not found`,
    );
    const valid = validNetworkIds();
    const granted = [...new Set((ids ?? []).filter((x) => valid.has(x)))];
    await this.skillRepo.update(id, { grantedNetworks: granted });
    this.logger.log(`Skill ${id} grantedNetworks=[${granted.join(', ')}]`);
    await this.audit?.record({
      actorId, action: 'skill.set_networks', resource: id,
      outcome: 'ok', ctx: { skillId: id, grantedNetworks: granted },
    });
    return { ...skill, grantedNetworks: granted };
  }

  /** Approves a shared skill — makes it visible to all users. */
  async approve(id: string): Promise<Skill> {
    const skill = await this.skillRepo.findOne({ where: { id }, relations: { scripts: true } });
    if (!skill) throw new NotFoundException(
      I18nContext.current()?.t('skills.notFound', { args: { id } }) ?? `Skill "${id}" not found`,
    );
    if (skill.scope !== 'org') throw new BadRequestException('skills.onlyOrgSkillsCanBeApproved');

    await this.skillRepo.update(id, { isApproved: true });
    // Admin approval = trust gate: apply the skill's domains to the egress-proxy.
    await this.syncEgress();
    return this.skillRepo.findOne({ where: { id }, relations: { scripts: true } }) as Promise<Skill>;
  }

  /**
   * Rejects a shared skill — reverts it to scope='personal', not approved.
   * Does not delete the skill: the owner can use it privately or release a corrected version.
   */
  async reject(id: string, reason?: string): Promise<Skill> {
    const skill = await this.skillRepo.findOne({ where: { id }, relations: { scripts: true } });
    if (!skill) throw new NotFoundException(
      I18nContext.current()?.t('skills.notFound', { args: { id } }) ?? `Skill "${id}" not found`,
    );

    const logEntry = reason ? `[REJECTED] ${reason}\n` : '[REJECTED]\n';
    await this.skillRepo.update(id, {
      scope:      'personal',
      teamId:     null,
      isApproved: false,
      installLog: (skill.installLog ?? '') + logEntry,
    });

    // If the skill was approved, its domains leave the allowlist.
    await this.syncEgress();
    return this.skillRepo.findOne({ where: { id }, relations: { scripts: true } }) as Promise<Skill>;
  }

  // ── Project assignments ────────────────────────────────────────────────────

  /**
   * Assigns a skill to a project.
   * The skill must be: the user's own, OR shared+approved.
   * The skill must have status='ready'.
   */
  async assignToProject(skillId: string, projectId: string, userId: string): Promise<SkillProjectAssignment> {
    const skill = await this.findOne(skillId, userId);

    // The caller must also be able to WRITE the target project, otherwise a user
    // could inject their own skill (a tool) into another tenant's project context.
    if (!(await this.projectsService.canWrite(projectId, userId))) {
      throw new ForbiddenException(
        I18nContext.current()?.t('skills.noProjectWriteAccess', { args: { projectId } })
        ?? `No write access to project "${projectId}"`,
      );
    }

    if (skill.status !== 'ready') {
      throw new BadRequestException(
        I18nContext.current()?.t('skills.notReadyForAssign', { args: { name: skill.name, status: skill.status } })
        ?? `The skill "${skill.name}" is not ready (status: ${skill.status})`,
      );
    }

    // Verify it is not already assigned
    const existing = await this.assignmentRepo.findOne({ where: { skillId, projectId } });
    if (existing) throw new ConflictException('skills.alreadyAssignedToProject');

    const assignment = this.assignmentRepo.create({ skillId, projectId, assignedById: userId });
    return this.assignmentRepo.save(assignment);
  }

  /** Removes the assignment of a skill to a project. */
  async removeFromProject(skillId: string, projectId: string, userId: string): Promise<void> {
    // Only the assigner (or the skill owner) can remove it
    const assignment = await this.assignmentRepo.findOne({
      where: { skillId, projectId },
      relations: { skill: true },
    });

    if (!assignment) throw new NotFoundException('skills.assignmentNotFound');

    const isOwner    = assignment.skill.ownerId === userId;
    const isAssigner = assignment.assignedById === userId;

    if (!isOwner && !isAssigner) {
      throw new ForbiddenException('skills.noPermissionToRemoveAssignment');
    }

    await this.assignmentRepo.remove(assignment);
  }

  /** Lists the skills assigned to a project (only for members of that project). */
  async findByProject(projectId: string, userId: string): Promise<Skill[]> {
    // Gate on project access: without it any user could enumerate another project's
    // assigned skills and their scripts by guessing the projectId.
    if (!(await this.projectsService.canAccess(projectId, userId))) {
      throw new ForbiddenException(
        I18nContext.current()?.t('skills.noProjectAccess', { args: { projectId } })
        ?? `No access to project "${projectId}"`,
      );
    }
    const assignments = await this.assignmentRepo.find({
      where: { projectId },
      relations: { skill: { scripts: true } },
    });
    return assignments
      .map((a) => a.skill)
      .filter((s) => s.status === 'ready');
  }

  // ── Agent integration ──────────────────────────────────────────────────────

  /**
   * Loads the DynamicStructuredTool of all ready skills accessible to the user.
   *
   * Includes:
   *   - The user's personal skills (status=ready)
   *   - Shared+approved skills (status=ready) of other users
   *   - Skills assigned to the project (if projectId provided), status=ready
   *
   * Deduplicates by skill name (personal wins over a same-named shared one, as for custom tools).
   */
  async loadToolsForUser(
    userId: string,
    projectId?: string,
    opts: { flatOnly?: boolean } = {},
  ): Promise<DynamicStructuredTool[]> {
    const accessible = await this.collectAccessibleSkills(userId, projectId);
    // flatOnly (chat): excludes skills with loadOnFirst=false (usable only via agent).
    const skills = opts.flatOnly ? accessible.filter((s) => s.loadOnFirst) : accessible;

    const tools: DynamicStructuredTool[] = [];
    for (const skill of skills) {
      const config = await this.resolveConfig(skill.id);
      // Retrieve the lastInfoOutput from the skill's info script (if it exists)
      const infoScript    = (skill.scripts ?? []).find((s) => s.mode === 'info');
      const infoOutput    = infoScript?.lastInfoOutput ?? null;

      for (const script of skill.scripts ?? []) {
        if (script.mode === 'daemon') continue;      // daemon → handled by DaemonsService
        if (script.mode === 'info')   continue;      // info → UI only, not exposed to the LLM
        if (script.llmCallable === false) continue;  // inter-skill only → invisible to the LLM
        tools.push(buildSkillTool(skill, script, this.executorClient, config, infoOutput, userId,
          (v, u) => this.filesService.resolveFileRef(v, u)));
      }
    }

    if (tools.length > 0) {
      this.logger.log(`Loaded ${tools.length} skill tools for user ${userId}${projectId ? ` (project ${projectId})` : ''}`);
    }

    return tools;
  }

  /**
   * DESCRIPTIVE skills (agentskills.io) accessible in the context, to be staged in the
   * sandbox workspace. Returns name + absolute path of the skill folder.
   * Path made absolute so the executor (separate process) can read it.
   */
  async listDescriptiveSkillDirs(userId: string, projectId?: string): Promise<{ name: string; hostPath: string; version: string }[]> {
    const skills = await this.collectAccessibleSkills(userId, projectId);
    return skills
      .filter((s) => s.kind === 'descriptive' && s.packagePath)
      .map((s) => ({
        name:     s.name,
        hostPath: path.resolve(s.packagePath as string),
        // Freshness stamp: changes on every reinstall/update → the executor re-stages.
        version:  (s.updatedAt as any)?.toISOString?.() ?? String(s.updatedAt ?? ''),
      }));
  }

  /**
   * Builds the DynamicStructuredTool of a single skill script (by id +
   * filename), with access check. Used by the `skill` node of the Flows.
   */
  async buildScriptTool(skillId: string, scriptFilename: string, userId: string): Promise<DynamicStructuredTool> {
    const skill = await this.findOne(skillId, userId); // access check (own or shared)
    const config = await this.resolveConfig(skill.id);
    const infoScript = (skill.scripts ?? []).find((s) => s.mode === 'info');
    const infoOutput = infoScript?.lastInfoOutput ?? null;
    const script = (skill.scripts ?? []).find((s) => s.filename === scriptFilename);
    if (!script) {
      throw new NotFoundException(
        I18nContext.current()?.t('skills.scriptByFilenameNotFound', { args: { filename: scriptFilename, name: skill.name } })
        ?? `Script "${scriptFilename}" not found in skill "${skill.name}".`,
      );
    }
    return buildSkillTool(skill, script, this.executorClient, config, infoOutput, userId,
      (v, u) => this.filesService.resolveFileRef(v, u));
  }

  /**
   * Builds the skill-related portion of the system prompt.
   *
   * Uses collectAccessibleSkills() which already applies the visibility semantics:
   *   - Global skills (0 assignments) → always present
   *   - Contextual skills (≥1 assignment) → present only if assigned to projectId
   *
   * Level 1 — always present for each relevant skill:
   *   <available_skills>
   *     <skill name="..." description="..."/>
   *   </available_skills>
   *
   * Level 2 — full SKILL.md for each relevant skill:
   *   <skill_instructions name="...">
   *     [SKILL.md content]
   *   </skill_instructions>
   *
   * If there are no skills in the current context, returns an empty string.
   */
  async buildSkillSystemPrompt(userId: string, projectId?: string): Promise<string> {
    return this.buildSkillSystemPromptSelective(userId, projectId, null);
  }

  /**
   * Builds a Map<toolName, instructions> for the deferred mode.
   *
   * For each accessible skill, parses the SKILL.md ONLY once via
   * `parseSkillMdSections`, then assigns to each tool the shared section +
   * its own @tool section (if present).
   * If `selectedToolNames` is provided, includes only the tools in the set.
   *
   * Used by AgentService to build get_tool_instructions on-demand.
   *
   * @param selectedToolNames  Set of the selected tools (null = all)
   */
  async getSkillMdMap(
    userId: string,
    projectId: string | undefined,
    selectedToolNames: Set<string> | null,
  ): Promise<Map<string, string>> {
    const skills = await this.collectAccessibleSkills(userId, projectId);
    const map    = new Map<string, string>();

    for (const skill of skills) {
      const skillDir   = skill.packagePath ?? path.join(this.skillsBase, skill.id);
      const skillMdPath = this.findSkillMdPath(skillDir);
      if (!skillMdPath) continue;
      // Only the instructions body: the frontmatter (manifest) does not go into the prompt.
      const raw = stripFrontmatter(fs.readFileSync(skillMdPath, 'utf-8'));

      // Parse the SKILL.md only once — avoids N extractSkillMdForTools calls
      const { shared, sections } = this.parseSkillMdSections(raw);

      for (const script of (skill.scripts ?? [])) {
        const toolName = buildToolName(skill.name, script.filename);
        if (selectedToolNames && !selectedToolNames.has(toolName)) continue;

        const filename = script.filename.replace(/^scripts\//, '');

        let content: string;
        if (sections.size === 0) {
          // No @tool marker → the whole SKILL.md is "shared"
          content = shared;
        } else {
          const specific = sections.get(filename) ?? '';
          content = [shared, specific].filter(Boolean).join('\n\n');
        }

        if (content.trim()) map.set(toolName, content);
      }
    }

    this.logger.debug(`getSkillMdMap: ${map.size} tools with SKILL.md loaded`);
    return map;
  }

  /**
   * Parses a SKILL.md into per-script blocks (shared section + @tool sections).
   *
   * Marker format (HTML comment, invisible in the Markdown preview):
   *   <!-- @tool: script.py -->
   *   ... content specific to script.py ...
   *   <!-- @tool: altro.py -->
   *   ...
   *
   * If there are no markers, all the content is "shared".
   *
   * @returns `{ shared, sections }` where `sections` is a Map<filename, content>
   */
  private parseSkillMdSections(content: string): {
    shared: string;
    sections: Map<string, string>;
  } {
    const MARKER_RE = /^<!--\s*@tool:\s*(.+?)\s*-->$/;

    // No marker → no subdivision; everything is shared
    if (!content.split('\n').some((l) => MARKER_RE.test(l))) {
      return { shared: content, sections: new Map() };
    }

    type RawSection = { tag: string | null; lines: string[] };
    const rawSections: RawSection[] = [{ tag: null, lines: [] }];

    for (const line of content.split('\n')) {
      const m = line.match(MARKER_RE);
      if (m) {
        rawSections.push({ tag: m[1].trim(), lines: [] });
      } else {
        rawSections[rawSections.length - 1].lines.push(line);
      }
    }

    const shared   = rawSections[0].lines.join('\n').trim();
    const sections = new Map<string, string>();

    for (const sec of rawSections.slice(1)) {
      const text = sec.lines.join('\n').trim();
      if (text && sec.tag) sections.set(sec.tag, text);
    }

    return { shared, sections };
  }

  /**
   * Selective variant of buildSkillSystemPrompt.
   *
   * Level 1 — always present for ALL accessible skills (cheap: ~10 tok/skill).
   * Level 2 — SKILL.md included ONLY for skills that have at least one tool in the
   *            `selectedToolNames` set. If `selectedToolNames` is null, includes all
   *            (legacy behavior — used by always_inject_all).
   *
   * With the `<!-- @tool: script.py -->` marker in the SKILL.md, loads ONLY the sections
   * of the actually selected scripts + the shared section (before the first marker).
   *
   * @param selectedToolNames  Set of the LangChain tool names selected by the RAG.
   *                           null = no filter (includes all SKILL.md).
   */
  async buildSkillSystemPromptSelective(
    userId: string,
    projectId: string | undefined,
    selectedToolNames: Set<string> | null,
  ): Promise<string> {
    const skills = await this.collectAccessibleSkills(userId, projectId);
    if (skills.length === 0) return '';

    const parts: string[] = [];

    // Level 1: metadata of ALL skills (cheap, ~10 tok/skill)
    const metaParts = skills.map(
      (s) => `  <skill name="${s.name}" description="${escapeXml(s.description)}"/>`,
    );
    parts.push('<available_skills>\n' + metaParts.join('\n') + '\n</available_skills>');

    // Level 2: SKILL.md only for relevant skills, with per-script filter via @tool marker
    let loaded  = 0;  // SKILL.md found on disk and loaded
    let skipped = 0;  // skills discarded by the RAG filter (only in deferred/rag_selection mode)
    let noFile  = 0;  // ready skills but without SKILL.md on disk (warning log)

    for (const skill of skills) {
      // ── RAG filter (only if selectedToolNames is a Set, not in always_inject_all) ──
      let selectedScripts: string[] | null = null; // null = include everything (always_inject_all)

      // DESCRIPTIVE skills (pure agentskills.io) have no tools → they are not
      // selectable by tool-name: they are always included if accessible, so
      // their instructions (executed via sandbox) remain available to the agent.
      if (selectedToolNames !== null && skill.kind !== 'descriptive') {
        selectedScripts = (skill.scripts ?? [])
          .filter((sc) => selectedToolNames.has(buildToolName(skill.name, sc.filename)))
          // Normalize: remove the "scripts/" prefix to match the <!-- @tool: filename.py --> markers
          .map((sc) => sc.filename.replace(/^scripts\//, ''));

        if (selectedScripts.length === 0) {
          skipped++;
          continue; // no tool of this skill selected by the RAG → skip SKILL.md
        }
      }

      // ── Reading SKILL.md from the volume ────────────────────────────────────
      const skillDir    = skill.packagePath ?? path.join(this.skillsBase, skill.id);
      const skillMdPath = this.findSkillMdPath(skillDir);
      if (!skillMdPath) {
        noFile++;
        this.logger.warn(
          `SKILL.md not found for skill "${skill.name}" (id: ${skill.id}) — ` +
          `searched in: ${skillDir}. The file may have been deleted, ` +
          `the volume is not mounted, or the ZIP was extracted with a non-standard structure. ` +
          `Reinstall the skill to fix the problem.`,
        );
        continue;
      }

      // Only the instructions body: the frontmatter (manifest) does not go into the prompt.
      const raw = stripFrontmatter(fs.readFileSync(skillMdPath, 'utf-8'));
      let content = selectedScripts !== null
        ? this.extractSkillMdForTools(raw, selectedScripts, skill.name)
        : raw; // always_inject_all: no per-script filter

      // Descriptive skill (agentskills.io): it has no typed tools. Its files are
      // staged in the sandbox workspace: tell the agent where to find/run them.
      if (skill.kind === 'descriptive' && content.trim()) {
        content += this.descriptiveSandboxNote(skill.name);
      }

      if (content.trim()) {
        parts.push(`<skill_instructions name="${skill.name}">\n${content}\n</skill_instructions>`);
        loaded++;
      }
    }

    // ── Summary log ────────────────────────────────────────────────────────────
    const isSelectiveMode = selectedToolNames !== null;
    const parts_log: string[] = [`${loaded} SKILL.md loaded`];
    if (isSelectiveMode && skipped > 0) {
      parts_log.push(`${skipped} skipped (tools not selected by the RAG)`);
    }
    if (noFile > 0) {
      parts_log.push(`${noFile} without file on disk`);
    }
    if (!isSelectiveMode) {
      parts_log.push('always_inject_all mode (no RAG filter)');
    }
    this.logger.debug(`SKILL.md: ${parts_log.join(', ')}`);

    return parts.join('\n\n');
  }

  /**
   * Extracts from the SKILL.md the sections relevant to the selected scripts.
   *
   * Marker format (HTML comment, invisible in the Markdown preview):
   *   <!-- @tool: script.py -->
   *
   * Parsing rules:
   *   - No marker → returns the entire content (backward compat)
   *   - Everything before the first marker = shared section → ALWAYS included
   *   - Each `@tool: x.py` section is included only if `x.py` ∈ selectedScripts
   *
   * @param content         Raw content of the SKILL.md
   * @param selectedScripts Filenames of the selected scripts (e.g. ['list_emails.py'])
   * @param skillName       Skill name (only for the log)
   */
  /** Note injected into a descriptive skill's instructions: where to find/run the files via sandbox. */
  private descriptiveSandboxNote(name: string): string {
    return `\n\n> [Sandbox] The files of this skill are in \`skills/${name}/\` in the sandbox workspace. ` +
      `To use it, run its scripts with \`run_in_sandbox\` from that path (e.g. \`python skills/${name}/scripts/<file>.py\`). ` +
      `Requires the sandbox to be enabled.`;
  }

  /**
   * Prompt (Level 1 + Level 2) of the ONLY accessible descriptive skills, to be injected
   * ALWAYS — even in `deferred` mode, where, having no tools, they would appear
   * neither in the tool list nor in the get_tool_instructions meta-tool.
   */
  async buildDescriptiveSkillsPrompt(userId: string, projectId?: string): Promise<string> {
    const skills = (await this.collectAccessibleSkills(userId, projectId)).filter((s) => s.kind === 'descriptive');
    if (skills.length === 0) return '';

    const parts: string[] = [];
    parts.push(
      '<available_skills>\n' +
      skills.map((s) => `  <skill name="${s.name}" description="${escapeXml(s.description)}"/>`).join('\n') +
      '\n</available_skills>',
    );
    for (const skill of skills) {
      const dir    = skill.packagePath ?? path.join(this.skillsBase, skill.id);
      const mdPath = this.findSkillMdPath(dir);
      if (!mdPath) continue;
      const content = stripFrontmatter(fs.readFileSync(mdPath, 'utf-8')) + this.descriptiveSandboxNote(skill.name);
      if (content.trim()) parts.push(`<skill_instructions name="${skill.name}">\n${content}\n</skill_instructions>`);
    }
    return parts.join('\n\n');
  }

  private extractSkillMdForTools(
    content: string,
    selectedScripts: string[],
    skillName: string,
  ): string {
    const MARKER_RE = /^<!--\s*@tool:\s*(.+?)\s*-->$/;

    // No marker → backward compat: returns everything
    if (!content.split('\n').some((l) => MARKER_RE.test(l))) return content;

    // Parsing: accumulate tagged sections
    type Section = { tag: string | null; lines: string[] };
    const sections: Section[] = [{ tag: null, lines: [] }]; // null = shared section

    for (const line of content.split('\n')) {
      const m = line.match(MARKER_RE);
      if (m) {
        sections.push({ tag: m[1].trim(), lines: [] });
      } else {
        sections[sections.length - 1].lines.push(line);
      }
    }

    // Assemble: shared + sections of the selected tools
    const result: string[] = [];
    let included = 0;
    let filtered = 0;

    for (const section of sections) {
      const text = section.lines.join('\n').trim();
      if (!text) continue;

      if (section.tag === null) {
        result.push(text); // shared section: always included
      } else if (selectedScripts.includes(section.tag)) {
        result.push(text);
        included++;
      } else {
        filtered++;
      }
    }

    if (filtered > 0) {
      this.logger.debug(
        `SKILL.md ${skillName}: @tool filter — ${included} sections included, ${filtered} filtered out`,
      );
    }

    return result.join('\n\n');
  }

  // ── Inter-skill invocation ────────────────────────────────────────────────

  /**
   * Runs a skill script on-demand via skill-executor.
   *
   * Used by the internal endpoint POST /internal/skills/:id/invoke to allow
   * a skill (or any trusted client) to invoke another skill
   * without going through the LangGraph agent.
   *
   * Constraints:
   *   - The skill must have status='ready'
   *   - The script must exist and have mode='task' (not daemon)
   *   - The config is resolved with the same mechanism used by the agent
   *
   * @param skillId        UUID of the skill to invoke
   * @param scriptFilename Filename of the script (with or without the "scripts/" prefix)
   * @param input          Input parameters passed to the script via stdin
   * @param timeoutMs      Execution timeout (default: 30s)
   */
  async invoke(
    skillId:        string,
    scriptFilename: string,
    input:          Record<string, unknown>,
    timeoutMs = 30_000,
    actorId?:       string,
  ): Promise<{
    success:     boolean;
    output:      unknown;      // stdout parsed as JSON (null if it is not JSON)
    raw:         string;       // raw stdout
    duration_ms: number;
    exit_code:   number;
    stderr?:     string;
  }> {
    // ── 1. Skill must exist and be ready ───────────────────────────────────
    const skill = await this.skillRepo.findOne({
      where: { id: skillId, status: 'ready' },
    });
    if (!skill) {
      throw new NotFoundException(
        I18nContext.current()?.t('skills.notFoundOrNotReady', { args: { id: skillId } })
        ?? `Skill "${skillId}" not found or not in "ready" status`,
      );
    }

    // ── 1b. Caller access check (S2) ───────────────────────────────────────
    // When an identity is provided (inter-skill invoke bus), the caller may only
    // invoke a skill it can access: owner, approved-org, or member of the skill's team.
    if (actorId) {
      const owner = skill.ownerId === actorId;
      const org   = skill.scope === 'org' && skill.isApproved;
      let team = false;
      if (!owner && !org && skill.scope === 'team' && skill.teamId) {
        const teamIds = await this.teamsService.teamIdsForUser(actorId);
        team = teamIds.includes(skill.teamId);
      }
      if (!owner && !org && !team) {
        throw new ForbiddenException(
          I18nContext.current()?.t('skills.invokeForbidden', { args: { id: skillId } })
          ?? `No access to skill "${skillId}"`,
        );
      }
    }

    // ── 2. Normalize the filename (with/without the "scripts/" prefix) ─────
    const withPrefix    = scriptFilename.startsWith('scripts/') ? scriptFilename : `scripts/${scriptFilename}`;
    const withoutPrefix = scriptFilename.startsWith('scripts/') ? scriptFilename.slice('scripts/'.length) : scriptFilename;

    const script = await this.scriptRepo.findOne({
      where: [
        { skillId, filename: withPrefix },
        { skillId, filename: withoutPrefix },
      ],
    });

    if (!script) {
      const available = (await this.scriptRepo.find({ where: { skillId } })).map((s) => s.filename).join(', ');
      throw new BadRequestException(
        I18nContext.current()?.t('skills.scriptNotFoundForInvoke', { args: { filename: scriptFilename, name: skill.name, available } })
        ?? `Script "${scriptFilename}" not found in skill "${skill.name}". Available scripts: ${available}`,
      );
    }

    if (script.mode === 'daemon') {
      throw new BadRequestException(
        I18nContext.current()?.t('skills.scriptIsDaemon', { args: { filename: script.filename } })
        ?? `The script "${script.filename}" is a daemon and cannot be invoked directly. Use the endpoint POST /api/skills/:id/daemon to start it.`,
      );
    }

    // ── 3. Resolve config and invoke the executor ──────────────────────────
    const config = await this.resolveConfig(skillId);

    this.logger.log(
      `invoke: skill="${skill.name}" script="${script.filename}" input_keys=${Object.keys(input).join(',') || '(none)'}`,
    );

    const result = await this.executorClient.execute({
      skill_id:   skillId,
      filename:   script.filename,
      language:   script.language,
      input,
      timeout_ms: timeoutMs,
      config,
      // Propagate the caller's identity to the invoked script so it can reach the
      // internal APIs (files/vector/datasources/save-config) AS the caller — the
      // same run-token mechanism as the primary skill-tool path. Runs-as caller;
      // the executor sets USER_ID + x-internal-token. TTL covers the run timeout.
      ...(actorId ? { user_id: actorId, run_token: mintRunToken(actorId, timeoutMs + 30_000) } : {}),
      ...skillNetworkParams(skill),
    });

    // ── 4. Parse stdout as JSON (best-effort) ──────────────────────────────
    let output: unknown = null;
    const raw = result.stdout.trim();
    if (raw) {
      try {
        output = JSON.parse(raw);
      } catch {
        // stdout is not JSON — we return it raw in the `raw` field
        this.logger.debug(`invoke "${skill.name}/${script.filename}": stdout is not valid JSON`);
      }
    }

    const success = result.exit_code === 0;

    if (success) {
      this.logger.log(
        `invoke "${skill.name}/${script.filename}" OK (${result.duration_ms}ms)`,
      );
      // Persist the info script's output: it is injected as LLM context
      // into the task scripts of the same skill when contextNote is not set.
      if (script.mode === 'info' && raw) {
        await this.scriptRepo.update(script.id, { lastInfoOutput: raw });
      }
    } else {
      this.logger.warn(
        `invoke "${skill.name}/${script.filename}" ERROR exit=${result.exit_code} ` +
        `(${result.duration_ms}ms) stderr=${result.stderr.slice(0, 200)}`,
      );
    }

    await this.audit?.record({
      actorId, action: 'skill.execute', resource: skill.name,
      outcome: success ? 'ok' : 'error',
      ctx: { skillId, script: script.filename, durationMs: result.duration_ms, exitCode: result.exit_code },
    });

    return {
      success,
      output,
      raw,
      duration_ms: result.duration_ms,
      exit_code:   result.exit_code,
      ...(result.stderr.trim() ? { stderr: result.stderr.trim() } : {}),
    };
  }

  // ── Config vars ───────────────────────────────────────────────────────────

  /**
   * System variables always available in every skill.
   * Read from env/ConfigService — no DB query.
   *
   * The paths are always resolved to absolute with `path.resolve()` so the Python/JS
   * scripts can use them directly without depending on their own CWD.
   */
  getSystemVars(): Record<string, string> {
    const uploadDir      = this.config.get<string>('UPLOAD_DIR',       './uploads');
    const skillsOutputDir = this.config.get<string>('SKILLS_OUTPUT_DIR', path.join(uploadDir, 'skills-output'));
    return {
      UPLOAD_DIR:        path.resolve(uploadDir),
      SKILLS_OUTPUT_DIR: path.resolve(skillsOutputDir),
      SKILLS_DIR:        this.skillsBase,          // already absolute (constructor)
      APP_NAME:          this.config.get<string>('APP_NAME', 'Arkimede'),
      APP_URL:           this.config.get<string>('APP_URL',  ''),
    };
  }

  /**
   * Resolves the complete configuration for a skill:
   *   1. Starts from the system variables (always present)
   *   2. For each configSpec entry, uses the user value → default → ''
   *   3. Substitutes ${VAR} in the values with the system variables
   *
   * The values of the secret variables are NOT masked here (the script needs them
   * in clear text); masking happens only in the `getConfigVarsForApi` method.
   */
  async resolveConfig(skillId: string): Promise<Record<string, string>> {
    const skill = await this.skillRepo.findOne({ where: { id: skillId } });
    const spec: SkillConfigSpec[] = skill?.configSpec ?? [];
    const sysVars = this.getSystemVars();

    if (spec.length === 0) return sysVars;

    // Load the values set by the user
    const userVars = await this.configVarRepo.find({ where: { skillId } });
    const userMap: Record<string, string> = {};
    for (const v of userVars) {
      userMap[v.key] = v.value ?? '';
    }

    // Resolve each spec entry
    const resolved: Record<string, string> = {};
    for (const s of spec) {
      let val = userMap[s.key] ?? s.default ?? '';
      // Substitute ${VAR_NAME} with system variables or already-resolved ones
      val = val.replace(/\$\{([^}]+)\}/g, (_: string, name: string) =>
        sysVars[name] ?? resolved[name] ?? '',
      );
      resolved[s.key] = val;
    }

    // Merge: system vars always present, override for the declared keys
    return { ...sysVars, ...resolved };
  }

  /**
   * Returns the configuration state for the API (secret values masked).
   * Includes: declared spec, available system variables, current values.
   */
  async getConfigVarsForApi(skillId: string, userId: string): Promise<{
    systemVars:   Record<string, string>;
    systemVarNames: string[];
    vars: Array<{
      key:         string;
      description: string;
      default?:    string;
      required:    boolean;
      secret:      boolean;
      value:       string | null;   // null = use default
      resolved:    string;          // '' for secrets
      isOverridden: boolean;
    }>;
  }> {
    const skill  = await this.findOne(skillId, userId);
    const spec   = skill.configSpec ?? [];
    const sysVars = this.getSystemVars();

    const userVars = await this.configVarRepo.find({ where: { skillId } });
    const userMap: Record<string, string> = {};
    for (const v of userVars) {
      userMap[v.key] = v.value ?? '';
    }

    const vars = spec.map((s) => {
      const userVal      = userMap[s.key];
      const isOverridden = userVal !== undefined;
      const rawVal       = userVal ?? s.default ?? '';
      const resolved     = s.secret ? '' :
        rawVal.replace(/\$\{([^}]+)\}/g, (_: string, name: string) => sysVars[name] ?? '');

      return {
        key:         s.key,
        description: s.description,
        default:     s.default,
        required:    s.required,
        secret:      s.secret,
        ...(s.type ? { type: s.type } : {}),
        ...(s.family ? { family: s.family } : {}),
        value:       isOverridden ? (s.secret ? '••••' : userVal) : null,
        resolved,
        isOverridden,
      };
    });

    return {
      systemVars:     sysVars,
      systemVarNames: [...SYSTEM_VAR_NAMES],
      vars,
    };
  }

  /**
   * Sets or updates the value of a configuration variable (only owner).
   * The key must be declared in the skill's configSpec.
   */
  async upsertConfigVar(skillId: string, userId: string, key: string, value: string): Promise<void> {
    await this.findOwned(skillId, userId);

    const skill = await this.skillRepo.findOne({ where: { id: skillId } });
    const spec  = skill?.configSpec ?? [];

    // If the skill has a spec, the key must be declared
    if (spec.length > 0) {
      const entry = spec.find((s) => s.key === key);
      if (!entry) {
        throw new BadRequestException(
          I18nContext.current()?.t('skills.configKeyNotDeclared', { args: { key, available: spec.map((s) => s.key).join(', ') } })
          ?? `The key "${key}" is not declared in the skill configuration. Available keys: ${spec.map((s) => s.key).join(', ')}`,
        );
      }

      const isSecret = entry.secret ?? false;
      const existing = await this.configVarRepo.findOne({ where: { skillId, key } });

      if (existing) {
        await this.configVarRepo.update(existing.id, { value, isSecret });
      } else {
        await this.configVarRepo.save(
          this.configVarRepo.create({ skillId, key, value, isSecret }),
        );
      }
    } else {
      // Skill without a spec: allow free variables (useful for simple skills)
      const existing = await this.configVarRepo.findOne({ where: { skillId, key } });
      if (existing) {
        await this.configVarRepo.update(existing.id, { value });
      } else {
        await this.configVarRepo.save(
          this.configVarRepo.create({ skillId, key, value }),
        );
      }
    }

    this.logger.log(`Config var "${key}" updated for skill ${skillId} (user ${userId})`);
  }

  /** Removes a user override — the variable will go back to using the default value. */
  async deleteConfigVar(skillId: string, userId: string, key: string): Promise<void> {
    await this.findOwned(skillId, userId);
    const result = await this.configVarRepo.delete({ skillId, key });
    if (!result.affected) {
      throw new NotFoundException(
        I18nContext.current()?.t('skills.configOverrideNotFound', { args: { key } })
        ?? `No override found for the key "${key}"`,
      );
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Gathers the ready skills accessible to the user in the current context.
   *
   * Per-project visibility semantics:
   *   - Skill WITHOUT assignments → global: available in all projects and in chats
   *     without a project (default behavior after upload).
   *   - Skill WITH at least one assignment → contextual: available ONLY in the
   *     assigned projects. If the caller does not pass projectId, these skills are not included.
   *
   * This allows to:
   *   a) Load a skill and use it right away everywhere (no configuration needed).
   *   b) Limit it to specific projects at the moment the first assignment is made.
   *
   * Dedup by name: the user's personal wins over a same-named shared one.
   */
  private async collectAccessibleSkills(userId: string, projectId?: string): Promise<Skill[]> {
    const teamIds = await this.teamsService.teamIdsForUser(userId);
    const where: Record<string, unknown>[] = [
      { ownerId: userId, status: 'ready', enabled: true },
      { scope: 'org', isApproved: true, status: 'ready', enabled: true },
    ];
    if (teamIds.length) {
      where.push({ scope: 'team', teamId: In(teamIds), status: 'ready', enabled: true });
    }
    const allSkills = await this.skillRepo.find({
      where,
      relations: { scripts: true, projectAssignments: true },
    });

    const relevant: Skill[] = [];
    for (const skill of allSkills) {
      const assignmentCount = skill.projectAssignments?.length ?? 0;
      if (assignmentCount === 0) {
        // No assignment → global skill, always available
        relevant.push(skill);
      } else if (projectId) {
        // Has assignments → available only if this project is among the assigned ones
        const isAssigned = skill.projectAssignments.some((a) => a.projectId === projectId);
        if (isAssigned) relevant.push(skill);
      }
      // If it has assignments but there is no projectId (generic chat) → excluded
    }

    // Dedup by name: the user's personal wins over a same-named shared one
    const seen  = new Set<string>();
    const result: Skill[] = [];
    for (const s of relevant) {
      if (s.ownerId === userId && !seen.has(s.name)) { seen.add(s.name); result.push(s); }
    }
    for (const s of relevant) {
      if (s.ownerId !== userId && !seen.has(s.name)) { seen.add(s.name); result.push(s); }
    }
    return result;
  }

  /**
   * Starts the installation of dependencies in background (fire & forget).
   * Updates the status and the log in the DB when done.
   */
  private triggerInstallBackground(
    skillId:    string,
    pythonDeps: string[],
    jsDeps:     string[],
    nixDeps:    string[] = [],
  ): void {
    this.skillRepo.update(skillId, { status: 'installing' }).then(() => {
      const hasAnyDep = pythonDeps.length > 0 || jsDeps.length > 0 || nixDeps.length > 0;

      if (!hasAnyDep) {
        // No dependency → ready immediately
        return this.skillRepo.update(skillId, {
          status:     'ready',
          installLog: 'No dependencies — ready immediately.',
        });
      }

      return this.executorClient
        .install(skillId, pythonDeps, jsDeps, nixDeps)
        .then((result) => {
          return this.skillRepo.update(skillId, {
            status:     result.ok ? 'ready' : 'error',
            installLog: result.log,
          });
        })
        .catch((err: Error) => {
          return this.skillRepo.update(skillId, {
            status:     'error',
            installLog: `[INSTALL ERROR]: ${err.message}`,
          });
        });
    })
    // Once install is complete (ready) the skill's domains can enter the allowlist.
    .then(() => this.syncEgress())
    .catch((err: Error) => {
      this.logger.error(`Error updating skill status ${skillId}: ${err.message}`);
    });
  }

  /**
   * Detects whether all the ZIP entries are under a common root folder.
   *
   * GitHub, many editors and the `zip` CLI create ZIPs with a root folder:
   *   my-skill/SKILL.md
   *   my-skill/scripts/analyze.py
   *
   * In this case it returns the prefix to strip (e.g. "my-skill/")
   * so the files are extracted flat into destDir. If the ZIP is already flat, it returns "".
   */
  private detectZipRootPrefix(entries: AdmZip.IZipEntry[]): string {
    const filePaths = entries
      .filter((e) => !e.isDirectory && e.entryName)
      .map((e) => e.entryName);

    if (filePaths.length === 0) return '';

    // Check whether all files share the same first path component
    const firstComponents = filePaths.map((p) => p.split('/')[0]);
    const uniqueFirstComponents = new Set(firstComponents);

    if (uniqueFirstComponents.size === 1) {
      const rootFolder = [...uniqueFirstComponents][0];
      // Make sure it is really a folder (at least one file has '/')
      const hasSubpath = filePaths.some((p) => p.includes('/'));
      if (hasSubpath) {
        return rootFolder + '/';
      }
    }

    return '';
  }

  /** Extracts the ZIP entries into the target directory on the volume. */
  private extractZipToVolume(
    entries: AdmZip.IZipEntry[],
    destDir: string,
  ): void {
    fs.mkdirSync(destDir, { recursive: true });

    // Strips the root folder prefix if the ZIP was created with one
    // (e.g. GitHub "Download ZIP" or `zip -r my-skill.zip my-skill/`)
    const rootPrefix = this.detectZipRootPrefix(entries);
    if (rootPrefix) {
      this.logger.debug(
        `ZIP with root folder detected: "${rootPrefix}" — files will be extracted normalized`,
      );
    }

    for (const entry of entries) {
      if (entry.isDirectory) continue;

      let entryName = entry.entryName;

      // Strip the root folder prefix
      if (rootPrefix && entryName.startsWith(rootPrefix)) {
        entryName = entryName.slice(rootPrefix.length);
      }

      // Security: skip entries that are empty after normalization
      if (!entryName) continue;

      // Security: no path traversal
      if (entryName.includes('..') || path.isAbsolute(entryName)) {
        this.logger.warn(`Skipping entry with path traversal: ${entry.entryName}`);
        continue;
      }

      const destPath = path.join(destDir, entryName);
      const destDirForFile = path.dirname(destPath);

      // Verify that the target file is inside destDir
      if (!destPath.startsWith(destDir + path.sep)) {
        this.logger.warn(`Skipping entry outside the directory: ${entry.entryName}`);
        continue;
      }

      fs.mkdirSync(destDirForFile, { recursive: true });
      fs.writeFileSync(destPath, entry.getData());
    }
  }

  /**
   * Finds the path of SKILL.md in a skill directory, with a fallback for
   * skills extracted from ZIPs with a root folder (legacy pre-fix structure).
   *
   * Searches in this order:
   *   1. {skillDir}/SKILL.md            → standard path (after the extractZipToVolume fix)
   *   2. {skillDir}/{subdir}/SKILL.md   → ZIPs with a root folder extracted before the fix
   */
  private findSkillMdPath(skillDir: string): string | null {
    // 1. Standard path — normal case
    const direct = path.join(skillDir, 'SKILL.md');
    if (fs.existsSync(direct)) return direct;

    // 2. Fallback: search in first-level subdirectories (legacy ZIP with root folder)
    try {
      const entries = fs.readdirSync(skillDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const nested = path.join(skillDir, entry.name, 'SKILL.md');
        if (fs.existsSync(nested)) {
          this.logger.debug(
            `SKILL.md found in legacy subdirectory: ${nested} — consider reinstalling the skill`,
          );
          return nested;
        }
      }
    } catch {
      // Directory not readable
    }

    return null;
  }

  /** Validates and parses the ZIP content. The manifest lives in the SKILL.md frontmatter. */
  private parseAndValidateZip(buffer: Buffer): { manifest: SkillYaml; entries: AdmZip.IZipEntry[] } {
    let zip: AdmZip;
    try {
      zip = new AdmZip(buffer);
    } catch {
      throw new BadRequestException('skills.invalidZip');
    }

    const entries = zip.getEntries();

    // Normalize the names: supports both "SKILL.md" in root and "folder-name/SKILL.md"
    const mdEntry = entries.find(
      (e) => e.entryName === 'SKILL.md' || e.entryName.endsWith('/SKILL.md'),
    );
    if (!mdEntry) {
      throw new BadRequestException('skills.missingSkillMd');
    }

    // agentskills.io format: metadata + `runtime` block in the YAML frontmatter.
    const { manifest } = parseSkillMd(mdEntry.getData().toString('utf-8'));
    return { manifest, entries };
  }

  /** Validates the required fields of SKILL.md. */
  private validateSkillYaml(s: SkillYaml): void {
    if (!s?.name) {
      throw new BadRequestException('skills.yamlNameRequired');
    }
    if (!VALID_SKILL_NAME.test(s.name)) {
      throw new BadRequestException(
        I18nContext.current()?.t('skills.yamlNameInvalid', { args: { name: s.name } })
        ?? `SKILL.md: invalid name "${s.name}". Use only lowercase letters, digits and hyphens (e.g. "data-analyzer").`,
      );
    }
    if (!s.description?.trim()) {
      throw new BadRequestException('skills.yamlDescriptionRequired');
    }

    // Validate the declared scripts
    for (const script of s.scripts ?? []) {
      if (!script.filename) {
        throw new BadRequestException('skills.yamlScriptFilenameRequired');
      }
      if (!['python', 'javascript', 'node'].includes(script.language)) {
        throw new BadRequestException(
          I18nContext.current()?.t('skills.yamlScriptLanguageUnsupported', { args: { language: script.language } })
          ?? `SKILL.md: language "${script.language}" not supported. Use "python", "javascript" or "node".`,
        );
      }
      if (!script.description?.trim()) {
        throw new BadRequestException(
          I18nContext.current()?.t('skills.yamlScriptDescriptionRequired', { args: { filename: script.filename } })
          ?? `SKILL.md: the script "${script.filename}" must have a "description"`,
        );
      }
      // No path traversal in the declarations
      if (script.filename.includes('..') || path.isAbsolute(script.filename)) {
        throw new BadRequestException(
          I18nContext.current()?.t('skills.yamlScriptPathUnsafe', { args: { filename: script.filename } })
          ?? `SKILL.md: filename "${script.filename}" contains an unsafe path`,
        );
      }
      if (script.mode && !['task', 'daemon', 'info'].includes(script.mode)) {
        throw new BadRequestException(
          I18nContext.current()?.t('skills.yamlScriptModeUnsupported', { args: { mode: script.mode, filename: script.filename } })
          ?? `SKILL.md: mode "${script.mode}" not supported for "${script.filename}". Use "task", "daemon" or "info".`,
        );
      }
      // Daemons do not support isolated-vm JS (they need a real process)
      if (script.mode === 'daemon' && script.language === 'javascript') {
        throw new BadRequestException(
          I18nContext.current()?.t('skills.yamlDaemonJsNotAllowed', { args: { filename: script.filename } })
          ?? `SKILL.md: the daemon script "${script.filename}" cannot use language "javascript" (isolated-vm). Use "python" or "node".`,
        );
      }
    }
  }

  /**
   * Returns the content of the skill's documentation file (SKILL.md or README.md).
   *
   * Searches in order: SKILL.md → README.md (in the package root).
   * Accessible by the owner and by anyone with access to the skill (shared+approved).
   *
   * @returns { filename, content } — name of the found file and UTF-8 content
   */
  async getDocs(skillId: string, userId: string): Promise<{ filename: string; content: string }> {
    const skill = await this.findOne(skillId, userId);

    if (!skill.packagePath) {
      throw new NotFoundException('skills.packagePathNotAvailable');
    }

    // README.md = user documentation → shown first in the UI.
    // SKILL.md  = instructions for the LLM (already injected into the system prompt) →
    //             used as a fallback if there is no separate README.
    const candidates = ['README.md', 'SKILL.md'];
    for (const filename of candidates) {
      const filePath = path.join(skill.packagePath, filename);
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf-8');
        // SKILL.md: show only the body (the frontmatter/manifest is not documentation).
        const content = filename === 'SKILL.md' ? stripFrontmatter(raw) : raw;
        return { filename, content };
      }
    }

    throw new NotFoundException('skills.docsNotFound');
  }

  /**
   * Verifies availability of the skill name for the user and for the scope.
   * `excludeId` excludes the current skill from the check (used in the update).
   */
  private async assertNameAvailable(
    userId: string,
    name: string,
    scope: SkillScope,
    teamId: string | null,
    excludeId?: string,
  ): Promise<void> {
    const userConflict = await this.skillRepo.findOne({ where: { ownerId: userId, name } });
    if (userConflict && userConflict.id !== excludeId) {
      throw new ConflictException(
        I18nContext.current()?.t('skills.nameAlreadyOwnedByUser', { args: { name } })
        ?? `You already have a skill with the name "${name}"`,
      );
    }
    if (scope === 'org') {
      const clash = await this.skillRepo.findOne({ where: { name, scope: 'org' } });
      if (clash && clash.id !== excludeId) {
        throw new ConflictException(
          I18nContext.current()?.t('skills.nameConflictOrg', { args: { name } })
          ?? `An org skill with the name "${name}" already exists. Org names must be globally unique.`,
        );
      }
    }
    if (scope === 'team' && teamId) {
      const clash = await this.skillRepo.findOne({ where: { name, scope: 'team', teamId } });
      if (clash && clash.id !== excludeId) {
        throw new ConflictException(
          I18nContext.current()?.t('skills.nameConflictTeam', { args: { name } })
          ?? `A team skill with the name "${name}" already exists.`,
        );
      }
    }
  }
}

// ─── Manifest parsing (SKILL.md frontmatter) ───────────────────────────────────

/**
 * Extracts the YAML frontmatter at the top of a SKILL.md (agentskills.io format).
 *
 * The file must start with `---` as the first line; the frontmatter ends at the
 * first subsequent line composed of just `---`. Everything that follows is the body
 * (the instructions for the LLM).
 *
 * @returns `{ frontmatter, body }` or `null` if the file has no frontmatter.
 */
function extractFrontmatter(raw: string): { frontmatter: string; body: string } | null {
  const norm = raw.replace(/^﻿/, '');           // strip any BOM
  if (!/^---[ \t]*\r?\n/.test(norm)) return null;     // must open with ---
  const afterOpen = norm.slice(norm.indexOf('\n') + 1);
  const close = afterOpen.match(/^---[ \t]*$/m);      // closing-only line ---
  if (!close || close.index === undefined) return null;
  const frontmatter = afterOpen.slice(0, close.index);
  const body = afterOpen.slice(close.index + close[0].length).replace(/^(?:\r?\n)+/, '');
  return { frontmatter, body };
}

/**
 * Returns the instructions body of a SKILL.md, removing the frontmatter if present.
 * Robust: if the file has no frontmatter (not-yet-migrated skills), it returns the raw.
 * Used everywhere the SKILL.md is injected as instructions for the LLM.
 */
function stripFrontmatter(raw: string): string {
  const fm = extractFrontmatter(raw);
  return fm ? fm.body : raw;
}

/**
 * Parses a SKILL.md into the skill manifest (`SkillYaml`) + instructions body.
 *
 * Frontmatter shape (agentskills.io standard + namespaced `runtime` extension):
 *   ---
 *   name: ...            # standard — used by the discovery of any client
 *   description: ...     # standard
 *   version / author / license   # optional
 *   runtime:             # proprietary block — ignored by standard clients
 *     dependencies: { python, javascript, system: { nix } }
 *     network: [...]
 *     config: [...]
 *     scripts: [...]
 *   ---
 *   # Title + markdown instructions
 */
function parseSkillMd(raw: string): { manifest: SkillYaml; body: string } {
  const fm = extractFrontmatter(raw);
  if (!fm) {
    throw new BadRequestException(
      I18nContext.current()?.t('skills.frontmatterMissing')
      ?? 'SKILL.md must start with a YAML frontmatter (--- … ---) with at least "name" and "description"',
    );
  }

  let parsed: Record<string, any>;
  try {
    parsed = (yaml.load(fm.frontmatter) as Record<string, any>) ?? {};
  } catch (err: any) {
    throw new BadRequestException(
      I18nContext.current()?.t('skills.frontmatterInvalid', { args: { message: err.message } })
      ?? `The SKILL.md frontmatter is not valid YAML: ${err.message}`,
    );
  }

  const runtime = (parsed.runtime as Record<string, any>) ?? {};
  const manifest: SkillYaml = {
    name:         parsed.name,
    version:      parsed.version,
    description:  parsed.description,
    author:       parsed.author,
    license:      parsed.license,
    dependencies: runtime.dependencies,
    network:      runtime.network,
    config:       runtime.config,
    scripts:      runtime.scripts,
  };
  return { manifest, body: fm.body };
}

// ─── Utils ────────────────────────────────────────────────────────────────────

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
