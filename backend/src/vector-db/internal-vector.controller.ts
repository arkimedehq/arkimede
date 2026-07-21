/**
 * @file internal-vector.controller.ts
 *
 * Internal endpoints for vector store operations (embed + search + ingest).
 * Used by skills via BACKEND_INTERNAL_URL + run token (x-internal-token header).
 *
 * POST /internal/vector/search
 *   Embeds query_text and searches the indicated collection.
 *   Returns the results filtered by score_threshold.
 *
 * POST /internal/vector/ingest
 *   Embeds a list of items ({id, text, payload}) in batch and loads them into Qdrant.
 *   With recreate=true it recreates the collection from scratch (full refresh).
 *
 * Security:
 *   - Protected by InternalTokenGuard
 *   - Not exposed to end users
 */
import {
  BadRequestException, Body, Controller, HttpCode, HttpStatus,
  Logger, Post, ServiceUnavailableException, UseGuards,
} from '@nestjs/common';
import { I18nContext } from 'nestjs-i18n';
import {
  IsArray, IsBoolean, IsNumber, IsObject, IsOptional,
  IsPositive, IsString, Max, Min, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { v4 as uuidv4 } from 'uuid';

import { InternalTokenGuard } from '../common/guards/internal-token.guard';
import { VectorStoreProviderService } from './vector-store-provider.service';
import { EmbeddingProviderService } from '../embed/embedding.provider.service';

// ─── DTO ─────────────────────────────────────────────────────────────────────

class VectorSearchDto {
  @IsString()
  collection: string;

  @IsString()
  query_text: string;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  @Max(200)
  limit?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  score_threshold?: number;
}

class IngestItemDto {
  @IsString()
  id: string;

  @IsString()
  text: string;

  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;
}

class VectorIngestDto {
  @IsString()
  collection: string;

  @IsOptional()
  @IsBoolean()
  recreate?: boolean;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => IngestItemDto)
  items: IngestItemDto[];
}

// ─── Controller ───────────────────────────────────────────────────────────────

const INGEST_BATCH = 50;

@UseGuards(InternalTokenGuard)
@Controller('internal/vector')
export class InternalVectorController {
  private readonly logger = new Logger(InternalVectorController.name);

  constructor(
    private readonly vectorStore:  VectorStoreProviderService,
    private readonly embedService: EmbeddingProviderService,
  ) {}

  /**
   * POST /internal/vector/search
   *
   * Semantic search: embeds query_text and searches the collection.
   *
   * Response:
   *   { results: [{ id, score, payload }], count: number }
   */
  @Post('search')
  @HttpCode(HttpStatus.OK)
  async search(@Body() dto: VectorSearchDto): Promise<{
    results: { id: string | number; score: number; payload: Record<string, unknown> }[];
    count:   number;
  }> {
    this.logger.log(
      `[internal] vector search collection="${dto.collection}" limit=${dto.limit ?? 15}`,
    );

    let vector: number[];
    try {
      vector = await this.embedService.embed(dto.query_text);
    } catch (err: any) {
      throw new ServiceUnavailableException(
        I18nContext.current()?.t('vectordb.embeddingFailed', { args: { message: err.message } }) ?? `Embedding failed: ${err.message}`,
      );
    }

    const threshold = dto.score_threshold ?? 0.0;
    const hits      = await this.vectorStore.search(dto.collection, vector, dto.limit ?? 15);
    const filtered  = hits.filter((h) => h.score >= threshold);

    return {
      results: filtered.map((h) => ({
        id:      h.id,
        score:   h.score,
        payload: (h.payload ?? {}) as Record<string, unknown>,
      })),
      count: filtered.length,
    };
  }

  /**
   * POST /internal/vector/ingest
   *
   * Indexes a list of items into the collection.
   * With recreate=true it recreates the collection (full refresh).
   * Embeddings are generated in batches of INGEST_BATCH items at a time.
   *
   * Response:
   *   { indexed: number, errors: number, collection: string }
   */
  @Post('ingest')
  @HttpCode(HttpStatus.OK)
  async ingest(@Body() dto: VectorIngestDto): Promise<{
    indexed:    number;
    errors:     number;
    collection: string;
  }> {
    if (!dto.items?.length) {
      throw new BadRequestException('vectordb.itemsRequired');
    }

    this.logger.log(
      `[internal] vector ingest collection="${dto.collection}" items=${dto.items.length} recreate=${dto.recreate ?? false}`,
    );

    const vectorSize = await this.embedService.getVectorSize();
    if (!vectorSize) {
      throw new ServiceUnavailableException('vectordb.embeddingNotConfigured');
    }

    if (dto.recreate) {
      await this.vectorStore.recreateCollection(dto.collection, vectorSize);
      this.logger.log(`[internal] collection "${dto.collection}" recreated`);
    } else {
      await this.vectorStore.ensureCollection(dto.collection, vectorSize);
    }

    let indexed = 0;
    let errors  = 0;

    for (let i = 0; i < dto.items.length; i += INGEST_BATCH) {
      const batch = dto.items.slice(i, i + INGEST_BATCH);
      try {
        const vectors = await this.embedService.embedBatch(batch.map((item) => item.text));
        const points  = batch.map((item, j) => ({
          id:      uuidv4(),
          vector:  vectors[j],
          payload: { ...( item.payload ?? {}), _item_id: item.id },
        }));
        await this.vectorStore.upsert(dto.collection, points);
        indexed += batch.length;
      } catch (err: any) {
        this.logger.error(`[internal] ingest batch ${i}–${i + batch.length} error: ${err.message}`);
        errors += batch.length;
      }
    }

    this.logger.log(
      `[internal] ingest completed: ${indexed} indexed, ${errors} errors`,
    );

    return { indexed, errors, collection: dto.collection };
  }
}
