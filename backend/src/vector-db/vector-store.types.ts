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

/** Provider-agnostic adapter for vector store operations. */
export interface VectorStoreAdapter {
  /**
   * Ensures the collection exists with the specified vector dimension.
   * Idempotent: if it exists with a different dimension it recreates it.
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
