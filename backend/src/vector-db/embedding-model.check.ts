// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file embedding-model.check.ts
 *
 * Which embedding model produced the stored vectors, and a start-up warning
 * (never blocking) when the active model is a different one. Vectors of two
 * models are not comparable even at the same dimension (e.g. mxbai-embed-large-v1
 * and bge-m3, both 1024): searches silently return wrong neighbours until the
 * admin re-embed job (`POST /api/admin/vector-db/reembed`) rewrites them.
 *
 * Identity = `provider|model|dims` of the active embedding service, recorded in
 * app_config.embeddingIndexedModel:
 *   - by the re-embed job when it completes;
 *   - at start-up when the vector store is empty (fresh install: nothing to compare).
 * NULL with vectors present = unknown (indexed before this was recorded): warned
 * once per start-up, never guessed — recording the active model there could hide
 * exactly the mismatch this check exists for.
 *
 * With the `internal` provider the service may still be starting: the check waits
 * until the running model answers the probe (a fallback name is never compared).
 */
import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { EmbeddingProviderService } from '../embed/embedding.provider.service';
import { VectorStoreProviderService } from './vector-store-provider.service';

const FIRST_DELAY_MS = 15_000;
const RETRY_MS = 30_000;
const MAX_ATTEMPTS = 20;
const CONFIG_ID = 1;

export type EmbeddingCheckOutcome = 'match' | 'mismatch' | 'unknown' | 'recorded-fresh' | 'not-ready' | 'error';

export function embeddingIdentity(active: { provider: string; model: string; vectorSize: number }): string {
  return `${active.provider}|${active.model}|${active.vectorSize}`;
}

export async function readIndexedEmbedding(ds: DataSource): Promise<string | null> {
  const rows: Array<{ embeddingIndexedModel: string | null }> = await ds.query(
    `SELECT "embeddingIndexedModel" FROM "app_config" WHERE "id" = $1`, [CONFIG_ID]);
  return rows[0]?.embeddingIndexedModel ?? null;
}

export async function recordIndexedEmbedding(ds: DataSource, identity: string): Promise<void> {
  await ds.query(`UPDATE "app_config" SET "embeddingIndexedModel" = $1 WHERE "id" = $2`, [identity, CONFIG_ID]);
}

@Injectable()
export class EmbeddingModelCheck implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('EmbeddingModelCheck');
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly embedding: EmbeddingProviderService,
    private readonly vectorStore: VectorStoreProviderService,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.schedule(FIRST_DELAY_MS, 1);
  }

  onModuleDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(delay: number, attempt: number): void {
    this.timer = setTimeout(async () => {
      const outcome = await this.check();
      if (outcome === 'not-ready' && attempt < MAX_ATTEMPTS) this.schedule(RETRY_MS, attempt + 1);
    }, delay);
    this.timer.unref();
  }

  /** One check; never throws. */
  async check(): Promise<EmbeddingCheckOutcome> {
    try {
      const active = await this.embedding.getActive();
      if (!active.confirmed) {
        this.embedding.invalidateCache(); // probe again next time instead of keeping the fallback
        return 'not-ready';
      }
      const current = embeddingIdentity(active);
      const stored = await readIndexedEmbedding(this.ds);
      if (stored === current) return 'match';

      const reembed = 'Run the admin re-embed job (GET /api/admin/vector-db/reembed/plan, then POST /api/admin/vector-db/reembed) '
        + 'or restore the previous embedding model.';
      if (stored) {
        this.logger.warn(
          `Embedding model changed: the stored vectors were produced by "${stored}", the active model is `
          + `"${current}". Searches return wrong results until they are re-embedded. ${reembed}`);
        return 'mismatch';
      }
      if ((await this.storedPoints()) === 0) {
        await recordIndexedEmbedding(this.ds, current);
        this.logger.log(`Embedding model recorded for the (empty) vector store: ${current}`);
        return 'recorded-fresh';
      }
      this.logger.warn(
        `The embedding model of the existing vectors is unknown (indexed before it was recorded); the active `
        + `model is "${current}". If EMBEDDING_MODEL or the embedding provider changed since they were indexed, `
        + `searches return wrong results. ${reembed} The re-embed job records the model, which ends this warning.`);
      return 'unknown';
    } catch (err: any) {
      this.logger.debug(`embedding model check skipped: ${err?.message ?? err}`);
      return 'error';
    }
  }

  private async storedPoints(): Promise<number> {
    let total = 0;
    for (const name of await this.vectorStore.listCollections()) {
      const info = await this.vectorStore.getCollectionInfo(name);
      total += info.pointsCount ?? 0;
      if (total > 0) break;
    }
    return total;
  }
}
