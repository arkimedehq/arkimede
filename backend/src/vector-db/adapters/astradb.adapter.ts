import { Logger } from '@nestjs/common';
import type { VectorStoreAdapter, VectorPoint, SearchHit } from '../vector-store.types';

/**
 * AstraDB adapter for vector store operations.
 *
 * Uses the DataStax AstraDB Data API via fetch (no additional dependency).
 * Supports vector search through the special "$vector" field.
 *
 * API documentation: https://docs.datastax.com/en/astra/astra-db-vector/api-reference/data-api.html
 *
 * URL structure:
 *   Base: https://{database-id}-{region}.apps.astra.datastax.com/api/json/v1/{keyspace}
 *   Collection: /{collection}
 *
 * The token is the AstraDB "Application Token" (starts with "AstraCS:").
 *
 * Notes on AstraDB documents:
 *   - Payloads are top-level fields of the document (not nested).
 *   - The vector is in the special "$vector" field.
 *   - The ID is in the "_id" field.
 */
export class AstraDbAdapter implements VectorStoreAdapter {
  private readonly logger = new Logger(AstraDbAdapter.name);
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(endpoint: string, token: string, keyspace = 'default_keyspace') {
    // Format: https://{id}-{region}.apps.astra.datastax.com/api/json/v1/{keyspace}
    this.baseUrl = `${endpoint.replace(/\/$/, '')}/api/json/v1/${keyspace}`;
    this.headers = {
      'Content-Type': 'application/json',
      'x-cassandra-token': token,
      'Token': token,
    };
  }

  private async command(collection: string | null, body: Record<string, any>): Promise<any> {
    const url = collection ? `${this.baseUrl}/${collection}` : this.baseUrl;
    const res = await fetch(url, {
      method:  'POST',
      headers: this.headers,
      body:    JSON.stringify(body),
    });
    const json = await res.json() as any;

    // AstraDB returns errors as { errors: [...] } with status 200 (?!)
    if (json?.errors?.length) {
      throw new Error(`AstraDB error: ${JSON.stringify(json.errors[0])}`);
    }
    return json;
  }

  async ensureCollection(name: string, vectorSize: number): Promise<void> {
    // Check whether the collection already exists
    const listRes = await this.command(null, {
      findCollections: { options: { explain: true } },
    });

    const existing = listRes?.status?.collections as any[];
    const found = existing?.find((c: any) => c.name === name || c === name);

    if (found) {
      // Verify the dimension if available
      const existingDim = found?.options?.vector?.dimension;
      if (existingDim && existingDim !== vectorSize) {
        this.logger.warn(`AstraDB collection "${name}" dim=${existingDim}, expected ${vectorSize}. Recreating.`);
        await this.recreateCollection(name, vectorSize);
      }
      return;
    }

    await this.command(null, {
      createCollection: {
        name,
        options: {
          vector: { dimension: vectorSize, metric: 'cosine' },
        },
      },
    });

    this.logger.log(`AstraDB collection created: "${name}" (dims=${vectorSize})`);
  }

  async recreateCollection(name: string, vectorSize: number): Promise<void> {
    await this.command(null, { deleteCollection: { name } }).catch(() => {});
    await this.ensureCollection(name, vectorSize);
  }

  async upsert(collection: string, points: VectorPoint[]): Promise<void> {
    // AstraDB has a limit of 20 documents per insertMany call
    const BATCH_SIZE = 20;
    for (let i = 0; i < points.length; i += BATCH_SIZE) {
      const batch = points.slice(i, i + BATCH_SIZE);
      await this.command(collection, {
        insertMany: {
          documents: batch.map((p) => ({
            _id:     p.id,
            $vector: p.vector,
            ...p.payload,  // Payloads are top-level fields in AstraDB
          })),
          options: { ordered: false },
        },
      });
    }
  }

  async search(
    collection: string,
    vector: number[],
    limit: number,
    filter?: Record<string, any>,
  ): Promise<SearchHit[]> {
    const res = await this.command(collection, {
      find: {
        filter: filter ?? {},
        sort:    { $vector: vector },
        options: { limit, includeSimilarity: true },
        projection: { $vector: 0 }, // Exclude the vector from the response
      },
    });

    const docs = res?.data?.documents ?? [];
    return docs.map((doc: any) => {
      const { _id, $similarity, $vector: _v, ...payload } = doc;
      return {
        id:      _id,
        score:   $similarity ?? 0,
        payload,
      };
    });
  }

  async deleteByFilter(collection: string, filter: Record<string, any>): Promise<void> {
    // AstraDB uses MongoDB-like filter syntax
    const astraFilter: Record<string, any> = {};
    Object.entries(filter).forEach(([k, v]) => {
      astraFilter[k] = { $eq: v };
    });

    await this.command(collection, {
      deleteMany: { filter: astraFilter },
    });
  }

  async listCollections(): Promise<string[]> {
    const res = await this.command(null, { findCollections: {} });
    const cols = res?.status?.collections ?? [];
    return Array.isArray(cols) ? cols.map((c: any) => (typeof c === 'string' ? c : c.name)) : [];
  }
}
