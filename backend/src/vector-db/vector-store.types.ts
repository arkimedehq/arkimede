// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file vector-store.types.ts
 *
 * Provider-agnostic interface for vector store operations.
 *
 * Each adapter (Qdrant, PGVector, Chroma, AstraDB) implements this interface.
 * VectorStoreProviderService instantiates the correct adapter based on the configuration.
 */

/** Vector point to insert into the vector store. */
export interface VectorPoint {
  /** Unique UUID of the point. */
  id: string;
  /** Numeric embedding vector. */
  vector: number[];
  /** Arbitrary metadata (text, source, fileId, userId, etc.). */
  payload: Record<string, any>;
}

/** Result of a vector search. */
export interface SearchHit {
  id: string;
  /** Similarity score (cosine) in the range [0, 1], or similar depending on the provider. */
  score: number;
  payload: Record<string, any>;
}

/**
 * Thrown when a non-empty collection exists with a vector dimension different from the
 * active embedding model's. Dropping it would silently lose data, so callers get an
 * explicit error; the fix is an explicit re-embed of the collection.
 */
export class VectorSizeMismatchError extends Error {
  constructor(
    readonly collection: string,
    readonly existingSize: number,
    readonly expectedSize: number,
  ) {
    super(
      `Vector collection "${collection}" has dimension ${existingSize} but the active embedding model ` +
      `produces ${expectedSize}. The collection is not empty, so it was not recreated: re-embed it ` +
      `with the current model (admin re-embed) or restore the previous embedding model.`,
    );
    this.name = 'VectorSizeMismatchError';
  }
}

/** Provider-agnostic adapter for vector store operations. */
export interface VectorStoreAdapter {
  /**
   * Ensures the collection exists with the specified vector dimension.
   * Idempotent. If it exists with a different dimension: an EMPTY collection is recreated
   * (nothing to lose); a non-empty one is never dropped implicitly — throws
   * {@link VectorSizeMismatchError}. Re-indexing with a new model must go through an
   * explicit path (`recreateCollection` / the re-embed job).
   */
  ensureCollection(name: string, vectorSize: number): Promise<void>;

  /**
   * Inserts or updates vector points in the collection.
   */
  upsert(collection: string, points: VectorPoint[]): Promise<void>;

  /**
   * Semantic search by vector similarity.
   *
   * @param collection - Collection name
   * @param vector     - Query vector
   * @param limit      - Maximum number of results
   * @param filter     - Optional filter on the payload (key → value)
   */
  search(
    collection: string,
    vector: number[],
    limit: number,
    filter?: Record<string, any>,
  ): Promise<SearchHit[]>;

  /**
   * Deletes the points that match the payload filter.
   *
   * @param collection - Collection name
   * @param filter     - Key → value object (e.g. { fileId: 'uuid' })
   */
  deleteByFilter(collection: string, filter: Record<string, any>): Promise<void>;

  /**
   * Deletes and recreates the collection with the specified dimension.
   * Used for forced recreation when the vector dimension has changed.
   */
  recreateCollection(name: string, vectorSize: number): Promise<void>;

  /**
   * Returns the list of names of the collections existing in the provider.
   */
  listCollections(): Promise<string[]>;

  // ── Maintenance (used by the admin re-embed job) ─────────────────────────────

  /** Dimension and point count of a collection, or `{ exists: false }`. */
  getCollectionInfo(name: string): Promise<CollectionInfo>;

  /**
   * Pages through all points of a collection (stable order). Pass the returned
   * `nextOffset` back until it is null.
   */
  scroll(collection: string, opts: ScrollOptions): Promise<ScrollPage>;

  /** Deletes a collection (no-op if it does not exist). */
  deleteCollection(name: string): Promise<void>;
}

export interface CollectionInfo {
  exists:       boolean;
  vectorSize?:  number;
  pointsCount?: number;
}

export interface ScrollOptions {
  limit:        number;
  /** Opaque cursor returned by the previous page (null/undefined = start). */
  offset?:      string | number | null;
  withVectors?: boolean;
}

export interface ScrolledPoint {
  id:      string | number;
  payload: Record<string, any>;
  vector?: number[];
}

export interface ScrollPage {
  points:     ScrolledPoint[];
  nextOffset: string | number | null;
}

/** Thrown by adapters that do not implement a maintenance operation. */
export class VectorMaintenanceNotSupportedError extends Error {
  constructor(provider: string, operation: string) {
    super(`The "${provider}" vector provider does not support "${operation}" yet (needed by the re-embed job).`);
    this.name = 'VectorMaintenanceNotSupportedError';
  }
}

/** Supported vector DB providers. */
export type VectorDbProvider = 'qdrant' | 'pgvector' | 'chroma' | 'astradb';

/** Runtime configuration to build an adapter. */
export interface VectorStoreConfig {
  provider:         VectorDbProvider;
  /** Main URL (Qdrant URL, Chroma URL, AstraDB endpoint). */
  url:              string | null;
  /** PostgreSQL connection string (PGVector only). */
  connectionString: string | null;
  /** API key / token in cleartext (never stored; it is decrypted before being passed here). */
  apiKey:           string | null;
  /** Extra parameters (AstraDB keyspace, Chroma tenant, PGVector tablePrefix, etc.). */
  extraConfig:      Record<string, any> | null;
}
