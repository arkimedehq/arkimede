import { Logger } from '@nestjs/common';
import type { VectorStoreAdapter, VectorPoint, SearchHit } from '../vector-store.types';

/**
 * Chroma adapter for vector store operations.
 *
 * Uses the Chroma HTTP API v2 directly via fetch, without additional dependencies.
 * Supports both self-hosted Chroma and Chroma Cloud (with API key).
 *
 * The legacy v1 API was removed in Chroma 1.0 (returns 410 Gone), so every route
 * is scoped under a tenant and a database. Self-hosted Chroma exposes the built-in
 * `default_tenant`/`default_database`; Chroma Cloud passes them explicitly.
 *
 * API documentation: https://docs.trychroma.com/reference/js-client
 *
 * URL structure (COLL = /api/v2/tenants/{tenant}/databases/{database}/collections):
 *   GET  {COLL}               → list collections
 *   POST {COLL}               → create collection
 *   GET  {COLL}/{name}        → collection info (to get ID from name)
 *   POST {COLL}/{id}/upsert   → upsert points
 *   POST {COLL}/{id}/query    → search
 *   POST {COLL}/{id}/delete   → delete by filter
 */
export class ChromaAdapter implements VectorStoreAdapter {
  private readonly logger = new Logger(ChromaAdapter.name);
  private readonly baseUrl: string;
  private readonly collectionsPath: string;
  private readonly headers: Record<string, string>;
  /** Local cache name → Chroma collection ID (IDs are internal UUIDs). */
  private collectionIdCache = new Map<string, string>();

  constructor(url: string, apiKey?: string | null, tenant?: string, database?: string) {
    this.baseUrl = url.replace(/\/$/, '');
    const t = tenant || 'default_tenant';
    const d = database || 'default_database';
    this.collectionsPath = `/api/v2/tenants/${t}/databases/${d}/collections`;
    this.headers = {
      'Content-Type': 'application/json',
      // Chroma Cloud authenticates with a token header; a bearer is also accepted.
      ...(apiKey ? { Authorization: `Bearer ${apiKey}`, 'X-Chroma-Token': apiKey } : {}),
    };
  }

  private async fetch<T>(path: string, options?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: { ...this.headers, ...(options?.headers ?? {}) },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Chroma ${options?.method ?? 'GET'} ${path} → ${res.status}: ${body}`);
    }
    return res.json() as Promise<T>;
  }

  /** Resolves the Chroma ID for a collection name (with cache). */
  private async resolveId(name: string): Promise<string | null> {
    if (this.collectionIdCache.has(name)) return this.collectionIdCache.get(name)!;

    try {
      const col = await this.fetch<{ id: string; name: string }>(`${this.collectionsPath}/${name}`);
      this.collectionIdCache.set(name, col.id);
      return col.id;
    } catch {
      return null;
    }
  }

  async ensureCollection(name: string, vectorSize: number): Promise<void> {
    const existing = await this.resolveId(name);
    if (existing) return;

    const col = await this.fetch<{ id: string; name: string }>(this.collectionsPath, {
      method:  'POST',
      body:    JSON.stringify({
        name,
        metadata: { 'hnsw:space': 'cosine', vectorSize },
      }),
    });

    this.collectionIdCache.set(name, col.id);
    this.logger.log(`Chroma collection created: "${name}" (dims=${vectorSize})`);
  }

  async recreateCollection(name: string, vectorSize: number): Promise<void> {
    const id = await this.resolveId(name);
    if (id) {
      // v2 deletes a collection by NAME (deleting by internal id returns 404).
      await this.fetch(`${this.collectionsPath}/${name}`, { method: 'DELETE' });
      this.collectionIdCache.delete(name);
    }
    await this.ensureCollection(name, vectorSize);
  }

  async upsert(collection: string, points: VectorPoint[]): Promise<void> {
    const id = await this.resolveId(collection);
    if (!id) throw new Error(`Collection Chroma "${collection}" not found`);

    await this.fetch(`${this.collectionsPath}/${id}/upsert`, {
      method: 'POST',
      body:   JSON.stringify({
        ids:        points.map((p) => p.id),
        embeddings: points.map((p) => p.vector),
        metadatas:  points.map((p) => p.payload),
        // Chroma requires a "documents" field (original text); we use the payload's text field
        documents:  points.map((p) => p.payload.text ?? p.id),
      }),
    });
  }

  async search(
    collection: string,
    vector: number[],
    limit: number,
    filter?: Record<string, any>,
  ): Promise<SearchHit[]> {
    const id = await this.resolveId(collection);
    if (!id) return [];

    const body: any = {
      query_embeddings: [vector],
      n_results:        limit,
      include:          ['metadatas', 'distances'],
    };

    // Chroma uses `where` for metadata filters (MongoDB-like syntax)
    if (filter && Object.keys(filter).length > 0) {
      body.where = Object.keys(filter).length === 1
        ? { [Object.keys(filter)[0]]: { $eq: Object.values(filter)[0] } }
        : { $and: Object.entries(filter).map(([k, v]) => ({ [k]: { $eq: v } })) };
    }

    const res = await this.fetch<{
      ids:       string[][];
      distances: number[][];
      metadatas: Record<string, any>[][];
    }>(`${this.collectionsPath}/${id}/query`, { method: 'POST', body: JSON.stringify(body) });

    const ids       = res.ids[0] ?? [];
    const distances = res.distances[0] ?? [];
    const metas     = res.metadatas[0] ?? [];

    return ids.map((pointId, i) => ({
      id:      pointId,
      // Chroma returns cosine distance [0,2]; we convert to score [0,1]
      score:   Math.max(0, 1 - distances[i] / 2),
      payload: metas[i] ?? {},
    }));
  }

  async deleteByFilter(collection: string, filter: Record<string, any>): Promise<void> {
    const id = await this.resolveId(collection);
    if (!id) return;

    const where = Object.keys(filter).length === 1
      ? { [Object.keys(filter)[0]]: { $eq: Object.values(filter)[0] } }
      : { $and: Object.entries(filter).map(([k, v]) => ({ [k]: { $eq: v } })) };

    await this.fetch(`${this.collectionsPath}/${id}/delete`, {
      method: 'POST',
      body:   JSON.stringify({ where }),
    });
  }

  async listCollections(): Promise<string[]> {
    const cols = await this.fetch<{ name: string; id: string }[]>(this.collectionsPath);
    cols.forEach((c) => this.collectionIdCache.set(c.name, c.id));
    return cols.map((c) => c.name);
  }
}
