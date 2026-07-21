import { Logger } from '@nestjs/common';
import { Pool } from 'pg';
import type { VectorStoreAdapter, VectorPoint, SearchHit } from '../vector-store.types';

/**
 * PGVector adapter for vector store operations.
 *
 * Requires the pgvector extension installed on the target PostgreSQL:
 *   CREATE EXTENSION IF NOT EXISTS vector;
 *
 * Each collection maps to a table with a configurable prefix (default: "vecs_").
 * Vectors are stored in the `embedding` column of type `vector(N)`.
 * Metadata (payload) in the `payload` column of type `jsonb`.
 *
 * Table schema:
 *   CREATE TABLE vecs_{collection} (
 *     id      UUID     PRIMARY KEY,
 *     embedding vector({N}),
 *     payload  JSONB
 *   );
 *
 * Note: uses a separate Pool from the app's main Pool to allow
 * pointing at a different PostgreSQL DB (e.g. a dedicated vector database).
 */
export class PgVectorAdapter implements VectorStoreAdapter {
  private readonly logger = new Logger(PgVectorAdapter.name);
  private readonly pool: Pool;
  private readonly tablePrefix: string;

  constructor(connectionString: string, tablePrefix = 'vecs_') {
    this.pool        = new Pool({ connectionString });
    this.tablePrefix = tablePrefix;
  }

  /** Table names are sanitized: only letters, digits and _. */
  private tableName(collection: string): string {
    const safe = collection.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
    return `${this.tablePrefix}${safe}`;
  }

  /** Serializes the vector into the textual format accepted by pgvector: "[0.1,0.2,...]". */
  private vectorToString(vector: number[]): string {
    return `[${vector.join(',')}]`;
  }

  async ensureCollection(name: string, vectorSize: number): Promise<void> {
    const table = this.tableName(name);

    // Enable the extension (idempotent)
    await this.pool.query('CREATE EXTENSION IF NOT EXISTS vector');

    // Check whether the table exists with the correct dimension
    const { rows } = await this.pool.query<{ atttypmod: number }>(
      `SELECT atttypmod FROM pg_attribute
         JOIN pg_class ON pg_attribute.attrelid = pg_class.oid
         JOIN pg_namespace ON pg_class.relnamespace = pg_namespace.oid
        WHERE pg_namespace.nspname = 'public'
          AND pg_class.relname = $1
          AND pg_attribute.attname = 'embedding'
          AND pg_attribute.attnum > 0`,
      [table],
    );

    if (rows.length > 0) {
      // atttypmod for vector(N) is N + 4 (4 = header size)
      const existingSize = rows[0].atttypmod - 4;
      if (existingSize !== vectorSize) {
        this.logger.warn(`Table "${table}" dim=${existingSize}, expected ${vectorSize}. Recreating.`);
        await this.recreateCollection(name, vectorSize);
      }
      return;
    }

    // Create the table
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS "${table}" (
        id      UUID     PRIMARY KEY,
        embedding vector(${vectorSize}),
        payload  JSONB    NOT NULL DEFAULT '{}'
      )
    `);

    // Index for efficient similarity search. HNSW is preferred over ivfflat:
    // ivfflat builds its centroids from the rows present at index-creation time,
    // so an index created on an empty (or near-empty) table has degenerate lists
    // and silently loses recall — a freshly-indexed collection can return zero
    // hits. HNSW builds incrementally and is accurate from the first row.
    // HNSW requires pgvector >= 0.5.0; fall back to ivfflat on older servers.
    try {
      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS "${table}_vec_idx"
          ON "${table}" USING hnsw (embedding vector_cosine_ops)
      `);
    } catch (err) {
      this.logger.warn(
        `HNSW index unavailable for "${table}" (${(err as Error).message}); falling back to ivfflat.`,
      );
      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS "${table}_vec_idx"
          ON "${table}" USING ivfflat (embedding vector_cosine_ops)
          WITH (lists = 100)
      `).catch(() => {
        // ivfflat needs at least 1 row → ignore; a later insert will allow it.
      });
    }

    this.logger.log(`PGVector table created: "${table}" (dims=${vectorSize})`);
  }

  async recreateCollection(name: string, vectorSize: number): Promise<void> {
    const table = this.tableName(name);
    await this.pool.query(`DROP TABLE IF EXISTS "${table}"`);
    await this.ensureCollection(name, vectorSize);
  }

  async upsert(collection: string, points: VectorPoint[]): Promise<void> {
    const table = this.tableName(collection);

    // Batch upsert with unnest for efficiency
    const ids      = points.map((p) => p.id);
    const vectors  = points.map((p) => this.vectorToString(p.vector));
    const payloads = points.map((p) => JSON.stringify(p.payload));

    for (let i = 0; i < points.length; i++) {
      await this.pool.query(
        `INSERT INTO "${table}" (id, embedding, payload)
         VALUES ($1, $2::vector, $3::jsonb)
         ON CONFLICT (id) DO UPDATE
           SET embedding = $2::vector, payload = $3::jsonb`,
        [ids[i], vectors[i], payloads[i]],
      );
    }
  }

  async search(
    collection: string,
    vector: number[],
    limit: number,
    filter?: Record<string, any>,
  ): Promise<SearchHit[]> {
    const table = this.tableName(collection);
    const vecStr = this.vectorToString(vector);

    let whereClause = '';
    const params: any[] = [vecStr, limit];

    if (filter && Object.keys(filter).length > 0) {
      const conditions = Object.entries(filter).map(([key, value], idx) => {
        params.push(value);
        return `payload->>'${key}' = $${params.length}`;
      });
      whereClause = `WHERE ${conditions.join(' AND ')}`;
    }

    const { rows } = await this.pool.query(
      `SELECT id, payload, 1 - (embedding <=> $1::vector) AS score
         FROM "${table}"
         ${whereClause}
         ORDER BY embedding <=> $1::vector
         LIMIT $2`,
      params,
    );

    return rows.map((r) => ({
      id:      r.id,
      score:   parseFloat(r.score),
      payload: r.payload,
    }));
  }

  async deleteByFilter(collection: string, filter: Record<string, any>): Promise<void> {
    const table = this.tableName(collection);
    const conditions: string[] = [];
    const params: any[] = [];

    Object.entries(filter).forEach(([key, value]) => {
      params.push(value);
      conditions.push(`payload->>'${key}' = $${params.length}`);
    });

    if (conditions.length === 0) return;

    await this.pool.query(
      `DELETE FROM "${table}" WHERE ${conditions.join(' AND ')}`,
      params,
    );
  }

  async listCollections(): Promise<string[]> {
    const { rows } = await this.pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename LIKE $1`,
      [`${this.tablePrefix}%`],
    );
    return rows.map((r) => r.tablename.slice(this.tablePrefix.length));
  }
}
