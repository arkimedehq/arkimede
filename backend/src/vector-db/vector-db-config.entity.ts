import { Entity, PrimaryColumn, Column, UpdateDateColumn } from 'typeorm';
import type { VectorDbProvider } from './vector-store.types';

/**
 * Vector database configuration — singleton table (id = 1).
 *
 * Supports multiple providers: Qdrant, PGVector, Chroma, AstraDB.
 * The connection parameters depend on the chosen provider.
 */
@Entity('vector_db_config')
export class VectorDbConfigEntity {
  /** Fixed primary key — always a single row. */
  @PrimaryColumn({ type: 'int' })
  id: number;

  /**
   * Vector DB provider.
   * Default: 'qdrant' for backward compatibility.
   */
  @Column({ type: 'varchar', length: 50, default: 'qdrant' })
  provider: VectorDbProvider;

  /**
   * Main server URL.
   * - Qdrant:  http://localhost:6333
   * - Chroma:  http://localhost:8000
   * - AstraDB: https://{id}-{region}.apps.astra.datastax.com
   * Not used for PGVector (uses connectionString).
   */
  @Column({ type: 'varchar', length: 500, nullable: true })
  url: string | null;

  /**
   * PostgreSQL connection string for PGVector.
   * Format: postgresql://user:pass@host:5432/dbname
   * Not used by the other providers.
   */
  @Column({ type: 'text', nullable: true })
  connectionString: string | null;

  /**
   * Encrypted API key / token (AES-256-CBC).
   * - Qdrant Cloud: API key
   * - AstraDB:      Application Token (AstraCS:...)
   * - Chroma Cloud: API key
   * Format: "<iv_hex>:<ciphertext_hex>"
   */
  @Column({ type: 'text', nullable: true })
  apiKey: string | null;

  /**
   * Provider-specific extra configuration (JSONB).
   * - AstraDB:  { keyspace: "my_keyspace" }
   * - Chroma:   { tenant: "my_tenant", database: "my_db" }
   * - PGVector: { tablePrefix: "vecs_" }
   */
  @Column({ type: 'jsonb', nullable: true })
  extraConfig: Record<string, any> | null;

  @UpdateDateColumn()
  updatedAt: Date;
}
