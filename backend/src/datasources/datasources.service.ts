/**
 * @file datasources.service.ts
 *
 * Service for managing external data sources.
 *
 * Responsibilities:
 *   - CRUD on DataSourceEntity with ownership/scope check
 *   - Encryption/decryption of the connection string
 *   - resolveDataSource() → used by CustomToolsService before buildDynamicTool
 *
 * The connection string is NEVER returned in API responses.
 * The only method that decrypts it is resolveDataSource(), reserved for internal services.
 */
import {
  Injectable, Logger, NotFoundException, Inject, BadRequestException,
  ConflictException, Optional, ForbiddenException,
} from '@nestjs/common';
import { I18nContext } from 'nestjs-i18n';
import { ConfigService } from '@nestjs/config';
import * as path from 'path';
import { Readable } from 'stream';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not, In } from 'typeorm';
import { DataSourceEntity, DataSourceScope } from './datasource.entity';
import { encrypt, decrypt } from '../custom-tools/crypto.utils';
import { ResolvedDataSource } from '../custom-tools/custom-tool.types';
import { SchemaManifest } from './schema-manifest.types';
import { DocumentManifest } from './document-manifest.types';
import { KeyspaceManifest } from './keyspace-manifest.types';
import { DataSourceEngine, FileShareEngine, isDataSourceEngine, engineFamily } from './engine.types';
import { getDriver } from './drivers';
import { mongoDriver } from './mongo/mongo.driver';
import { redisDriver } from './redis/redis.driver';
import { fileshareDriver } from './fileshare/fileshare.driver';
import { TeamsService } from '../teams/teams.service';
import { AuditService } from '../audit/audit.service';
import { AppConfigEntity } from '../app-config/app-config.entity';
import { assertDataSourceTargetAllowed, DataSourceHostPolicy } from '../common/datasource-host-guard';

type AnyManifest = SchemaManifest | DocumentManifest | KeyspaceManifest;

export interface CreateDataSourceDto {
  name: string;
  description?: string;
  engine?: DataSourceEngine;      // default 'postgres'
  connectionString: string;       // plaintext — encrypted before saving
  schemaHints?: string;
  prefetchRelations?: boolean;
  scope?: DataSourceScope;
  teamId?: string | null;
}

export interface UpdateDataSourceDto extends Partial<Omit<CreateDataSourceDto, 'name'>> {
  name?: string;
}

/** Outcome of a connection test to a DataSource. */
export interface TestConnectionResult {
  ok: boolean;
  /** Milliseconds taken by the attempt (also on error). */
  latencyMs: number;
  /** Error message when ok=false. */
  message?: string;
}

/** DTO returned in the APIs — without encryptedConnectionString */
export interface DataSourceDto {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  engine: DataSourceEngine;
  schemaHints: string | null;
  prefetchRelations: boolean;
  /** Enriched schema (null until generated). Not a secret → returned in full. */
  schemaManifest: AnyManifest | null;
  scope: DataSourceScope;
  teamId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toDto(ds: DataSourceEntity): DataSourceDto {
  return {
    id:                ds.id,
    userId:            ds.userId,
    name:              ds.name,
    description:       ds.description,
    engine:            ds.engine,
    schemaHints:       ds.schemaHints,
    prefetchRelations: ds.prefetchRelations,
    schemaManifest:    ds.schemaManifest,
    scope:             ds.scope,
    teamId:            ds.teamId,
    createdAt:         ds.createdAt,
    updatedAt:         ds.updatedAt,
  };
}

@Injectable()
export class DataSourcesService {
  private readonly logger = new Logger(DataSourcesService.name);

  constructor(
    @InjectRepository(DataSourceEntity)
    private readonly repo: Repository<DataSourceEntity>,
    @Inject(TeamsService)
    private readonly teamsService: TeamsService,
    @Inject(ConfigService)
    private readonly config: ConfigService,
    @InjectRepository(AppConfigEntity)
    private readonly appConfigRepo: Repository<AppConfigEntity>,
    @Optional() private readonly audit?: AuditService,
  ) {}

  /**
   * Anti-SSRF policy for DataSource connections, read from app_config. Permissive
   * default (allow private hosts; metadata always blocked) if the row is missing.
   */
  private async getHostPolicy(): Promise<DataSourceHostPolicy> {
    const cfg = await this.appConfigRepo.findOne({ where: { id: 1 } }).catch(() => null);
    return {
      allowPrivateHosts: cfg?.dataSourceAllowPrivateHosts ?? true,
      allowlist: Array.isArray(cfg?.dataSourceHostAllowlist) ? cfg!.dataSourceHostAllowlist : [],
    };
  }

  /** Enforces the anti-SSRF policy on a (engine, connection string) before connecting. */
  private async assertConnAllowed(engine: string, connStr: string): Promise<void> {
    await assertDataSourceTargetAllowed(engine, connStr, await this.getHostPolicy());
  }

  /** Id of the virtual "Local" source (backend filesystem, not in the DB). */
  static readonly LOCAL_SOURCE_ID = 'local';

  /**
   * Virtual connection string of the 'local' source, CONFINED to the caller's
   * per-user subdir of SKILLS_OUTPUT_DIR — where skills/sandbox physically write
   * their outputs (per-tenant isolation). Mirrors `internal-datasources.controller`:
   * without the `<userId>` subdir the shared root would expose every tenant's
   * outputs (stat/stream by an arbitrary `path`). Cross-tenant SHARING (team/project)
   * stays served by the access-aware File download (by-id), not by the raw fileshare.
   */
  private localConnStr(userId: string): string {
    const uploadDir = this.config.get<string>('UPLOAD_DIR', './uploads');
    const out = this.config.get<string>('SKILLS_OUTPUT_DIR', path.join(uploadDir, 'skills-output'));
    const sub = (userId || '').replace(/[^a-zA-Z0-9_-]/g, '') || '_shared';
    return `local://${path.join(path.resolve(out), sub)}`;
  }

  /**
   * Resolves (engine, connection string) of a file-share source for streaming,
   * applying the scope check on the user. Handles both 'local' (virtual) and
   * network DataSources (smb/sftp/webdav). Throws if the source is not a file-share.
   */
  private async resolveFileShare(
    sourceId: string,
    userId: string,
  ): Promise<{ engine: FileShareEngine; connectionString: string }> {
    if (sourceId === DataSourcesService.LOCAL_SOURCE_ID) {
      // Fail-closed: no identity → no access to the local outputs (never the shared root).
      if (!userId) {
        throw new ForbiddenException(
          I18nContext.current()?.t('datasources.localRequiresIdentity')
          ?? 'Access to local files requires an identity',
        );
      }
      return { engine: 'local', connectionString: this.localConnStr(userId) };
    }
    const ds = await this.resolveDataSource(sourceId, userId); // scope check + decrypt
    if (engineFamily(ds.engine) !== 'fileshare') {
      throw new BadRequestException(
        I18nContext.current()?.t('datasources.notFileShare') ?? 'The source is not a shared folder',
      );
    }
    return { engine: ds.engine as FileShareEngine, connectionString: ds.connectionString };
  }

  /**
   * Maps low-level file-share driver errors to proper HTTP statuses so a
   * containment/anti-traversal rejection surfaces as 403 (not a raw 500) and a
   * missing path (including a per-user base dir that does not exist yet) as 404.
   * Any other error is rethrown unchanged. Applies to every engine.
   */
  private mapFileShareError(err: unknown): never {
    const msg = err instanceof Error ? err.message : String(err);
    if (/outside the base/i.test(msg)) {
      throw new ForbiddenException(
        I18nContext.current()?.t('datasources.filePathNotAllowed') ?? 'File path not allowed',
      );
    }
    if (/ENOENT|no such file or directory/i.test(msg)) {
      throw new NotFoundException(
        I18nContext.current()?.t('datasources.fileNotFound') ?? 'File not found',
      );
    }
    throw err;
  }

  /** Size (bytes) of a file in a file-share source, with scope check. */
  async statFileShare(sourceId: string, userId: string, rel: string): Promise<number> {
    const { engine, connectionString } = await this.resolveFileShare(sourceId, userId);
    try {
      return await fileshareDriver.statFile(engine, connectionString, rel);
    } catch (err) {
      this.mapFileShareError(err);
    }
  }

  /**
   * Opens a stream (possibly ranged) on a file of a file-share source,
   * with scope check. For HTTP streaming: no in-memory read of the whole file.
   */
  async openFileShareStream(
    sourceId: string,
    userId: string,
    rel: string,
    range?: { start?: number; end?: number },
  ): Promise<Readable> {
    const { engine, connectionString } = await this.resolveFileShare(sourceId, userId);
    try {
      return await fileshareDriver.openFileStream(engine, connectionString, rel, range);
    } catch (err) {
      this.mapFileShareError(err);
    }
  }

  /**
   * Reads the COMPLETE bytes of a file from a file-share source (with scope check),
   * rejecting files over `maxBytes` to avoid OOM. Used by the BE ingestion
   * pipeline (text extraction from PDF/DOCX/…). Not suitable for very large files:
   * in that case streaming is used.
   */
  async readFileShareBytes(
    sourceId: string,
    userId: string,
    rel: string,
    maxBytes: number,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const size = await this.statFileShare(sourceId, userId, rel);
    if (size > maxBytes) {
      throw new BadRequestException(
        I18nContext.current()?.t('datasources.fileTooLargeIngest', { args: { size, max: maxBytes } })
          ?? `File too large for indexing (${size} bytes > ${maxBytes}).`,
      );
    }
    const stream = await this.openFileShareStream(sourceId, userId, rel);
    const chunks: Buffer[] = [];
    let read = 0;
    for await (const chunk of stream) {
      const b = chunk as Buffer;
      read += b.length;
      if (read > maxBytes) {                 // guard: size grew after the stat
        stream.destroy();
        throw new BadRequestException(
          I18nContext.current()?.t('datasources.fileTooLargeIngest', { args: { size: read, max: maxBytes } })
            ?? `File too large for indexing (> ${maxBytes} bytes).`,
        );
      }
      chunks.push(b);
    }
    return { buffer: Buffer.concat(chunks), filename: path.basename(rel.replace(/\/+$/, '')) || 'file' };
  }

  /** Visibility OR conditions: own + user's teams + org. */
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

  // ── Reading for the API ────────────────────────────────────────────────────────

  /** List all data sources accessible by the user (own + others' shared). */
  async findAll(userId: string): Promise<DataSourceDto[]> {
    const teamIds = await this.teamsService.teamIdsForUser(userId);
    const rows = await this.repo.find({
      where: this.visibilityWhere(userId, teamIds),
      order: { createdAt: 'DESC' },
    });
    return rows.map(toDto);
  }

  /** Single accessible data source (own OR shared). */
  async findOneAccessible(id: string, userId: string): Promise<DataSourceDto> {
    const ds = await this.findEntityAccessible(id, userId);
    return toDto(ds);
  }

  // ── Internal reading (with decrypted connection string) ────────────────────────

  /**
   * Resolves the data source, decrypting its connection string.
   * Used ONLY by CustomToolsService — never exposed via API.
   *
   * @throws NotFoundException if it does not exist or is not accessible by the user
   */
  async resolveDataSource(id: string, userId: string): Promise<ResolvedDataSource> {
    const ds = await this.findEntityAccessible(id, userId);
    let connectionString: string;
    try {
      connectionString = decrypt(ds.encryptedConnectionString);
    } catch (err: any) {
      this.logger.error(`Failed to decrypt connection string for DataSource "${ds.name}": ${err.message}`);
      throw new Error(`DataSource "${ds.name}": connection string non decifrabile`);
    }
    // Anti-SSRF at run time (re-resolves DNS each run → mitigates rebinding).
    await this.assertConnAllowed(ds.engine, connectionString);
    return {
      engine:            ds.engine,
      connectionString,
      schemaHints:       ds.schemaHints ?? undefined,
      prefetchRelations: ds.prefetchRelations,
      schemaManifest:    ds.schemaManifest,
    };
  }

  /**
   * Resolves a data source by ID without ownership check.
   * Used ONLY by internal endpoints (InternalApiKeyGuard) — never exposed to users.
   */
  async resolveDataSourceById(id: string): Promise<ResolvedDataSource & { name: string }> {
    const ds = await this.repo.findOne({ where: { id } });
    if (!ds) throw new NotFoundException(
      I18nContext.current()?.t('datasources.notFound', { args: { id } })
        ?? `DataSource "${id}" not found`,
    );
    let connectionString: string;
    try {
      connectionString = decrypt(ds.encryptedConnectionString);
    } catch (err: any) {
      throw new Error(`DataSource "${ds.name}": connection string non decifrabile`);
    }
    // Anti-SSRF at run time (re-resolves DNS each run → mitigates rebinding).
    await this.assertConnAllowed(ds.engine, connectionString);
    return {
      name:              ds.name,
      engine:            ds.engine,
      connectionString,
      schemaHints:       ds.schemaHints ?? undefined,
      prefetchRelations: ds.prefetchRelations,
      schemaManifest:    ds.schemaManifest,
    };
  }

  // ── Schema manifest ──────────────────────────────────────────────────────────

  /**
   * Persists the schema manifest (introspection/enrich/user edit).
   * Authorization handled by the controller; here lookup by id.
   */
  async saveSchemaManifest(
    id: string,
    manifest: AnyManifest | null,
  ): Promise<DataSourceDto> {
    const ds = await this.findEntityById(id);
    ds.schemaManifest = manifest;
    const saved = await this.repo.save(ds);
    const summary = !manifest ? 'cleared'
      : 'patterns' in manifest
        ? `saved (${manifest.patterns.length} patterns)`
        : 'collections' in manifest
          ? `saved (${manifest.collections.length} collections)`
          : `saved (${manifest.tables.length} tables, ${manifest.relations.length} relations)`;
    this.logger.log(`DataSource "${ds.name}": manifest ${summary}`);
    return toDto(saved);
  }

  // ── CRUD ─────────────────────────────────────────────────────────────────────

  async create(userId: string, dto: CreateDataSourceDto): Promise<DataSourceDto> {
    const scope = dto.scope ?? 'personal';
    const teamId = scope === 'team' ? (dto.teamId ?? null) : null;
    if (scope === 'team' && !teamId) {
      throw new BadRequestException('datasources.teamIdRequired');
    }
    const engine = this.normalizeEngine(dto.engine);
    await this.assertNameAvailable(dto.name, scope, teamId, null);
    await this.assertConnAllowed(engine, dto.connectionString); // anti-SSRF (fail-fast at save)

    const ds = this.repo.create({
      userId,
      name:                       dto.name,
      description:                dto.description ?? null,
      engine,
      encryptedConnectionString:  encrypt(dto.connectionString),
      schemaHints:                dto.schemaHints ?? null,
      prefetchRelations:          dto.prefetchRelations ?? false,
      scope,
      teamId,
    });

    const saved = await this.repo.save(ds);
    this.logger.log(`DataSource creata: "${dto.name}" scope=${scope} (user: ${userId})`);
    await this.audit?.record({
      actorId: userId,
      action: 'datasource.create',
      resource: saved.name,
      outcome: 'ok',
      ctx: { id: saved.id, engine: saved.engine, family: engineFamily(saved.engine), scope: saved.scope, teamId: saved.teamId },
    });
    return toDto(saved);
  }

  async update(id: string, userId: string, dto: UpdateDataSourceDto): Promise<DataSourceDto> {
    // Authorization handled by the controller; here lookup by id.
    const ds = await this.findEntityById(id);

    const nextName  = dto.name ?? ds.name;
    const nextScope = dto.scope ?? ds.scope;
    const nextTeamId = nextScope === 'team'
      ? (dto.teamId !== undefined ? dto.teamId : ds.teamId)
      : null;
    if (nextScope === 'team' && !nextTeamId) {
      throw new BadRequestException('datasources.teamIdRequired');
    }

    const scopeOrTeamOrNameChanged =
      nextName !== ds.name || nextScope !== ds.scope || nextTeamId !== ds.teamId;
    if (scopeOrTeamOrNameChanged) {
      await this.assertNameAvailable(nextName, nextScope, nextTeamId, id);
    }

    if (dto.name               !== undefined) ds.name               = dto.name;
    if (dto.description        !== undefined) ds.description        = dto.description ?? null;
    if (dto.engine             !== undefined) ds.engine             = this.normalizeEngine(dto.engine);
    if (dto.schemaHints        !== undefined) ds.schemaHints        = dto.schemaHints ?? null;
    if (dto.prefetchRelations  !== undefined) ds.prefetchRelations  = dto.prefetchRelations;
    if (dto.scope !== undefined) ds.scope = nextScope;
    if (dto.scope !== undefined || dto.teamId !== undefined) ds.teamId = nextTeamId;

    if (dto.connectionString) {
      await this.assertConnAllowed(ds.engine, dto.connectionString); // anti-SSRF (fail-fast at save)
      ds.encryptedConnectionString = encrypt(dto.connectionString);
    }

    const saved = await this.repo.save(ds);
    this.logger.log(`DataSource updated: "${ds.name}" (user: ${userId})`);
    await this.audit?.record({
      actorId: userId,
      action: 'datasource.update',
      resource: saved.name,
      outcome: 'ok',
      ctx: { id: saved.id, engine: saved.engine, family: engineFamily(saved.engine), scope: saved.scope, teamId: saved.teamId },
    });
    return toDto(saved);
  }

  async remove(id: string, userId: string): Promise<void> {
    const ds = await this.findEntityById(id);
    const removedId = ds.id;
    await this.repo.remove(ds);
    this.logger.log(`DataSource deleted: "${ds.name}" (user: ${userId})`);
    await this.audit?.record({
      actorId: userId,
      action: 'datasource.delete',
      resource: ds.name,
      outcome: 'ok',
      ctx: { id: removedId, engine: ds.engine, family: engineFamily(ds.engine), scope: ds.scope, teamId: ds.teamId },
    });
  }

  /** Validates the engine (default 'postgres'). Throws if it is not a supported engine. */
  private normalizeEngine(engine?: string): DataSourceEngine {
    const e = engine ?? 'postgres';
    if (!isDataSourceEngine(e)) {
      throw new BadRequestException(
        I18nContext.current()?.t('datasources.engineUnsupported', { args: { engine: e } })
          ?? `Engine "${e}" non supportato.`,
      );
    }
    return e;
  }

  // ── Connection test ───────────────────────────────────────────────────────────

  /** Opens the connection with the engine driver (SQL or Mongo) and does a ping. */
  private async runConnectionTest(engine: DataSourceEngine, connStr: string): Promise<TestConnectionResult> {
    const t0 = Date.now();
    try {
      await this.assertConnAllowed(engine, connStr); // anti-SSRF before any connect
      const fam = engineFamily(engine);
      if (fam === 'document')       await mongoDriver.testConnection(connStr);
      else if (fam === 'keyvalue')  await redisDriver.testConnection(connStr);
      else if (fam === 'fileshare') await fileshareDriver.testConnection(engine as FileShareEngine, connStr);
      else                          await getDriver(engine).testConnection(connStr);
      return { ok: true, latencyMs: Date.now() - t0 };
    } catch (err: any) {
      this.logger.warn(`Connection test (${engine}) failed: ${err.message}`);
      return { ok: false, latencyMs: Date.now() - t0, message: String(err.message ?? err) };
    }
  }

  /** Pre-save connection test: connection string + engine provided by the client. */
  async testConnection(connStr: string, engine?: string): Promise<TestConnectionResult> {
    return this.runConnectionTest(this.normalizeEngine(engine), connStr);
  }

  /** Connection test on a saved DataSource (authorization handled by the controller). */
  async testConnectionById(id: string, userId?: string): Promise<TestConnectionResult> {
    const ds = await this.findEntityById(id);
    let connStr: string;
    try {
      connStr = decrypt(ds.encryptedConnectionString);
    } catch (err: any) {
      await this.audit?.record({
        actorId: userId ?? null,
        action: 'datasource.test',
        resource: ds.name,
        outcome: 'error',
        ctx: { id: ds.id, engine: ds.engine, family: engineFamily(ds.engine), scope: ds.scope, teamId: ds.teamId },
      });
      return { ok: false, latencyMs: 0, message: `connection string non decifrabile: ${err.message}` };
    }
    const result = await this.runConnectionTest(ds.engine, connStr);
    await this.audit?.record({
      actorId: userId ?? null,
      action: 'datasource.test',
      resource: ds.name,
      outcome: result.ok ? 'ok' : 'error',
      ctx: { id: ds.id, engine: ds.engine, family: engineFamily(ds.engine), scope: ds.scope, teamId: ds.teamId },
    });
    return result;
  }

  // ── Browse file-share (for the folder picker during configuration) ──

  /** Lists the content of a folder on a file-share. `path` relative to the base. */
  private async browseFileShareConn(
    engine: DataSourceEngine,
    connStr: string,
    rel: string,
  ): Promise<{ path: string; entries: import('./fileshare/fileshare.driver').FileEntry[] }> {
    if (engineFamily(engine) !== 'fileshare') {
      throw new BadRequestException('datasources.browseOnlyFileshare');
    }
    await this.assertConnAllowed(engine, connStr); // anti-SSRF (propagates 403)
    try {
      const res = await fileshareDriver.execute(engine as FileShareEngine, connStr, {
        op: 'list',
        path: rel || '',
      });
      return { path: rel || '', entries: res.entries ?? [] };
    } catch (err: any) {
      // Driver errors (connection/credentials/path) → 400 with a readable cause
      // for the picker, instead of an opaque 500.
      throw new BadRequestException(String(err?.message ?? err));
    }
  }

  /** Pre-save browse: engine + connection string provided by the client (creation flow). */
  async browseFileShare(engine: string | undefined, connStr: string, rel: string) {
    return this.browseFileShareConn(this.normalizeEngine(engine), connStr, rel);
  }

  /** Browse on a saved DataSource: scope-check + decryption via resolveDataSource. */
  async browseFileShareById(id: string, userId: string, rel: string) {
    const ds = await this.resolveDataSource(id, userId);
    return this.browseFileShareConn(ds.engine, ds.connectionString, rel);
  }

  /**
   * Sets the base path of a saved file-share: appends `rel` (relative to the current
   * base, from the folder picker) to the encrypted connection string and re-saves it.
   * Used by the "Use this folder" button when the DataSource is already saved (the
   * plaintext string is not in the form). Authorization handled by the controller.
   */
  async setFileShareBase(id: string, rel: string): Promise<DataSourceDto> {
    const ds = await this.findEntityById(id);
    if (engineFamily(ds.engine) !== 'fileshare') {
      throw new BadRequestException('datasources.browseOnlyFileshare');
    }
    let connStr: string;
    try {
      connStr = decrypt(ds.encryptedConnectionString);
    } catch (err: any) {
      throw new BadRequestException(`connection string non decifrabile: ${err.message}`);
    }
    const sub = (rel || '').replace(/^\/+|\/+$/g, '');
    const newConn = connStr.replace(/\/+$/, '') + (sub ? `/${sub}` : '');
    ds.encryptedConnectionString = encrypt(newConn);
    const saved = await this.repo.save(ds);
    this.logger.log(`DataSource "${ds.name}": file-share base updated via browse`);
    return toDto(saved);
  }

  /** Name uniqueness per scope: org global, team per-team (personal not constrained here). */
  private async assertNameAvailable(
    name: string,
    scope: DataSourceScope,
    teamId: string | null,
    excludeId: string | null,
  ): Promise<void> {
    if (scope === 'org') {
      const clash = await this.repo.findOne({
        where: { name, scope: 'org' as any, ...(excludeId ? { id: Not(excludeId) } : {}) },
      });
      if (clash) throw new ConflictException(
        I18nContext.current()?.t('datasources.orgNameTaken', { args: { name } })
          ?? `An org data source already exists with the name "${name}".`,
      );
    }
    if (scope === 'team' && teamId) {
      const clash = await this.repo.findOne({
        where: { name, scope: 'team' as any, teamId, ...(excludeId ? { id: Not(excludeId) } : {}) },
      });
      if (clash) throw new ConflictException(
        I18nContext.current()?.t('datasources.teamNameTaken', { args: { name } })
          ?? `A team data source already exists with the name "${name}".`,
      );
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  /** True if `id` is a valid UUID. The `id` column is uuid: a non-UUID value
   *  would blow up Postgres (22P02) → we intercept it as "not found". */
  private isUuid(id: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  }

  private async findEntityAccessible(id: string, userId: string): Promise<DataSourceEntity> {
    if (!this.isUuid(id)) throw new NotFoundException(
      I18nContext.current()?.t('datasources.notFound', { args: { id } })
        ?? `DataSource "${id}" not found`,
    );
    const teamIds = await this.teamsService.teamIdsForUser(userId);
    const ds = await this.repo.findOne({
      where: this.visibilityWhere(userId, teamIds, { id }),
    });
    if (!ds) throw new NotFoundException(
      I18nContext.current()?.t('datasources.notFound', { args: { id } })
        ?? `DataSource "${id}" not found`,
    );
    return ds;
  }

  /** Lookup by id without ownership constraint (authorization handled by the controller). */
  async findEntityById(id: string): Promise<DataSourceEntity> {
    if (!this.isUuid(id)) throw new NotFoundException(
      I18nContext.current()?.t('datasources.notFound', { args: { id } })
        ?? `DataSource "${id}" not found`,
    );
    const ds = await this.repo.findOne({ where: { id } });
    if (!ds) throw new NotFoundException(
      I18nContext.current()?.t('datasources.notFound', { args: { id } })
        ?? `DataSource "${id}" not found`,
    );
    return ds;
  }
}
