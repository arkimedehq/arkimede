import {
  Body, Controller, ForbiddenException, HttpCode, HttpStatus, Post, Req, UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { InternalTokenGuard, internalUserId } from '../common/guards/internal-token.guard';
import { EmbedIngestQueueService, EnqueueResult } from './embed-ingest.queue';

class InternalIngestDatasourceDto {
  @IsString()
  source: string;

  @IsString()
  path: string;

  @IsOptional()
  @IsString()
  collection?: string;
}

/**
 * Internal indexing API (service-to-service, x-internal-token header).
 *
 * Exposes to the `files` skill (mode=embed) the SAME BE capability also used by
 * `POST /api/embed/datasource`: indexing a file of a DataSource. The skill does not
 * read/extract anything — it only provides `(source, path)`; the whole pipeline (read,
 * PDF/DOCX/XLSX/OCR text extraction, chunking, embedding, upsert) belongs to the backend.
 *
 * The indexing is QUEUED (asynchronous): it returns immediately, the user is notified
 * when done. The identity is the run's one (signed token → request.internalAuth.sub);
 * the scope check on source access is applied inside the service/worker.
 */
@ApiTags('internal')
@UseGuards(InternalTokenGuard)
@Controller('internal/embed')
export class InternalEmbedController {
  constructor(private readonly ingestQueue: EmbedIngestQueueService) {}

  @Post('datasource')
  @HttpCode(HttpStatus.OK)
  async ingestDatasource(
    @Body() dto: InternalIngestDatasourceDto,
    @Req() req: { internalAuth?: { sub?: string } },
  ): Promise<EnqueueResult> {
    const userId = internalUserId(req);
    if (!userId) {
      throw new ForbiddenException('Run without identity: indexing denied.');
    }
    return this.ingestQueue.enqueue({
      userId, source: dto.source, path: dto.path, collection: dto.collection, scope: 'personal',
    });
  }
}
