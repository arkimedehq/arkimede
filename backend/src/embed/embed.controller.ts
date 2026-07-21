import { Controller, Post, Delete, Get, Param, Body, UseGuards, Inject, HttpCode, BadRequestException, ForbiddenException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiBody } from '@nestjs/swagger';
import { IsOptional, IsString, IsIn } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { EmbedService } from './embed.service';
import { EmbedIngestQueueService } from './embed-ingest.queue';
import { FilesService } from '../files/files.service';
import { ProjectsService } from '../projects/projects.service';
import type { DocScope } from '../custom-tools/custom-tool.types';

export class IngestDto {
  @IsOptional()
  @IsString()
  /** Name of the collection to index the file into. If omitted, uses the default collection. */
  collection?: string;

  /** Document scope: universal (company) | project | personal. */
  @IsIn(['universal', 'project', 'personal'])
  scope: DocScope;

  /** Project to bind the document to (required if scope='project'). */
  @IsOptional()
  @IsString()
  projectId?: string;
}

export class IngestDatasourceDto {
  /** Source id ('local' or id of a file-share DataSource SMB/SFTP/WebDAV). */
  @IsString()
  source: string;

  /** File path relative to the source base. */
  @IsString()
  path: string;

  @IsOptional()
  @IsString()
  collection?: string;

  @IsIn(['universal', 'project', 'personal'])
  scope: DocScope;

  @IsOptional()
  @IsString()
  projectId?: string;
}

@ApiTags('embed')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/embed')
export class EmbedController {
  constructor(
    @Inject(EmbedService) private readonly embedService: EmbedService,
    @Inject(EmbedIngestQueueService) private readonly ingestQueue: EmbedIngestQueueService,
    @Inject(FilesService) private readonly filesService: FilesService,
    private readonly projects: ProjectsService,
  ) {}

  @Post('datasource')
  @ApiOperation({
    summary: 'Index into the Vector DB a file living on a DataSource (local or network share)',
    description: 'Queues the indexing (asynchronous) and returns immediately; the user is notified when done. The BE reads the file from the source, extracts its text (PDF/DOCX/XLSX/text/OCR) and indexes it. No upload.',
  })
  @ApiBody({ type: IngestDatasourceDto })
  async ingestDatasource(
    @CurrentUser() user: any,
    @Body() body: IngestDatasourceDto,
  ) {
    let projectId: string | null = null;
    if (body.scope === 'project') {
      projectId = body.projectId ?? null;
      if (!projectId) throw new BadRequestException('embed.projectIdRequired');
      if (!(await this.projects.canWrite(projectId, user.id))) {
        throw new ForbiddenException('embed.projectReadOnly');
      }
    }
    // The scope-check on source access is inside ingestDatasourceFile (worker).
    return this.ingestQueue.enqueue({
      userId: user.id, source: body.source, path: body.path,
      collection: body.collection, scope: body.scope, projectId,
    });
  }

  @Post(':fileId')
  @ApiOperation({ summary: 'Index a file into the Vector DB with a scope (universal|project|personal)' })
  @ApiBody({ type: IngestDto })
  async ingest(
    @Param('fileId') fileId: string,
    @CurrentUser() user: any,
    @Body() body: IngestDto,
  ) {
    // scope='project' requires a project the user has write access to.
    let projectId: string | null = null;
    if (body.scope === 'project') {
      projectId = body.projectId ?? null;
      if (!projectId) throw new BadRequestException('embed.projectIdRequired');
      if (!(await this.projects.canWrite(projectId, user.id))) {
        throw new ForbiddenException('embed.projectReadOnly');
      }
    }
    // The file must be readable by the user (own or from an accessible project).
    const file = await this.filesService.findOneReadable(fileId, user.id);
    return this.embedService.ingestFile(file, user.id, body.collection, { scope: body.scope, projectId });
  }

  @Delete(':fileId')
  @ApiOperation({ summary: 'Remove file vectors from the Vector DB' })
  async remove(@Param('fileId') fileId: string, @CurrentUser() user: any) {
    await this.filesService.findOne(fileId, user.id);
    await this.embedService.deleteFileVectors(fileId);
    return { deleted: true };
  }

  @Get('collections')
  @ApiOperation({ summary: 'List Qdrant collections' })
  listCollections() {
    return this.embedService.listCollections();
  }

  @Delete('collections/:name')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Empty a collection — delete all vectors and recreate it empty',
    description: '⚠️ Irreversible operation. All indexed chunks are deleted.',
  })
  async clearCollection(@Param('name') name: string) {
    await this.embedService.clearCollection(name);
    return { cleared: true, collection: name };
  }
}
