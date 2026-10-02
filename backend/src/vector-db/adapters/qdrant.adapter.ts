// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { Logger } from '@nestjs/common';
import { QdrantClient } from '@qdrant/js-client-rest';
import { VectorSizeMismatchError } from '../vector-store.types';
import type {
  VectorStoreAdapter, VectorPoint, SearchHit, CollectionInfo, ScrollOptions, ScrollPage,
} from '../vector-store.types';

/**
 * Qdrant adapter for vector store operations.
 *
 * Supports both self-hosted Qdrant and Qdrant Cloud (with API key).
 * Uses the REST client `@qdrant/js-client-rest`.
 */
export class QdrantAdapter implements VectorStoreAdapter {
  private readonly logger = new Logger(QdrantAdapter.name);
  private readonly client: QdrantClient;

  constructor(url: string, apiKey?: string | null) {
    this.client = new QdrantClient({
      url,
      ...(apiKey ? { apiKey } : {}),
    });
  }

  async ensureCollection(name: string, vectorSize: number): Promise<void> {
    let info: Awaited<ReturnType<QdrantClient['getCollection']>>;
    try {
      info = await this.client.getCollection(name);
    } catch (err) {
      if (err.status !== 404 && !err.message?.includes('Not found')) throw err;
      await this.client.createCollection(name, {
        vectors: { size: vectorSize, distance: 'Cosine' },
      });
      this.logger.log(`Qdrant collection created: "${name}" (dims=${vectorSize})`);
      return;
    }

    const vectors = info.config?.params?.vectors;
    const existingSize =
      typeof vectors === 'object' && !Array.isArray(vectors) && 'size' in vectors
        ? (vectors as any).size
        : undefined;
    if (existingSize === undefined || existingSize === vectorSize) return;

    // Different dimension: recreate only when there is nothing to lose.
    const points = info.points_count ?? (await this.client.count(name, { exact: true })).count;
    if (points > 0) throw new VectorSizeMismatchError(name, existingSize, vectorSize);
    this.logger.warn(`Empty collection "${name}" dim=${existingSize}, expected ${vectorSize}. Recreating.`);
    await this.recreateCollection(name, vectorSize);
  }

  async recreateCollection(name: string, vectorSize: number): Promise<void> {
    await this.client.deleteCollection(name);
    await this.client.createCollection(name, {
      vectors: { size: vectorSize, distance: 'Cosine' },
    });
    this.logger.log(`Qdrant collection recreated: "${name}" (dims=${vectorSize})`);
  }

  async upsert(collection: string, points: VectorPoint[]): Promise<void> {
    await this.client.upsert(collection, {
      points: points.map((p) => ({
        id:      p.id,
        vector:  p.vector,
        payload: p.payload,
      })),
    });
  }

  async search(
    collection: string,
    vector: number[],
    limit: number,
    filter?: Record<string, any>,
  ): Promise<SearchHit[]> {
    const qdrantFilter = filter
      ? {
          must: Object.entries(filter).map(([key, value]) => ({
            key,
            match: { value },
          })),
        }
      : undefined;

    const results = await this.client.search(collection, {
      vector,
      limit,
      with_payload: true,
      ...(qdrantFilter ? { filter: qdrantFilter } : {}),
    });

    return results.map((r) => ({
      id:      String(r.id),
      score:   r.score,
      payload: (r.payload ?? {}) as Record<string, any>,
    }));
  }

  async deleteByFilter(collection: string, filter: Record<string, any>): Promise<void> {
    await this.client.delete(collection, {
      filter: {
        must: Object.entries(filter).map(([key, value]) => ({
          key,
          match: { value },
        })),
      },
    });
  }

  async listCollections(): Promise<string[]> {
    const res = await this.client.getCollections();
    return res.collections.map((c) => c.name);
  }

  async getCollectionInfo(name: string): Promise<CollectionInfo> {
    try {
      const info = await this.client.getCollection(name);
      const vectors = info.config?.params?.vectors as any;
      return {
        exists: true,
        vectorSize: typeof vectors?.size === 'number' ? vectors.size : undefined,
        pointsCount: info.points_count ?? (await this.client.count(name, { exact: true })).count,
      };
    } catch (err) {
      if (err.status === 404 || err.message?.includes('Not found')) return { exists: false };
      throw err;
    }
  }

  async scroll(collection: string, opts: ScrollOptions): Promise<ScrollPage> {
    const res = await this.client.scroll(collection, {
      limit: opts.limit,
      ...(opts.offset !== null && opts.offset !== undefined ? { offset: opts.offset } : {}),
      with_payload: true,
      with_vector: !!opts.withVectors,
    });
    return {
      points: res.points.map((p) => ({
        id: p.id,
        payload: (p.payload ?? {}) as Record<string, any>,
        ...(opts.withVectors && Array.isArray(p.vector) ? { vector: p.vector as number[] } : {}),
      })),
      nextOffset: (res.next_page_offset as string | number | null | undefined) ?? null,
    };
  }

  async deleteCollection(name: string): Promise<void> {
    const { exists } = await this.getCollectionInfo(name);
    if (exists) await this.client.deleteCollection(name);
  }
}
