import { Logger } from '@nestjs/common';
import { QdrantClient } from '@qdrant/js-client-rest';
import type { VectorStoreAdapter, VectorPoint, SearchHit } from '../vector-store.types';

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
    try {
      const info = await this.client.getCollection(name);
      const vectors = info.config?.params?.vectors;
      const existingSize =
        typeof vectors === 'object' && !Array.isArray(vectors) && 'size' in vectors
          ? (vectors as any).size
          : undefined;

      if (existingSize !== undefined && existingSize !== vectorSize) {
        this.logger.warn(`Collection "${name}" dim=${existingSize}, expected ${vectorSize}. Recreating.`);
        await this.recreateCollection(name, vectorSize);
      }
    } catch (err) {
      if (err.status !== 404 && !err.message?.includes('Not found')) throw err;
      await this.client.createCollection(name, {
        vectors: { size: vectorSize, distance: 'Cosine' },
      });
      this.logger.log(`Qdrant collection created: "${name}" (dims=${vectorSize})`);
    }
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
}
