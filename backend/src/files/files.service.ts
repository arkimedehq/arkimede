/**
 * @file files.service.ts
 *
 * Service for managing the lifecycle of files uploaded by users.
 *
 * Responsibilities:
 *   - Persistence to disk and metadata to DB (TypeORM)
 *   - Text extraction from heterogeneous formats for the RAG pipeline
 *   - base64 reading for multimodal sending to Claude
 *   - Physical + logical deletion of files
 *
 * Text extraction pipeline (extractText):
 *   PDF         → pdf-parse (digital text) + fixPdfText (normalization)
 *   DOCX        → mammoth (raw text extraction)
 *   XLSX/XLS    → xlsx (each sheet converted to CSV with a header)
 *   text/*      → direct UTF-8 buffer
 *   Images      → OCR via vision model (llm_configs.isVision ?? default, cross-provider)
 *   Others      → empty string (non-parsable file)
 *
 * The extracted text is then used by EmbedService.ingestFile() for
 * vectorization in Qdrant.
 */
import { Injectable, Inject, NotFoundException, ForbiddenException, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import { basename, extname, join, relative, resolve, sep } from 'path';
import { TeamsService } from '../teams/teams.service';
// pdf-parse uses module.exports = fn, require() avoids the ES module namespace issue
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfParse = require('pdf-parse');
import * as mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import { HumanMessage } from '@langchain/core/messages';
import { LlmConfigsService } from '../llm-configs/llm-configs.service';
import { File } from './files.entity';
import { Message } from '../messages/messages.entity';
import { ProjectsService } from '../projects/projects.service';
import { AuditService } from '../audit/audit.service';

/** MIME types of images supported for OCR via Claude. */
const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
type ImageMimeType = typeof IMAGE_MIME_TYPES[number];

@Injectable()
export class FilesService {
  private readonly logger  = new Logger(FilesService.name);
  private readonly uploadDir: string;
  private readonly skillsOutputDir: string;

  constructor(
    @InjectRepository(File)    private readonly repo:        Repository<File>,
    @InjectRepository(Message) private readonly messageRepo: Repository<Message>,
    @Inject(ConfigService)     private readonly cfg:         ConfigService,
    private readonly projects: ProjectsService,
    private readonly teams:    TeamsService,
    // For image OCR: vision model from llm_configs (isVision ?? default).
    // Optional so contexts without the LLM module (tests) stay valid.
    @Optional() @Inject(LlmConfigsService) private readonly llmConfigs: LlmConfigsService | null = null,
    @Optional() private readonly audit?: AuditService,
  ) {
    this.uploadDir = cfg.get('UPLOAD_DIR', './uploads');
    // SKILLS_OUTPUT_DIR may be a SEPARATE root (not under UPLOAD_DIR): in the
    // docker-out-of-docker broker setup it is a host bind (${HOST_DATA_DIR}/skills-output).
    this.skillsOutputDir = cfg.get('SKILLS_OUTPUT_DIR', join(this.uploadDir, 'skills-output'));
    // Create the directory if it does not exist (e.g. first start on a new machine)
    if (!fs.existsSync(this.uploadDir)) {
      fs.mkdirSync(this.uploadDir, { recursive: true });
    }
  }

  /**
   * Relative path for the `?rel=` download of a file, computed against whichever
   * allowed root (UPLOAD_DIR or SKILLS_OUTPUT_DIR) actually contains it — mirrors
   * the roots accepted by `GET /api/files/raw` (files.controller `getAllowedDirs`).
   * Returns `null` if the file is under neither root (not downloadable via ?rel=).
   *
   * Why both roots: when SKILLS_OUTPUT_DIR is a separate mount (broker/DooD), a
   * skill output is NOT under UPLOAD_DIR, so a rel computed only vs UPLOAD_DIR
   * would be `null` (or an escaping `../..`). Here it becomes the bare subpath
   * relative to SKILLS_OUTPUT_DIR, which the endpoint resolves correctly.
   */
  private downloadRelFor(storagePath: string): string | null {
    const abs = resolve(storagePath);
    for (const root of [resolve(this.uploadDir), resolve(this.skillsOutputDir)]) {
      if (abs === root || abs.startsWith(root + sep)) return relative(root, abs);
    }
    return null;
  }

  /**
   * Saves a file to disk (already handled by Multer) and creates the DB record.
   *
   * Multer has already written the file to `file.path`; this method only
   * creates the TypeORM entity with the metadata.
   *
   * @param userId    - ID of the user uploading the file
   * @param projectId - ID of the associated project (optional)
   * @param file      - Multer file with path, mimetype, size, etc.
   */
  async saveFile(
    userId: string,
    projectId: string | null,
    file: Express.Multer.File,
    opts: { scope?: 'personal' | 'team' | 'org'; teamId?: string | null } = {},
  ): Promise<File> {
    // Uploading to a shared project requires write access (owner or
    // collaborator): viewers cannot add files. For own projects
    // or uploads without a project, canWrite is always true.
    if (projectId && !(await this.projects.canWrite(projectId, userId))) {
      throw new ForbiddenException('files.readonlyProject');
    }
    const scope  = opts.scope ?? 'personal';
    const teamId = scope === 'team' ? (opts.teamId ?? null) : null;
    const entity = this.repo.create({
      originalName: file.originalname,
      storagePath:  file.path,
      mimeType:     file.mimetype,
      size:         file.size,
      userId,
      projectId:    projectId || null,
      scope,
      teamId,
    });
    const saved = await this.repo.save(entity);
    await this.audit?.record({
      actorId: userId,
      action: 'file.upload',
      resource: saved.originalName ?? saved.id,
      outcome: 'ok',
      ctx: {
        fileId: saved.id,
        scope: saved.scope,
        projectId: saved.projectId,
        size: saved.size,
        mimeType: saved.mimeType,
      },
    });
    return saved;
  }

  /**
   * READ access rule on a file (C2). Aligns files to the same
   * scope model as tool/skill/datasource.
   */
  async canAccessFile(file: File, userId: string): Promise<boolean> {
    if (file.userId === userId) return true;                      // owner
    if (file.scope === 'org') return true;                        // organization
    if (file.projectId && await this.projects.canAccess(file.projectId, userId)) return true; // project
    if (file.scope === 'team' && file.teamId) {                   // team
      const teamIds = await this.teams.teamIdsForUser(userId);
      if (teamIds.includes(file.teamId)) return true;
    }
    return false;
  }

  /**
   * Returns all files of a project (of ALL members if shared with the
   * team), after an access check. So in a shared project the documents
   * are common to all members.
   */
  async findByProject(projectId: string, userId: string) {
    if (!(await this.projects.canAccess(projectId, userId))) throw new ForbiddenException();
    return this.repo.find({ where: { projectId }, order: { createdAt: 'DESC' } });
  }

  /** Returns all files of a user, ordered by descending date. */
  findByUser(userId: string) {
    return this.repo.find({ where: { userId }, order: { createdAt: 'DESC' } });
  }

  /**
   * Returns the files attached to the messages of a specific chat.
   *
   * The lookup is indirect: files have no direct FK to the chat,
   * but messages have a JSONB `attachments` array with the fileIds.
   * This method:
   * 1. Retrieves all messages of the chat with non-null attachments
   * 2. Extracts the unique fileIds from the JSONB arrays
   * 3. Loads the corresponding File entities (filtered by userId for security)
   *
   * @param chatId - ID of the chat
   * @param userId - ID of the user (security: do not return other users' files)
   */
  async findByChatId(chatId: string, userId: string): Promise<File[]> {
    const messages = await this.messageRepo
      .createQueryBuilder('m')
      .select('m.attachments')
      .where('m.chatId = :chatId', { chatId })
      .andWhere('m.attachments IS NOT NULL')
      .getMany();

    // Flatten the attachments arrays and deduplicate the fileIds
    const fileIds = [
      ...new Set(
        messages
          .flatMap((m) => m.attachments || [])
          .map((a)  => a.fileId)
          .filter(Boolean),
      ),
    ];

    if (!fileIds.length) return [];

    return this.repo
      .createQueryBuilder('f')
      .where('f.id IN (:...fileIds)', { fileIds })
      .andWhere('f.userId = :userId', { userId }) // security: only the current user's files
      .orderBy('f.createdAt', 'DESC')
      .getMany();
  }

  /**
   * Retrieves a single file, verifying ownership.
   *
   * @throws NotFoundException  if the file does not exist
   * @throws ForbiddenException if the file belongs to another user
   */
  async findOne(id: string, userId: string) {
    const file = await this.repo.findOne({ where: { id } });
    if (!file) throw new NotFoundException('files.notFound');
    if (file.userId !== userId) throw new ForbiddenException();
    return file;
  }

  /**
   * Like findOne, but also grants READ access to members of the project
   * the file belongs to (download/preview/attachment of shared files).
   * Deletion stays reserved to the owner (uses findOne).
   */
  async findOneReadable(id: string, userId: string) {
    const file = await this.repo.findOne({ where: { id } });
    if (!file) throw new NotFoundException('files.notFound');
    if (await this.canAccessFile(file, userId)) return file;
    throw new ForbiddenException();
  }

  /**
   * Maps an absolute path on disk to a tracked File and verifies its access (C2).
   * - Tracked file (upload) → applies canAccessFile (throw if denied).
   * - Not tracked (e.g. skill output in skills-output) → returns null: the
   *   caller serves with path confinement only (per-tenant scoping of skill
   *   outputs arrives with the C2 executor slice).
   */
  async assertReadableByAbsPath(absPath: string, userId: string): Promise<File | null> {
    const abs = resolve(absPath);
    // Match on the EXACT stored path — NEVER by basename: a `LIKE %name` could pick
    // another tenant's record that merely shares the filename → wrong authz decision.
    // Uploads historically store the relative multer path (`uploads/<uuid>.ext`);
    // skill outputs store the absolute path. Match either canonical form.
    const relCwd = relative(process.cwd(), abs);
    const file = await this.repo
      .createQueryBuilder('f')
      .where('f.storagePath IN (:...forms)', { forms: [abs, relCwd] })
      .getOne();
    if (!file) return null;
    if (!(await this.canAccessFile(file, userId))) {
      throw new ForbiddenException('files.noAccess');
    }
    return file;
  }

  /**
   * Tracks an OUTPUT file produced by a skill/tool as a File entity (C2):
   * owner = the user who ran it, scope `personal`, the chat's project. So
   * the `?rel=` download of that output becomes access-aware (canAccess) instead
   * of being served by path obscurity alone. Best-effort, idempotent.
   */
  async trackOutput(userId: string, projectId: string | null, absPath: string): Promise<string | null> {
    if (!userId || !absPath) return null;
    const abs = resolve(absPath);
    // Already tracked? EXACT path only — a `LIKE %basename` would treat a different
    // user's same-named output as "already tracked" and skip it (A2). Returns the
    // File id so the caller can surface an access-aware by-id download link.
    const existing = await this.repo
      .createQueryBuilder('f')
      .where('f.storagePath = :abs', { abs })
      .getOne();
    if (existing) return existing.id;

    let size = 0;
    try { size = fs.statSync(abs).size; } catch { return null; } // does not exist → nothing to track

    const MIME: Record<string, string> = {
      '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };
    const saved = await this.repo.save(this.repo.create({
      originalName: basename(abs),
      storagePath:  abs,
      mimeType:     MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream',
      size,
      userId,
      projectId:    projectId ?? null,
      scope:        'personal',
    }));
    return saved.id;
  }

  /**
   * Resolves a file reference (C2, copy-in): a fileId (uuid) or a path
   * relative to UPLOAD_DIR → File entity, with an access check. Returns the host
   * path + the name for staging in the job's work dir. `null` if not resolvable.
   * @throws ForbiddenException if the file exists but the user has no access to it.
   */
  async resolveFileRef(value: string, userId: string): Promise<{ hostPath: string; name: string } | null> {
    const v = String(value ?? '').trim();
    if (!v) return null;
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    let file: File | null;
    if (UUID_RE.test(v)) {
      file = await this.findOneReadable(v, userId);          // canAccess (throw if denied)
    } else {
      if (v.startsWith('/') || v.includes('\0')) return null; // no absolute paths/null byte
      const abs = resolve(join(this.uploadDir, v));
      file = await this.assertReadableByAbsPath(abs, userId); // tracked → canAccess; not tracked → null
    }
    if (!file) return null;
    // Stage under the (sanitized) original name, not the storage uuid: scripts
    // see a meaningful filename and derive readable output names from it.
    const safeName = (file.originalName ?? '')
      .replace(/[^\w.\-]+/g, '_')
      .replace(/^[_.]+/, '');
    return { hostPath: resolve(file.storagePath), name: safeName || basename(file.storagePath) };
  }

  /**
   * Access-scoped search on the user's files (C2): owner ∪ org ∪ team (member)
   * ∪ accessible projects. Replaces filesystem scans (e.g. file-lookup).
   */
  async searchReadable(userId: string, query: string, limit = 50): Promise<File[]> {
    const teamIds  = await this.teams.teamIdsForUser(userId);
    const projects = await this.projects.findAllForUser(userId).catch(() => [] as { id: string }[]);
    const projectIds = projects.map((p) => p.id);

    const qb = this.repo.createQueryBuilder('f')
      .where(new Brackets((b) => {
        b.where('f.userId = :userId', { userId })
         .orWhere("f.scope = 'org'");
        if (teamIds.length)    b.orWhere("f.scope = 'team' AND f.teamId IN (:...teamIds)", { teamIds });
        if (projectIds.length) b.orWhere('f.projectId IN (:...projectIds)', { projectIds });
      }));

    if (query?.trim()) {
      qb.andWhere('f.originalName ILIKE :q', { q: `%${query.trim()}%` });
    }

    const files = await qb.orderBy('f.createdAt', 'DESC').take(Math.min(limit, 200)).getMany();
    // Attaches a `rel` for the download (?rel=) relative to the allowed root that
    // contains the file (UPLOAD_DIR or SKILLS_OUTPUT_DIR) — skill outputs included.
    return files.map((f) => Object.assign(f, { rel: this.downloadRelFor(f.storagePath) }));
  }

  /**
   * Changes the visibility scope of a file (C2). Owner or admin only.
   */
  async setScope(
    id: string,
    userId: string,
    scope: 'personal' | 'team' | 'org',
    teamId: string | null,
    isAdmin: boolean,
  ): Promise<File> {
    const file = await this.repo.findOne({ where: { id } });
    if (!file) throw new NotFoundException('files.notFound');
    if (file.userId !== userId && !isAdmin) {
      throw new ForbiddenException('files.scopeOwnerOnly');
    }
    const from = file.scope;
    file.scope  = scope;
    file.teamId = scope === 'team' ? (teamId ?? null) : null;
    const saved = await this.repo.save(file);
    await this.audit?.record({
      actorId: userId,
      action: 'file.scope_change',
      resource: saved.originalName ?? saved.id,
      outcome: 'ok',
      ctx: { fileId: saved.id, from, to: scope },
    });
    return saved;
  }

  /**
   * Deletes a file: removes the physical file on disk and the DB record.
   * The try/catch on fs.unlinkSync tolerates the case where the file
   * has already been deleted manually from the filesystem.
   */
  async remove(id: string, userId: string) {
    const file = await this.findOne(id, userId);
    try { fs.unlinkSync(file.storagePath); } catch { /* file already removed, ok */ }
    await this.repo.delete(id);
    await this.audit?.record({
      actorId: userId,
      action: 'file.delete',
      resource: file.originalName ?? id,
      outcome: 'ok',
      ctx: { fileId: id, scope: file.scope },
    });
    return { deleted: true };
  }

  /**
   * Reads the file from disk and returns it as a base64 string.
   * Used by AgentService to build the multimodal content blocks (images, native PDFs).
   */
  readAsBase64(file: File): string {
    return fs.readFileSync(file.storagePath).toString('base64');
  }

  /**
   * Extracts the raw text from a file, based on its MIME type.
   *
   * The extracted text is used by EmbedService for RAG vectorization.
   * Returns an empty string for unsupported formats (e.g. unknown binaries).
   *
   * @param file - File entity with storagePath and mimeType
   * @returns Extracted text (may be empty if the format is not supported)
   */
  async extractText(file: File): Promise<string> {
    const buf = fs.readFileSync(file.storagePath);
    return this.extractTextFromBuffer(buf, file.mimeType, file.originalName);
  }

  /**
   * Extracts the text from a Buffer + mimeType (without a File entity on disk).
   * Used by the BE ingestion pipeline ({@link EmbedService}) to also index
   * files that are not tracked uploads but live on a DataSource (e.g. network
   * share). Supports PDF, DOCX, XLSX, text and images (OCR); '' if not supported.
   */
  async extractTextFromBuffer(buf: Buffer, mimeType: string, name = 'file'): Promise<string> {
    if (mimeType === 'application/pdf') {
      const data = await pdfParse(buf);
      // pdf-parse often merges adjacent words without a space → normalize
      return this.fixPdfText(data.text);
    }

    if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      const result = await mammoth.extractRawText({ buffer: buf });
      return result.value;
    }

    if (
      mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      mimeType === 'application/vnd.ms-excel'
    ) {
      // Each Excel sheet is converted to CSV with a "=== Sheet: <name> ===" header
      const workbook = XLSX.read(buf, { type: 'buffer' });
      return workbook.SheetNames.map((sheet) => {
        const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[sheet]);
        return `=== Sheet: ${sheet} ===\n${csv}`;
      }).join('\n\n');
    }

    if (mimeType.startsWith('text/')) {
      return buf.toString('utf-8');
    }

    if (IMAGE_MIME_TYPES.includes(mimeType as ImageMimeType)) {
      // OCR via Claude Haiku: optimal for images with text (price lists, datasheets)
      return this.extractTextFromImage(buf, mimeType as ImageMimeType, name);
    }

    return ''; // unsupported format
  }

  /**
   * Normalizes the text extracted from PDF, fixing the typical pdf-parse issues:
   *   - Words merged across line end and start (e.g. "caroIgor" → "caro Igor")
   *   - Numbers stuck to letters (e.g. "mq3" → "mq 3", "3mq" → "3 mq")
   *   - Excessive blank lines (more than 2 consecutive reduced to 2)
   *
   * These corrections significantly improve the embedding quality
   * because the model can correctly recognize the word tokens.
   *
   * @param text - Raw text returned by pdf-parse
   */
  private fixPdfText(text: string): string {
    return text
      // Reinserts a space before an uppercase letter after a lowercase one (cross-line merged words)
      .replace(/([a-zàèéìòù])([A-ZÀÈÉÌÒÙ])/g, '$1 $2')
      // Reinserts a space before a number after a letter
      .replace(/([a-zA-Z])(\d)/g, '$1 $2')
      // Reinserts a space after a number before a letter
      .replace(/(\d)([a-zA-Z])/g, '$1 $2')
      // Reduces 3+ consecutive newlines to 2
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /**
   * Extracts the text from an image using the vision model configured as OCR.
   *
   * Cross-provider via LangChain (multimodal `image_url` format with data-URL,
   * converted by the adapters for Anthropic/OpenAI/Gemini/Ollama). The model is
   * the `isVision` config of llm_configs, falling back to the default; if the default does
   * not support images the invocation fails and OCR is skipped with a warn.
   *
   * If the image contains no text, the model returns a description of the
   * content (useful anyway for semantic embedding).
   *
   * @param buf      - Buffer of the image file
   * @param mimeType - MIME type of the image (jpeg/png/webp/gif)
   * @param name     - Original file name (for the log in case of error)
   */
  private async extractTextFromImage(buf: Buffer, mimeType: ImageMimeType, name: string): Promise<string> {
    try {
      const entity = await this.llmConfigs?.getVision();
      if (!entity) {
        this.logger.warn(`Image OCR skipped for ${name}: no LLM config (Settings → AI System)`);
        return '';
      }
      const model = await this.llmConfigs!.buildModelForConfig(entity, { maxTokens: 1024 });
      const response = await model.invoke([
        new HumanMessage({
          content: [
            {
              type:      'image_url',
              image_url: { url: `data:${mimeType};base64,${buf.toString('base64')}` },
            },
            {
              type: 'text',
              text: 'Extract all the visible text in this image. ' +
                    'If there is no text, briefly describe the content. ' +
                    'Respond only with the extracted text or the description, without preamble.',
            },
          ],
        }),
      ]);

      const content: any = response.content;
      if (typeof content === 'string') return content;
      const textBlock = (content as any[]).find((b: any) => b.type === 'text');
      return textBlock?.text ?? '';
    } catch (err) {
      this.logger.warn(`Image OCR failed for ${name} (vision model not multimodal?): ${err.message}`);
      return '';
    }
  }

  /**
   * Updates the file's vectorization state on the DB.
   * Called by EmbedService after successfully indexing the file in Qdrant.
   *
   * @param id           - ID of the file
   * @param collectionId - Name of the Qdrant collection into which it was indexed
   */
  markVectorized(id: string, collectionId: string) {
    return this.repo.update(id, { vectorized: true, vectorCollectionId: collectionId });
  }
}
