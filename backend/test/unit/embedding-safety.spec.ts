// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Embedding-model change safety: no silent loss of vector data, clean chunks,
 * consistent memory payloads, tool-vector cache bound to the embedding identity.
 */
import { describe, it, expect, vi } from 'vitest';
import { splitIntoChunks, normalizeForChunking } from '../../src/embed/chunking';
import { QdrantAdapter } from '../../src/vector-db/adapters/qdrant.adapter';
import { PgVectorAdapter } from '../../src/vector-db/adapters/pgvector.adapter';
import { VectorSizeMismatchError } from '../../src/vector-db/vector-store.types';
import { memoryIndexText, memoryVectorPayload } from '../../src/user-memory/memory-index';
import { ToolSelectionService } from '../../src/agent/tool-selection.service';

// ── Chunking ────────────────────────────────────────────────────────────────

describe('splitIntoChunks', () => {
  it('drops whitespace-only chunks produced by layout padding', () => {
    const text = 'Item A' + ' '.repeat(2000) + 'Item B';
    const chunks = splitIntoChunks(text, 500, 50);
    expect(chunks).toEqual(['Item A Item B']);
    expect(chunks.every((c) => c.trim().length > 0)).toBe(true);
  });

  it('returns no chunks for blank text', () => {
    expect(splitIntoChunks('   \n\n\t  ', 500, 50)).toEqual([]);
  });

  it('keeps the sliding window semantics on normal text', () => {
    const text = 'x'.repeat(1200);
    const chunks = splitIntoChunks(text, 500, 50);
    expect(chunks.map((c) => c.length)).toEqual([500, 500, 300]);
  });

  it('collapses horizontal whitespace and excessive blank lines, keeping paragraphs', () => {
    expect(normalizeForChunking('a\t\t b  \r\n\r\n\r\n\r\nc   \n d')).toBe('a b\n\nc\nd');
  });
});

// ── ensureCollection: never drop a non-empty collection ─────────────────────

function qdrantWith(size: number, points: number) {
  const adapter = new QdrantAdapter('http://localhost:6333');
  const client = {
    getCollection: vi.fn().mockResolvedValue({ points_count: points, config: { params: { vectors: { size } } } }),
    count: vi.fn().mockResolvedValue({ count: points }),
    deleteCollection: vi.fn().mockResolvedValue(true),
    createCollection: vi.fn().mockResolvedValue(true),
  };
  (adapter as any).client = client;
  return { adapter, client };
}

describe('QdrantAdapter.ensureCollection', () => {
  it('is a no-op when the dimension matches', async () => {
    const { adapter, client } = qdrantWith(1024, 10);
    await adapter.ensureCollection('docs', 1024);
    expect(client.deleteCollection).not.toHaveBeenCalled();
  });

  it('throws VectorSizeMismatchError instead of dropping a non-empty collection', async () => {
    const { adapter, client } = qdrantWith(384, 512);
    await expect(adapter.ensureCollection('docs', 1024)).rejects.toBeInstanceOf(VectorSizeMismatchError);
    expect(client.deleteCollection).not.toHaveBeenCalled();
  });

  it('recreates an empty collection with the new dimension', async () => {
    const { adapter, client } = qdrantWith(1024, 0);
    await adapter.ensureCollection('feedback_memory', 384);
    expect(client.deleteCollection).toHaveBeenCalledWith('feedback_memory');
    expect(client.createCollection).toHaveBeenCalledWith('feedback_memory', { vectors: { size: 384, distance: 'Cosine' } });
  });

  it('creates a missing collection', async () => {
    const { adapter, client } = qdrantWith(0, 0);
    client.getCollection.mockRejectedValue(Object.assign(new Error('Not found'), { status: 404 }));
    await adapter.ensureCollection('new_one', 1024);
    expect(client.createCollection).toHaveBeenCalledWith('new_one', { vectors: { size: 1024, distance: 'Cosine' } });
  });
});

function pgWith(existingSize: number, hasRows: boolean) {
  const adapter = new PgVectorAdapter('postgres://unused');
  let dropped = false; // like a real DB: after DROP TABLE the table no longer exists
  const query = vi.fn(async (sql: string) => {
    if (sql.startsWith('DROP TABLE')) { dropped = true; return { rows: [] }; }
    if (sql.includes('atttypmod')) return { rows: dropped ? [] : [{ atttypmod: existingSize + 4 }] };
    if (sql.startsWith('SELECT 1 FROM')) return { rows: hasRows ? [{ '?column?': 1 }] : [] };
    return { rows: [] };
  });
  (adapter as any).pool = { query };
  return { adapter, query };
}

describe('PgVectorAdapter.ensureCollection', () => {
  it('throws instead of dropping a non-empty table', async () => {
    const { adapter, query } = pgWith(384, true);
    await expect(adapter.ensureCollection('docs', 1024)).rejects.toBeInstanceOf(VectorSizeMismatchError);
    expect(query.mock.calls.some(([sql]) => String(sql).startsWith('DROP TABLE'))).toBe(false);
  });

  it('recreates an empty table', async () => {
    const { adapter, query } = pgWith(1024, false);
    await adapter.ensureCollection('docs', 384);
    expect(query.mock.calls.some(([sql]) => String(sql).startsWith('DROP TABLE'))).toBe(true);
  });
});

// ── Memory vectors: one definition for every writer ─────────────────────────

describe('memory index helpers', () => {
  const note = {
    id: 'n1', userId: 'u1', content: 'Lives in Varese', context: 'When suggesting places',
    keywords: ['Varese', 'casa'], tags: ['profile'], category: 'profile', scope: 'team', teamId: 't1',
  } as any;

  it('builds the embedded text from content, context and keywords', () => {
    expect(memoryIndexText(note)).toBe('Lives in Varese\nWhen suggesting places\nVarese casa');
  });

  it('always carries scope and teamId in the payload (team/org retrieval filters)', () => {
    expect(memoryVectorPayload(note)).toEqual({
      userId: 'u1', memoryId: 'n1', tags: ['profile'], category: 'profile', scope: 'team', teamId: 't1',
    });
    expect(memoryVectorPayload({ ...note, scope: undefined, teamId: undefined, tags: undefined, category: undefined }))
      .toMatchObject({ scope: 'personal', teamId: null, tags: [], category: null });
  });
});

// ── Tool-selection cache bound to the embedding identity ────────────────────

describe('ToolSelectionService tool-vector cache', () => {
  it('drops cached tool vectors when the embedding model changes', async () => {
    let identity = 'internal|e5-small|384|';
    const provider = {
      getIdentity: vi.fn(async () => identity),
      embedBatchQuery: vi.fn(async (texts: string[]) => texts.map(() => [1, 0, 0])),
    };
    const svc: any = Object.create(ToolSelectionService.prototype);
    Object.assign(svc, {
      logger: { log: vi.fn(), debug: vi.fn(), warn: vi.fn() },
      embedCache: new Map<string, number[]>(),
      embedCacheIdentity: null,
      embeddingProvider: provider,
    });
    const tools = [{ name: 'a', description: 'alpha' }, { name: 'b', description: 'beta' }] as any[];
    vi.spyOn(svc, 'buildEmbedText').mockImplementation((t: any) => `${t.name} ${t.description}`);

    const sizes = () => provider.embedBatchQuery.mock.calls.map((c) => c[0].length);

    await svc.selectByRag(tools, 'find alpha', 1).catch(() => undefined);
    expect(svc.embedCache.size).toBe(2);
    await svc.selectByRag(tools, 'find alpha', 1).catch(() => undefined);
    const queryTexts = sizes()[1];                 // cache hit: only query (+ sub-queries)
    expect(sizes()[0]).toBe(queryTexts + 2);       // first call: queries + 2 tools

    identity = 'internal|bge-m3|1024|';
    await svc.selectByRag(tools, 'find alpha', 1).catch(() => undefined);
    expect(sizes()[2]).toBe(queryTexts + 2);       // new model: tools re-embedded
  });
});
