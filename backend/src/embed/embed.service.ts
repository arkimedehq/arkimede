/**
 * @file embed.service.ts
 *
 * Service responsible for the vector indexing of files uploaded by users.
 *
 * Ingestion pipeline:
 *   File (PDF/text) → text extraction → chunking → embedding → Qdrant upsert → mark "vectorized"
 *
 * The chunks are saved in the configured Qdrant collection (default: "default_collection")
 * with a payload that includes the original text, file metadata and userId.
 * This lets the agent's RAG tool filter by user and run contextualized semantic searches.
 */
import {Inject, Injectable, Logger, Optional} from '@nestjs/common';
import {v4 as uuidv4} from 'uuid';
import {lookup as mimeLookup} from 'mime-types';
import {FilesService} from '../files/files.service';
import {File} from '../files/files.entity';
import {DataSourcesService} from '../datasources/datasources.service';
import type {DocScope} from '../custom-tools/custom-tool.types';
import {EmbeddingProviderService} from './embedding.provider.service';
import {VectorDbService} from '../vector-db/vector-db.service';
import {VectorStoreProviderService} from '../vector-db/vector-store-provider.service';

@Injectable()
export class EmbedService {
  /** Cap on the bytes read into memory for indexing a datasource file. */
  static readonly MAX_INGEST_BYTES = 50 * 1024 * 1024;
  private readonly logger = new Logger(EmbedService.name);

  constructor(
    @Inject(FilesService)               private readonly filesService:     FilesService,
    @Inject(EmbeddingProviderService)   private readonly embeddingProvider: EmbeddingProviderService,
    @Inject(DataSourcesService)         private readonly datasources:       DataSourcesService,
    @Optional() @Inject(VectorDbService) private readonly vectorDbService: VectorDbService | null,
    @Optional() @Inject(VectorStoreProviderService) private readonly vectorStore: VectorStoreProviderService | null,
  ) {}

  /**
   * Ensures the Qdrant collection exists with the correct vector dimension.
   *
   * Idempotent logic:
   * 1. Tries to get the existing collection.
   * 2. If it exists but has a dimension different from the current model → recreates it.
   * 3. If it does not exist (404) → creates it.
   * 4. If it exists with the correct dimension → does nothing.
   *
   * This prevents dimension errors at upsert time when the embedding model
   * (and thus vectorSize) is changed between sessions.
   *
   * @param name - Name of the Qdrant collection
   */
  async ensureCollection(name: string) {
    const vs = this.vectorStore;
    if (!vs) throw new Error('VectorStoreProviderService not available');
    await vs.ensureCollection(name, await this.embeddingProvider.getVectorSize());
  }

  /**
   * Indexes a file into the Qdrant collection.
   *
   * Full flow:
   * 1. Extracts the text from the file (PDF → raw text via FilesService).
   * 2. Splits the text into overlapping chunks.
   * 3. Generates the embeddings for all chunks in batch (efficient).
   * 4. Checks that the vector dimension is consistent with the collection.
   * 5. Loads the vector points into Qdrant with a payload (text + metadata).
   * 6. Updates the file state in the DB ("vectorized" field).
   *
   * The payload saved for each point includes:
   *   - text: text of the chunk (used as context in the RAG)
   *   - source: original name of the file
   *   - fileId: FK for selective deletion (→ deleteFileVectors)
   *   - userId: to filter the results by user
   *   - mimeType, createdAt: additional metadata
   *
   * @param file - File entity to index
   * @param userId - ID of the user owning the file
   * @returns Number of indexed chunks
   */
  async ingestFile(
    file:        File,
    userId:      string,
    collection?: string,
    opts?:       { scope?: DocScope; projectId?: string | null },
  ): Promise<{ chunks: number; collection: string }> {
    // Document scope (universal|project|personal). If not specified it is
    // derived from the file: project if uploaded into a project, otherwise personal.
    const scope: DocScope = opts?.scope ?? (file.projectId ? 'project' : 'personal');
    const docProjectId = scope === 'project' ? (opts?.projectId ?? file.projectId ?? null) : null;

    const collectionName = collection?.trim() || await this.resolveDefaultCollectionName();
    await this.ensureCollection(collectionName);

    // Extracts the raw text from the file (supports PDF, text, etc.)
    const text = await this.filesService.extractText(file);
    if (!text.trim()) return { chunks: 0, collection: collectionName };

    const count = await this.embedTextIntoCollection(text, collectionName, {
      source:    file.originalName,
      fileId:    file.id,
      userId,                 // provenance + filter for scope='personal'
      scope,                  // 'universal' | 'project' | 'personal'
      projectId: docProjectId, // set only for scope='project'
      mimeType:  file.mimeType,
      createdAt: file.createdAt?.toISOString(),
    });

    // Marks the file as indexed in the DB (prevents automatic re-ingest)
    await this.filesService.markVectorized(file.id, collectionName);

    this.logger.log(`File ${file.originalName} indexed: ${count} chunks → collection "${collectionName}"`);
    return { chunks: count, collection: collectionName };
  }

  /**
   * Indexes a file living on a **DataSource** (e.g. an SMB/SFTP/WebDAV network share,
   * or the 'local' source), identified by `(source, path)`. It is the "datasource"
   * version of {@link ingestFile}: a BE capability, reusable from UI/scheduling
   * and — via internal endpoint — from skills. It reads the bytes (with an anti-OOM
   * cap), extracts the text (PDF/DOCX/XLSX/text/OCR) and indexes.
   */
  async ingestDatasourceFile(
    userId:     string,
    source:     string,
    filePath:   string,
    collection?: string,
    opts?:      { scope?: DocScope; projectId?: string | null },
  ): Promise<{ chunks: number; collection: string }> {
    const scope: DocScope = opts?.scope ?? 'personal';
    const docProjectId = scope === 'project' ? (opts?.projectId ?? null) : null;

    const collectionName = collection?.trim() || await this.resolveDefaultCollectionName();
    await this.ensureCollection(collectionName);

    // Byte read (scope check + cap) + text extraction on the BE side.
    const { buffer, filename } = await this.datasources.readFileShareBytes(
      source, userId, filePath, EmbedService.MAX_INGEST_BYTES,
    );
    const mime = (mimeLookup(filename) || 'application/octet-stream') as string;
    const text = await this.filesService.extractTextFromBuffer(buffer, mime, filename);
    if (!text.trim()) return { chunks: 0, collection: collectionName };

    const count = await this.embedTextIntoCollection(text, collectionName, {
      source:         filename,
      datasourceId:   source,
      datasourcePath: filePath,
      userId,
      scope,
      projectId:      docProjectId,
      mimeType:       mime,
      createdAt:      new Date().toISOString(),
    });

    this.logger.log(`Datasource file "${filename}" (source=${source}) indexed: ${count} chunks → collection "${collectionName}"`);
    return { chunks: count, collection: collectionName };
  }

  /**
   * Indexes a file by its ID, retrieving it from the DB first.
   *
   * Convenience for callers (e.g. custom tool RAG index) that only have the fileId
   * and the userId, without having to inject FilesService separately.
   *
   * @param fileId     - UUID of the file to index
   * @param userId     - ID of the owning user (used to find the file + payload)
   * @param collection - Collection to index into (optional: uses default if omitted)
   */
  async ingestFileById(
    fileId:      string,
    userId:      string,
    collection?: string,
    opts?:       { scope?: DocScope; projectId?: string | null },
  ): Promise<{ chunks: number; collection: string }> {
    this.logger.log(
      `[ingestFileById] ENTER — fileId="${fileId}" userId="${userId}" collection="${collection ?? 'default'}" scope="${opts?.scope ?? 'auto'}"`,
    );
    try {
      const file = await this.filesService.findOneReadable(fileId, userId);
      this.logger.log(
        `[ingestFileById] file found — name="${file.originalName}" mimeType="${file.mimeType}" vectorized=${file.vectorized}`,
      );
      const result = await this.ingestFile(file, userId, collection, opts);
      this.logger.log(
        `[ingestFileById] OK — ${result.chunks} chunks → collection="${result.collection}"`,
      );
      return result;
    } catch (err: any) {
      this.logger.error(`[ingestFileById] ERROR — ${err.message}`);
      throw err;
    }
  }

  /**
   * Removes from the collection all the vectors associated with a given file.
   *
   * Used when a user deletes a file: without this cleanup, the orphan chunks
   * would keep appearing in the RAG results.
   *
   * The filter uses the payload "fileId" field set during the ingest,
   * allowing targeted deletion without touching other files.
   *
   * @param fileId - ID of the file to de-index
   */
  async deleteFileVectors(fileId: string) {
    const collectionName = await this.resolveDefaultCollectionName();
    const vs = this.vectorStore;
    if (!vs) { this.logger.warn('VectorStore not available'); return; }
    try {
      await vs.deleteByFilter(collectionName, { fileId });
    } catch (err) {
      this.logger.warn(`Error deleting vectors: ${err.message}`);
    }
  }

  /**
   * Empties a collection by deleting all the vectors and recreating it empty.
   *
   * Uses recreateCollection() which is idempotent: if the collection does not exist
   * it creates it directly. The vector dimension is read from the active embedding
   * provider, guaranteeing compatibility with the current model.
   *
   * ⚠️ Destructive and irreversible operation: all the chunks indexed
   * in the collection are permanently deleted.
   *
   * @param name - Name of the collection to empty
   */
  async clearCollection(name: string): Promise<void> {
    const vs = this.vectorStore;
    if (!vs) throw new Error('VectorStoreProviderService not available');
    await vs.recreateCollection(name, await this.embeddingProvider.getVectorSize());
    this.logger.log(`Collection "${name}" emptied and recreated`);
  }

  /**
   * Returns the collections available for embedding: the union of the ones
   * registered in the DB (admin UI) and the ones physically present in the
   * vector store. Registered collections may not exist physically yet — they
   * are created on the first embed via ensureCollection() — but they must
   * still show up in the picker. Both sources are best-effort.
   */
  async listCollections(): Promise<string[]> {
    const names = new Set<string>();

    if (this.vectorDbService) {
      try {
        for (const col of await this.vectorDbService.listCollections()) names.add(col.name);
      } catch (err) {
        this.logger.warn(`Unable to list registered collections: ${err.message}`);
      }
    }

    if (this.vectorStore) {
      try {
        for (const name of await this.vectorStore.listCollections()) names.add(name);
      } catch (err) {
        this.logger.warn(`Unable to list vector store collections: ${err.message}`);
      }
    }

    return [...names].sort();
  }

  /**
   * Resolves the collection name to use.
   * Priority: 1) default collection in the DB (admin UI), 2) 'default_collection'.
   */
  private async resolveDefaultCollectionName(): Promise<string> {
    if (this.vectorDbService) {
      try {
        const col = await this.vectorDbService.getDefaultCollection();
        if (col) return col.name;
      } catch {
        // fallback
      }
    }
    return 'default_collection';
  }

  /**
   * Splits the text into overlapping chunks of fixed size.
   * The chunkSize and chunkOverlap parameters are read from the embedding config (DB or env).
   *
   * Sliding window algorithm:
   *   step = chunkSize - chunkOverlap
   *   chunk_i = text[i*step : i*step + chunkSize]
   *
   * @param text - Raw text extracted from the file
   * @returns Array of overlapping chunks
   */
  private async chunkText(text: string): Promise<string[]> {
    const chunkSize    = await this.embeddingProvider.getChunkSize();
    const chunkOverlap = await this.embeddingProvider.getChunkOverlap();

    const chunks: string[] = [];
    const step = chunkSize - chunkOverlap;
    for (let i = 0; i < text.length; i += step) {
      chunks.push(text.slice(i, i + chunkSize));
      if (i + chunkSize >= text.length) break;
    }
    return chunks;
  }

  /**
   * Chunk → embedding (batch) → upsert into the vector store, with the vector-dimension
   * consistency check. The per-chunk `payload` always includes the `text`; the
   * provenance metadata is passed by the caller. Returns the number of indexed chunks.
   */
  private async embedTextIntoCollection(
    text:           string,
    collectionName: string,
    payload:        Record<string, unknown>,
  ): Promise<number> {
    const chunks  = await this.chunkText(text);
    const vectors = await this.embeddingProvider.embedBatch(chunks);

    // Sanity check: the vector dimension must match the collection's.
    // It could diverge if the embedding model was changed after the collection was created.
    const actualDim = vectors[0]?.length;
    this.logger.log(`Vectors received: ${vectors.length} x dim=${actualDim} (expected: ${this.embeddingProvider.vectorSize})`);

    if (actualDim !== this.embeddingProvider.vectorSize) {
      throw new Error(
        `Vector dimension mismatch: model returns ${actualDim} dims, ` +
        `collection created with ${this.embeddingProvider.vectorSize}. ` +
        `Update EMBEDDING_VECTOR_SIZE=${actualDim} in .env`,
      );
    }

    const vs = this.vectorStore;
    if (!vs) throw new Error('VectorStoreProviderService not available');

    const points = chunks.map((chunk, i) => ({
      id:      uuidv4(),
      vector:  vectors[i],
      payload: { text: chunk, ...payload },
    }));
    await vs.upsert(collectionName, points);
    return chunks.length;
  }
}
