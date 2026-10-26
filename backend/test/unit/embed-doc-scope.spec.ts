// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * The visibility of an indexed document (universal | project | personal): a re-index replaces the previous chunks (a
 * narrower scope must not leave the wider copy visible), the scope can be changed without re-embedding, and a deleted
 * file takes its chunks with it — in every collection.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EmbedService } from '../../src/embed/embed.service';

type Pt = { payload: Record<string, any> };

/** In-memory vector store with the adapter surface used by EmbedService (equality filters, `except`, payload patch). */
class FakeStore {
  cols = new Map<string, Map<string, Pt>>();
  private matches(p: Pt, filter: Record<string, any>, except?: Record<string, any>) {
    return Object.entries(filter).every(([k, v]) => p.payload[k] === v)
      && !Object.entries(except ?? {}).some(([k, v]) => p.payload[k] === v);
  }
  async listCollections() { return [...this.cols.keys()]; }
  async ensureCollection(n: string) { if (!this.cols.has(n)) this.cols.set(n, new Map()); }
  async upsert(n: string, pts: Array<{ id: string; payload: any }>) {
    for (const p of pts) this.cols.get(n)!.set(p.id, { payload: structuredClone(p.payload) });
  }
  async deleteByFilter(n: string, filter: Record<string, any>, except?: Record<string, any>) {
    const c = this.cols.get(n);
    for (const [id, p] of [...(c?.entries() ?? [])]) if (this.matches(p, filter, except)) c!.delete(id);
  }
  async updatePayloadByFilter(n: string, filter: Record<string, any>, patch: Record<string, any>) {
    for (const p of this.cols.get(n)?.values() ?? []) if (this.matches(p, filter)) Object.assign(p.payload, patch);
  }
  scopes(n: string, fileId = 'f1') {
    return [...(this.cols.get(n)?.values() ?? [])].filter((p) => p.payload.fileId === fileId).map((p) => p.payload.scope);
  }
}

describe('indexed document visibility', () => {
  let store: FakeStore;
  let files: { extractText: any; markVectorized: any; onRemove: any; hooks: Array<(id: string) => Promise<void>> };
  let svc: EmbedService;
  const file = (over: Record<string, any> = {}) => ({
    id: 'f1', originalName: 'contratto.pdf', mimeType: 'application/pdf', projectId: null, vectorCollectionId: null,
    createdAt: new Date('2026-10-01'), ...over,
  }) as any;

  beforeEach(() => {
    store = new FakeStore();
    files = {
      extractText: vi.fn(async () => 'Primo paragrafo del contratto.\n\nSecondo paragrafo del contratto.'),
      markVectorized: vi.fn(async () => undefined),
      hooks: [],
      onRemove: vi.fn((h: (id: string) => Promise<void>) => { files.hooks.push(h); }),
    };
    const embedding = {
      getVectorSize: vi.fn(async () => 2), getChunkSize: vi.fn(async () => 30), getChunkOverlap: vi.fn(async () => 0),
      embedBatch: vi.fn(async (chunks: string[]) => chunks.map(() => [0.1, 0.2])),
    };
    svc = new EmbedService(files as any, embedding as any, {} as any, null, store as any);
    svc.onModuleInit();
  });

  it('a re-index with another scope replaces the previous chunks: none of the wider copy is left', async () => {
    await svc.ingestFile(file(), 'u1', undefined, { scope: 'universal' });
    expect(new Set(store.scopes('default_collection'))).toEqual(new Set(['universal']));
    const n = store.scopes('default_collection').length;
    await svc.ingestFile(file({ vectorCollectionId: 'default_collection' }), 'u1', undefined, { scope: 'personal' });
    expect(store.scopes('default_collection')).toEqual(Array(n).fill('personal'));
    expect(files.markVectorized).toHaveBeenLastCalledWith('f1', 'default_collection', 'personal', null);
  });

  it('a re-index into another collection removes the chunks of the collection it was in', async () => {
    await svc.ingestFile(file(), 'u1', 'contratti', { scope: 'universal' });
    await svc.ingestFile(file({ vectorCollectionId: 'contratti' }), 'u1', 'altra', { scope: 'personal' });
    expect(store.scopes('contratti')).toEqual([]);
    expect(new Set(store.scopes('altra'))).toEqual(new Set(['personal']));
  });

  it('other files keep their chunks', async () => {
    await svc.ingestFile(file({ id: 'f2' }), 'u1', undefined, { scope: 'universal' });
    await svc.ingestFile(file(), 'u1', undefined, { scope: 'personal' });
    await svc.ingestFile(file({ vectorCollectionId: 'default_collection' }), 'u1', undefined, { scope: 'personal' });
    expect(store.scopes('default_collection', 'f2').length).toBeGreaterThan(0);
  });

  it('the scope changes without re-embedding, in every collection', async () => {
    await svc.ingestFile(file(), 'u1', undefined, { scope: 'personal' });
    await store.ensureCollection('altra');
    await store.upsert('altra', [{ id: 'x', payload: { fileId: 'f1', scope: 'personal', projectId: null } }]);
    await svc.setFileScope(file({ vectorCollectionId: 'default_collection' }), 'project', 'p1');
    expect(new Set(store.scopes('default_collection'))).toEqual(new Set(['project']));
    expect(store.scopes('altra')).toEqual(['project']);
    expect(store.cols.get('altra')!.get('x')!.payload.projectId).toBe('p1');
    expect(files.markVectorized).toHaveBeenLastCalledWith('f1', 'default_collection', 'project', 'p1');
    await svc.setFileScope(file({ vectorCollectionId: 'default_collection' }), 'universal', 'p1');
    expect(store.cols.get('altra')!.get('x')!.payload).toMatchObject({ scope: 'universal', projectId: null });
  });

  it('a deleted file takes its chunks with it, in every collection', async () => {
    await svc.ingestFile(file(), 'u1', 'contratti', { scope: 'universal' });
    await svc.ingestFile(file({ id: 'f2' }), 'u1', undefined, { scope: 'universal' });
    expect(files.hooks).toHaveLength(1);
    await files.hooks[0]!('f1');
    expect(store.scopes('contratti')).toEqual([]);
    expect(store.scopes('default_collection', 'f2').length).toBeGreaterThan(0);
  });
});
