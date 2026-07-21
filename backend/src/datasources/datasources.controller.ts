/**
 * @file datasources.controller.ts
 *
 * REST controller for managing external data sources.
 *
 * Endpoints:
 *   GET    /api/data-sources           — list accessible ones (own + shared)
 *   POST   /api/data-sources           — create new
 *   GET    /api/data-sources/:id       — detail (without connection string)
 *   PUT    /api/data-sources/:id       — update
 *   DELETE /api/data-sources/:id       — delete
 *
 * Security:
 *   - JWT required on all endpoints
 *   - The connection string never appears in responses
 *   - scope='shared': creation/modification reserved to admins
 */
import {
  Controller, Get, Post, Put, Delete,
  Body, Param, UseGuards, HttpCode, HttpStatus,
  ForbiddenException, Inject,
} from '@nestjs/common';
import {
  IsString, IsOptional, IsBoolean, IsIn, IsUUID, IsObject, MaxLength, MinLength,
} from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import {
  DataSourcesService,
  CreateDataSourceDto,
  UpdateDataSourceDto,
} from './datasources.service';
import { SchemaEnrichmentService } from './schema-enrichment.service';
import { SchemaManifest } from './schema-manifest.types';
import { DATASOURCE_ENGINES, DataSourceEngine } from './engine.types';
import { TeamsService } from '../teams/teams.service';
import {ApiTags} from "@nestjs/swagger";

class CreateDataSourceBody implements CreateDataSourceDto {
  @IsString() @MinLength(1) @MaxLength(100)
  name: string;

  @IsOptional() @IsString() @MaxLength(1000)
  description?: string;

  @IsOptional() @IsIn(DATASOURCE_ENGINES)
  engine?: DataSourceEngine;

  @IsString() @MinLength(3) @MaxLength(2048)
  connectionString: string;

  @IsOptional() @IsString() @MaxLength(10000)
  schemaHints?: string;

  @IsOptional() @IsBoolean()
  prefetchRelations?: boolean;

  @IsOptional() @IsString() @IsIn(['personal', 'team', 'org'])
  scope?: 'personal' | 'team' | 'org';

  @IsOptional() @IsUUID()
  teamId?: string | null;
}

class UpdateDataSourceBody implements UpdateDataSourceDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100)
  name?: string;

  @IsOptional() @IsString() @MaxLength(1000)
  description?: string;

  @IsOptional() @IsIn(DATASOURCE_ENGINES)
  engine?: DataSourceEngine;

  @IsOptional() @IsString() @MinLength(3) @MaxLength(2048)
  connectionString?: string;

  @IsOptional() @IsString() @MaxLength(10000)
  schemaHints?: string;

  @IsOptional() @IsBoolean()
  prefetchRelations?: boolean;

  @IsOptional() @IsString() @IsIn(['personal', 'team', 'org'])
  scope?: 'personal' | 'team' | 'org';

  @IsOptional() @IsUUID()
  teamId?: string | null;
}

class SaveManifestBody {
  @IsObject()
  manifest: SchemaManifest;
}

class TestConnectionBody {
  @IsString() @MinLength(3) @MaxLength(2048)
  connectionString: string;

  @IsOptional() @IsIn(DATASOURCE_ENGINES)
  engine?: DataSourceEngine;
}

class BrowseBody {
  @IsString() @MinLength(3) @MaxLength(2048)
  connectionString: string;

  @IsOptional() @IsIn(DATASOURCE_ENGINES)
  engine?: DataSourceEngine;

  /** Folder to list, relative to the share base. Empty = root. */
  @IsOptional() @IsString() @MaxLength(1024)
  path?: string;
}

class BrowseByIdBody {
  @IsOptional() @IsString() @MaxLength(1024)
  path?: string;
}

class EnrichBody {
  /** Model to use for enrichment (chosen by the user). Omitted = summarizer/default. */
  @IsOptional() @IsUUID()
  llmConfigId?: string;
}

@ApiTags('data-sources')
@Controller('api/data-sources')
@UseGuards(JwtAuthGuard)
export class DataSourcesController {
  constructor(
    @Inject(DataSourcesService) private readonly service: DataSourcesService,
    @Inject(SchemaEnrichmentService) private readonly enrichment: SchemaEnrichmentService,
    @Inject(TeamsService) private readonly teams: TeamsService,
  ) {}

  /** personal→owner, org→admin, team→admin or team owner. */
  private async assertCanManage(
    user: { id: string; role: string },
    scope: 'personal' | 'team' | 'org',
    teamId: string | null | undefined,
    ownerId?: string,
  ): Promise<void> {
    if (scope === 'org') {
      if (user.role !== 'admin') throw new ForbiddenException('datasources.orgForbidden');
      return;
    }
    if (scope === 'team') {
      if (!teamId) throw new ForbiddenException('datasources.teamIdMissing');
      if (user.role === 'admin') return;
      if (await this.teams.isOwner(teamId, user.id)) return;
      throw new ForbiddenException('datasources.teamForbidden');
    }
    if (ownerId !== undefined && ownerId !== user.id) {
      throw new ForbiddenException('datasources.ownerOnly');
    }
  }

  @Get()
  list(@CurrentUser() user: any) {
    return this.service.findAll(user.id);
  }

  @Get(':id')
  getOne(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.findOneAccessible(id, user.id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() body: CreateDataSourceBody, @CurrentUser() user: any) {
    await this.assertCanManage(user, body.scope ?? 'personal', body.teamId);
    return this.service.create(user.id, body);
  }

  /** PRE-save connection test: tries the provided connection string + engine. */
  @Post('test')
  @HttpCode(HttpStatus.OK)
  async testConnection(@Body() body: TestConnectionBody) {
    return this.service.testConnection(body.connectionString, body.engine);
  }

  /** Connection test on a saved DataSource (uses the encrypted connection string). */
  @Post(':id/test')
  @HttpCode(HttpStatus.OK)
  async testConnectionById(@Param('id') id: string, @CurrentUser() user: any) {
    const existing = await this.service.findEntityById(id);
    await this.assertCanManage(user, existing.scope, existing.teamId, existing.userId);
    return this.service.testConnectionById(id, user.id);
  }

  /** PRE-save browse of a file-share: lists folders (provided connString + engine). */
  @Post('browse')
  @HttpCode(HttpStatus.OK)
  async browse(@Body() body: BrowseBody) {
    return this.service.browseFileShare(body.engine, body.connectionString, body.path ?? '');
  }

  /** Browse on a saved file-share (uses the encrypted connection string, scope-check). */
  @Post(':id/browse')
  @HttpCode(HttpStatus.OK)
  async browseById(
    @Param('id') id: string,
    @Body() body: BrowseByIdBody,
    @CurrentUser() user: any,
  ) {
    const existing = await this.service.findEntityById(id);
    await this.assertCanManage(user, existing.scope, existing.teamId, existing.userId);
    return this.service.browseFileShareById(id, user.id, body.path ?? '');
  }

  /** Sets the base path of a saved file-share (from the folder picker: appends the path). */
  @Post(':id/browse-base')
  @HttpCode(HttpStatus.OK)
  async setFileShareBase(
    @Param('id') id: string,
    @Body() body: BrowseByIdBody,
    @CurrentUser() user: any,
  ) {
    const existing = await this.service.findEntityById(id);
    await this.assertCanManage(user, existing.scope, existing.teamId, existing.userId);
    return this.service.setFileShareBase(id, body.path ?? '');
  }

  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() body: UpdateDataSourceBody,
    @CurrentUser() user: any,
  ) {
    const existing = await this.service.findEntityById(id);
    await this.assertCanManage(user, existing.scope, existing.teamId, existing.userId);
    if (body.scope !== undefined && body.scope !== existing.scope) {
      await this.assertCanManage(user, body.scope, body.teamId ?? existing.teamId, existing.userId);
    }
    return this.service.update(id, user.id, body);
  }

  /** Introspects the live schema → base manifest (DB comments + declared FKs). */
  @Post(':id/introspect')
  @HttpCode(HttpStatus.OK)
  async introspect(@Param('id') id: string, @CurrentUser() user: any) {
    const existing = await this.service.findEntityById(id);
    await this.assertCanManage(user, existing.scope, existing.teamId, existing.userId);
    return this.enrichment.introspect(id);
  }

  /** Enriches the manifest with AI (missing comments + inferred relations). */
  @Post(':id/enrich')
  @HttpCode(HttpStatus.OK)
  async enrich(@Param('id') id: string, @Body() body: EnrichBody, @CurrentUser() user: any) {
    const existing = await this.service.findEntityById(id);
    await this.assertCanManage(user, existing.scope, existing.teamId, existing.userId);
    return this.enrichment.enrich(id, body?.llmConfigId);
  }

  /** Saves the manifest manually edited by the user (comments, deny, relations). */
  @Put(':id/manifest')
  async saveManifest(
    @Param('id') id: string,
    @Body() body: SaveManifestBody,
    @CurrentUser() user: any,
  ) {
    const existing = await this.service.findEntityById(id);
    await this.assertCanManage(user, existing.scope, existing.teamId, existing.userId);
    return this.service.saveSchemaManifest(id, body.manifest);
  }

  /**
   * Clears all introspection (empties the curated manifest). The data source
   * returns to "live" mode: SQL tools will read the schema directly from the DB.
   */
  @Delete(':id/manifest')
  async clearManifest(@Param('id') id: string, @CurrentUser() user: any) {
    const existing = await this.service.findEntityById(id);
    await this.assertCanManage(user, existing.scope, existing.teamId, existing.userId);
    return this.service.saveSchemaManifest(id, null);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string, @CurrentUser() user: any) {
    const existing = await this.service.findEntityById(id);
    await this.assertCanManage(user, existing.scope, existing.teamId, existing.userId);
    await this.service.remove(id, user.id);
  }
}
