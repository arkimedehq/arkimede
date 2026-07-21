/**
 * @file internal-datasources.controller.ts
 *
 * Internal endpoints to run queries on datasources configured by the user.
 * Used by skills via BACKEND_INTERNAL_URL + run token (header x-internal-token).
 *
 * POST /internal/datasources/:id/query
 *   Dispatch by the DataSource engine family:
 *   - relational (Postgres/MySQL/MariaDB/MSSQL/Oracle/SQLite): `sql` field with
 *     positional parameters (`?` / `$1`), translated to named and bound by the driver;
 *   - document (MongoDB): `mongo` field with the operation spec
 *     { collection, op, filter|pipeline, projection, sort, update, document(s), limit }.
 *
 * Security:
 *   - Protected by InternalTokenGuard (signed run token → verified identity)
 *   - Scope enforcement: the datasource is resolved with `resolveDataSource(id, userId)`,
 *     where userId = `request.internalAuth.sub`. An identity without access to the scope
 *     (personal/team/org) → 404. Run without identity → 403 (fail-closed).
 *   - SQL: prepared statements; Mongo: filters/pipeline passed as objects (no eval)
 */
import {
  BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, HttpStatus,
  Logger, Param, Post, Query, Req, UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsArray, IsNumber, IsObject, IsOptional, IsPositive, IsString, Max } from 'class-validator';
import * as path from 'path';

import { InternalTokenGuard, internalUserId } from '../common/guards/internal-token.guard';
import { DataSourcesService } from './datasources.service';
import { getDriver } from './drivers';
import { mongoDriver, MongoExecuteSpec } from './mongo/mongo.driver';
import { redisDriver } from './redis/redis.driver';
import { fileshareDriver, FileShareSpec } from './fileshare/fileshare.driver';
import { engineFamily, EngineFamily, FileShareEngine } from './engine.types';

/**
 * Reserved ID of the "Local" file-share source (backend filesystem,
 * SKILLS_OUTPUT_DIR). It is not a DB DataSource: it is virtual, always present for
 * every user, managed via config. See `resolveLocalConnStr`.
 */
const LOCAL_SOURCE_ID = 'local';

/**
 * Translates positional placeholders (sequential `?` and indexed `$N`) into named
 * `:pN`, so the driver can bind them uniformly across all SQL engines.
 */
function positionalToNamed(
  sql: string,
  params: (string | number | null)[],
): { sql: string; named: Record<string, unknown> } {
  const named: Record<string, unknown> = {};
  let seq = 0;
  let out = sql.replace(/\$(\d+)/g, (_m, n: string) => {
    const idx = Number(n) - 1;
    named[`p${idx}`] = params[idx] ?? null;
    return `:p${idx}`;
  });
  out = out.replace(/\?/g, () => {
    named[`p${seq}`] = params[seq] ?? null;
    const ph = `:p${seq}`;
    seq++;
    return ph;
  });
  return { sql: out, named };
}

class DatasourceQueryDto {
  /** SQL query (relational sources). */
  @IsOptional() @IsString()
  sql?: string;

  @IsOptional() @IsArray()
  params?: (string | number | null)[];

  @IsOptional() @IsNumber() @IsPositive() @Max(10_000)
  limit?: number;

  /** MongoDB operation spec (document sources). */
  @IsOptional() @IsObject()
  mongo?: MongoExecuteSpec;

  /** Redis command spec (key-value sources): { command, args }. */
  @IsOptional() @IsObject()
  redis?: { command: string; args?: unknown[] };

  /** File-share operation spec (smb/sftp/webdav): { op, path, content?, recursive? }. */
  @IsOptional() @IsObject()
  file?: FileShareSpec;
}

@UseGuards(InternalTokenGuard)
@Controller('internal/datasources')
export class InternalDatasourcesController {
  private readonly logger = new Logger(InternalDatasourcesController.name);

  constructor(
    private readonly datasourcesService: DataSourcesService,
    private readonly config: ConfigService,
  ) {}

  /** Base dir of the local source = SKILLS_OUTPUT_DIR (default UPLOAD_DIR/skills-output). */
  private localBase(): string {
    const uploadDir = this.config.get<string>('UPLOAD_DIR', './uploads');
    const out = this.config.get<string>('SKILLS_OUTPUT_DIR', path.join(uploadDir, 'skills-output'));
    return path.resolve(out);
  }

  /**
   * Virtual connection string of the 'local' source, CONFINED to the caller's
   * per-user subdir of SKILLS_OUTPUT_DIR (physical tenant isolation, mirrors where
   * skills/sandbox write their outputs). Without this, a recursive `list` on the
   * shared root would walk every tenant's subdir → cross-tenant file read (F2).
   * Cross-tenant SHARING (team/project) stays served by the access-aware File
   * download (by-id / project panel), not by the raw local fileshare.
   */
  private localConnStr(userId: string): string {
    const sub = (userId || '').replace(/[^a-zA-Z0-9_-]/g, '') || '_shared';
    return `local://${path.join(this.localBase(), sub)}`;
  }

  /**
   * GET /internal/datasources?family=fileshare
   *
   * Lists the DataSources accessible to the run user (for the skill fan-out).
   * For family=fileshare it prepends the virtual "Local" source (id 'local'), so the
   * `files` skill searches locally + all configured network shares.
   */
  @Get()
  async list(
    @Query('family') family: string | undefined,
    @Req() req: { internalAuth?: { sub?: string } },
  ): Promise<{ sources: { id: string; name: string; engine: string; family: EngineFamily }[] }> {
    const userId = internalUserId(req);
    if (!userId) {
      throw new ForbiddenException('Run without identity: datasource access denied.');
    }
    const all = await this.datasourcesService.findAll(userId);
    let sources = all
      .filter((ds) => !family || engineFamily(ds.engine) === family)
      .map((ds) => ({ id: ds.id, name: ds.name, engine: ds.engine, family: engineFamily(ds.engine) }));

    if (!family || family === 'fileshare') {
      sources = [
        { id: LOCAL_SOURCE_ID, name: 'Locale', engine: 'local', family: 'fileshare' as EngineFamily },
        ...sources,
      ];
    }
    return { sources };
  }

  /**
   * POST /internal/datasources/:id/query
   *
   * Runs a query on the datasource (SQL or Mongo) and returns the rows/documents.
   * Response: { rows: [...], count: number, engine: string }
   */
  @Post(':id/query')
  @HttpCode(HttpStatus.OK)
  async query(
    @Param('id') datasourceId: string,
    @Body() dto: DatasourceQueryDto,
    @Req() req: { internalAuth?: { sub?: string } },
  ): Promise<{ rows: Record<string, unknown>[]; count: number; engine: string }> {
    // Identity verified by the run token. Fail-closed: no identity → no access.
    const userId = internalUserId(req);
    if (!userId) {
      throw new ForbiddenException('Run without identity: datasource access denied.');
    }

    // ── Virtual "Local" source (backend filesystem) ─────────────────────────────
    // Not in the DB. CONFINED to the caller's per-user subdir of SKILLS_OUTPUT_DIR
    // (see localConnStr): list/read/write/delete cannot reach another tenant's
    // outputs. Cross-tenant sharing goes through the access-aware File download.
    // File operations only.
    if (datasourceId === LOCAL_SOURCE_ID) {
      const spec = dto.file;
      if (!spec?.op) {
        throw new BadRequestException('For the local source specify "file": { op, path, ... }.');
      }
      this.logger.log(`[internal] fileshare datasource="local" op=${spec.op} path="${spec.path ?? ''}"`);
      const res = await fileshareDriver.execute('local', this.localConnStr(userId), spec);
      const rows = res.entries
        ?? [{ path: res.path, content: res.content, size: res.size, encoding: res.encoding, ok: res.ok }];
      return { rows: rows as Record<string, unknown>[], count: rows.length, engine: 'local' };
    }

    // Scope check (own / team / org) tied to the run identity.
    const ds = await this.datasourcesService.resolveDataSource(datasourceId, userId);

    // ── MongoDB (document family) ───────────────────────────────────────────────
    if (engineFamily(ds.engine) === 'document') {
      const spec = dto.mongo;
      if (!spec?.collection || !spec?.op) {
        throw new BadRequestException(
          'For a MongoDB source specify "mongo": { collection, op, filter|pipeline, … }.',
        );
      }
      const maxRows = Math.min(dto.limit ?? spec.limit ?? 1000, 10_000);
      this.logger.log(`[internal] mongo datasource="${datasourceId}" op=${spec.op} coll=${spec.collection}`);
      const res = await mongoDriver.execute(ds.connectionString, spec, maxRows, 10_000);
      return { rows: res.rows, count: res.rows.length, engine: ds.engine };
    }

    // ── Redis (key-value family) ────────────────────────────────────────────────
    if (engineFamily(ds.engine) === 'keyvalue') {
      const spec = dto.redis;
      if (!spec?.command) {
        throw new BadRequestException('For a Redis source specify "redis": { command, args }.');
      }
      this.logger.log(`[internal] redis datasource="${datasourceId}" command=${spec.command}`);
      const { reply } = await redisDriver.execute(ds.connectionString, spec.command, spec.args ?? []);
      const rows = Array.isArray(reply) ? reply.map((v) => ({ value: v })) : [{ value: reply }];
      return { rows, count: rows.length, engine: ds.engine };
    }

    // ── File-share (fileshare family: smb/sftp/webdav) ──────────────────────────
    if (engineFamily(ds.engine) === 'fileshare') {
      const spec = dto.file;
      if (!spec?.op) {
        throw new BadRequestException('For a file-share source specify "file": { op, path, ... }.');
      }
      this.logger.log(`[internal] fileshare datasource="${datasourceId}" op=${spec.op} path="${spec.path ?? ''}"`);
      const res = await fileshareDriver.execute(ds.engine as FileShareEngine, ds.connectionString, spec);
      const rows = res.entries
        ?? [{ path: res.path, content: res.content, size: res.size, encoding: res.encoding, ok: res.ok }];
      return { rows: rows as Record<string, unknown>[], count: rows.length, engine: ds.engine };
    }

    // ── Relational (relational family) ──────────────────────────────────────────
    if (!dto.sql) {
      throw new BadRequestException('Specify "sql" for a relational source.');
    }
    const driver = getDriver(ds.engine);
    const params = dto.params ?? [];

    let sql = dto.sql.trim();
    if (dto.limit) sql = driver.applyRowLimit(sql, dto.limit);

    const { sql: namedSql, named } = positionalToNamed(sql, params);

    this.logger.log(
      `[internal] query datasource="${datasourceId}" engine=${ds.engine} params=${params.length}`,
    );

    const res = await driver.execute(ds.connectionString, {
      sql:      namedSql,
      params:   named,
      readOnly: false,
      timeout:  10_000,
      rawQuery: params.length === 0,
    });

    return { rows: res.rows, count: res.rows.length, engine: ds.engine };
  }
}
