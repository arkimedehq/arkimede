/**
 * @file vector-store-provider.service.ts
 *
 * Factory service that creates the vector store adapter based on the DB configuration.
 *
 * Supported providers:
 *   - qdrant  → QdrantAdapter  (self-hosted or cloud with API key)
 *   - pgvector→ PgVectorAdapter(PostgreSQL + pgvector extension)
 *   - chroma  → ChromaAdapter  (self-hosted or cloud with API key)
 *   - astradb → AstraDbAdapter (DataStax AstraDB cloud)
 *
 * Cache: the adapter is recreated only when the configuration changes
 * (explicit invalidation via invalidateCache()).
 */
import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QdrantAdapter }   from './adapters/qdrant.adapter';
import { PgVectorAdapter } from './adapters/pgvector.adapter';
import { ChromaAdapter }   from './adapters/chroma.adapter';
import { AstraDbAdapter }  from './adapters/astradb.adapter';
import type {
  VectorStoreAdapter,
  VectorStoreConfig,
  VectorPoint,
  SearchHit,
} from './vector-store.types';
import { VectorDbService } from './vector-db.service';
import { decrypt } from '../custom-tools/crypto.utils';

@Injectable()
export class VectorStoreProviderService {
  private readonly logger = new Logger(VectorStoreProviderService.name);
  private cachedAdapter: VectorStoreAdapter | null = null;

  constructor(
    @Inject(ConfigService)
    private readonly cfg: ConfigService,

    @Optional() @Inject(VectorDbService)
    private readonly vectorDbService: VectorDbService | null,
  ) {}

  // ── Cache ────────────────────────────────────────────────────────────────────

  /**
   * Invalidates the adapter cache.
   * Call after every vector DB configuration update.
   */
  invalidateCache(): void {
    if (this.cachedAdapter === null) return;
    this.cachedAdapter = null;
    this.logger.log('VectorStoreProvider cache invalidated');
  }

  /**
   * Returns the active adapter, building it lazily if necessary.
   */
  async getAdapter(): Promise<VectorStoreAdapter> {
    if (this.cachedAdapter) return this.cachedAdapter;
    const config = await this.resolveConfig();
    this.cachedAdapter = this.buildAdapter(config);
    this.logger.log(`VectorStore: provider=${config.provider}`);
    return this.cachedAdapter;
  }

  // ── Convenience methods (delegate to the adapter) ─────────────────────────────

  async ensureCollection(name: string, vectorSize: number): Promise<void> {
    return (await this.getAdapter()).ensureCollection(name, vectorSize);
  }

  async upsert(collection: string, points: VectorPoint[]): Promise<void> {
    return (await this.getAdapter()).upsert(collection, points);
  }

  async search(
    collection: string,
    vector: number[],
    limit: number,
    filter?: Record<string, any>,
  ): Promise<SearchHit[]> {
    return (await this.getAdapter()).search(collection, vector, limit, filter);
  }

  async deleteByFilter(collection: string, filter: Record<string, any>): Promise<void> {
    return (await this.getAdapter()).deleteByFilter(collection, filter);
  }

  async recreateCollection(name: string, vectorSize: number): Promise<void> {
    return (await this.getAdapter()).recreateCollection(name, vectorSize);
  }

  async listCollections(): Promise<string[]> {
    return (await this.getAdapter()).listCollections();
  }

  // ── Config resolution ─────────────────────────────────────────────────────

  /** Resolves the configuration from the DB (with fallback to env vars for backward compatibility). */
  private async resolveConfig(): Promise<VectorStoreConfig> {
    if (this.vectorDbService) {
      try {
        const dbConfig = await this.vectorDbService.getConfig();
        let apiKey: string | null = null;
        if (dbConfig.apiKey) {
          try { apiKey = decrypt(dbConfig.apiKey); } catch { /* invalid key */ }
        }
        return {
          provider:         dbConfig.provider,
          url:              dbConfig.url,
          connectionString: dbConfig.connectionString,
          apiKey,
          extraConfig:      dbConfig.extraConfig,
        };
      } catch (err) {
        this.logger.warn(`Unable to read VectorDB config from the DB: ${err.message} — using env vars`);
      }
    }

    // Fallback env vars (backward compatibility)
    return {
      provider:         'qdrant',
      url:              this.cfg.get('QDRANT_URL', 'http://localhost:6333'),
      connectionString: null,
      apiKey:           null,
      extraConfig:      null,
    };
  }

  /** Builds the appropriate adapter based on the configuration. */
  private buildAdapter(config: VectorStoreConfig): VectorStoreAdapter {
    switch (config.provider) {
      case 'qdrant':
        return new QdrantAdapter(
          config.url ?? 'http://localhost:6333',
          config.apiKey,
        );

      case 'pgvector':
        return new PgVectorAdapter(
          config.connectionString ?? config.url ?? '',
          config.extraConfig?.tablePrefix ?? 'vecs_',
        );

      case 'chroma':
        return new ChromaAdapter(
          config.url ?? 'http://localhost:8000',
          config.apiKey,
          config.extraConfig?.tenant,
          config.extraConfig?.database,
        );

      case 'astradb':
        return new AstraDbAdapter(
          config.url ?? '',
          config.apiKey ?? '',
          config.extraConfig?.keyspace ?? 'default_keyspace',
        );

      default:
        this.logger.warn(`Unknown provider "${(config as any).provider}" — fallback to Qdrant`);
        return new QdrantAdapter(
          config.url ?? 'http://localhost:6333',
          config.apiKey,
        );
    }
  }
}
