// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Admin re-embed: every vector recomputed with the active model, no data lost,
 * collections without recoverable text left untouched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ReembedService } from '../../src/vector-db/reembed.service';

type Pt = { vector: number[]; payload: Record<string, any> };

/** In-memory vector store with the adapter surface used by the job. */
class FakeStore {
  cols = new Map<string, { size: number; points: Map<string | number, Pt> }>();
  failFinalUpsertOf: string | null = null;

  add(name: string, size: number, pts: Array<[string | number, Record<string, any>]>) {
    this.cols.set(name, { size, points: new Map(pts.map(([id, payload]) => [id, { vector: Array(size).fill(0.1), payload }])) });
  }
  async listCollections() { return [...this.cols.keys()]; }
  async getCollectionInfo(n: string) {
    const c = this.cols.get(n);
    return c ? { exists: true, vectorSize: c.size, pointsCount: c.points.size } : { exists: false };
  }
  async scroll(n: string, o: { limit: number; offset?: any; withVectors?: boolean }) {
    const all = [...(this.cols.get(n)?.points.entries() ?? [])];
    const start = (o.offset as number) ?? 0;
    const slice = all.slice(start, start + o.limit);
    return {
      points: slice.map(([id, p]) => ({ id, payload: structuredClone(p.payload), ...(o.withVectors ? { vector: p.vector } : {}) })),
      nextOffset: start + o.limit < all.length ? start + o.limit : null,
    };
  }
  async ensureCollection(n: string, size: number) { if (!this.cols.has(n)) this.cols.set(n, { size, points: new Map() }); }
  async recreateCollection(n: string, size: number) { this.cols.set(n, { size, points: new Map() }); }
  async deleteCollection(n: string) { this.cols.delete(n); }
  async search(n: string, v: number[], limit: number) {
    const dot = (a: number[]) => a.reduce((acc, x, i) => acc + x * v[i], 0);
    return [...(this.cols.get(n)?.points.entries() ?? [])]
      .map(([id, p]) => ({ id, score: dot(p.vector), payload: p.payload }))
      .sort((a, b) => b.score - a.score).slice(0, limit);
  }
  async upsert(n: string, pts: Array<{ id: any; vector: number[]; payload: any }>) {
    const c = this.cols.get(n)!;
    for (const p of pts) {
      if (n === this.failFinalUpsertOf && p === pts[0]) continue; // simulate a lost point
      c.points.set(p.id, { vector: p.vector, payload: structuredClone(p.payload) });
    }
  }
}

function makeService(store: FakeStore, notes: any[] = [], feedback: any[] = [], dims = 1024) {
  const embedding = {
    invalidateCache: vi.fn(),
    getVectorSize: vi.fn(async () => dims),
    getIdentity: vi.fn(async () => `internal|bge-m3|${dims}|`),
    embedBatch: vi.fn(async (t: string[]) => t.map(() => Array(dims).fill(0.5))),
    embedBatchQuery: vi.fn(async (t: string[]) => t.map(() => Array(dims).fill(0.7))),
  };
  const repo = (rows: any[]) => ({ find: vi.fn(async () => rows) });
  const uploadDir = mkdtempSync(path.join(tmpdir(), 'reembed-'));
  const config = { get: (k: string, d: any) => (k === 'UPLOAD_DIR' ? uploadDir : d) };
  const svc = new ReembedService(store as any, embedding as any, repo(notes) as any, repo(feedback) as any, config as any);
  return { svc, embedding };
}

async function runToEnd(svc: ReembedService, only?: string[]) {
  await svc.start(only, 'test');
  for (let i = 0; i < 200 && svc.status()?.status === 'running'; i++) await new Promise((r) => setTimeout(r, 5));
  return svc.status()!;
}

describe('ReembedService', () => {
  let store: FakeStore;
  beforeEach(() => { store = new FakeStore(); });

  it('re-embeds a payload-text collection: new dimension, same ids and payloads, blank chunks dropped', async () => {
    store.add('docs', 384, [
      ['a', { text: 'Chapter one', fileId: 'f1' }],
      ['b', { text: 'Chapter two', fileId: 'f1' }],
      ['c', { text: '      ', fileId: 'f2' }],
    ]);
    const { svc, embedding } = makeService(store);
    const report = await runToEnd(svc);

    expect(report.status).toBe('done');
    const col = store.cols.get('docs')!;
    expect(col.size).toBe(1024);
    expect([...col.points.keys()].sort()).toEqual(['a', 'b']);
    expect(col.points.get('a')!.payload).toEqual({ text: 'Chapter one', fileId: 'f1' });
    expect(col.points.get('a')!.vector).toHaveLength(1024);
    expect(store.cols.has('docs__reembed')).toBe(false);
    expect(embedding.embedBatch).toHaveBeenCalled();             // document side
    expect(embedding.embedBatchQuery).not.toHaveBeenCalled();
    const plan = report.collections.find((c) => c.name === 'docs')!;
    expect(plan).toMatchObject({ resolvable: 2, blank: 1, written: 2, status: 'done' });
    // safety export written before any change, with all 3 original points
    const exported = readFileSync(path.join(report.exportDir!, 'docs.jsonl'), 'utf8').trim().split('\n');
    expect(exported).toHaveLength(3);
    expect(existsSync(path.join(report.exportDir!, 'report.json'))).toBe(true);
  });

  it('leaves a collection without recoverable text untouched (needs re-ingest by its owner)', async () => {
    store.add('catalogue', 384, [[1, { name: 'Item A', price: 10 }], [2, { name: 'Item B', price: 20 }]]);
    const { svc } = makeService(store);
    const report = await runToEnd(svc);

    const col = store.cols.get('catalogue')!;
    expect(col.size).toBe(384);
    expect(col.points.size).toBe(2);
    expect(report.collections.find((c) => c.name === 'catalogue')).toMatchObject({ action: 'needs-reingest', missingText: 2 });
  });

  it('re-embeds memory notes from the DB on the query side, regenerating scope, dropping stale points', async () => {
    store.add('user_memory', 384, [
      ['n1', { userId: 'u1', memoryId: 'n1', tags: [], category: null }], // legacy payload without scope
      ['n2', { userId: 'u1', memoryId: 'n2', tags: [], category: null, scope: 'personal', teamId: null }],
    ]);
    const notes = [{ id: 'n1', userId: 'u1', content: 'Vive a Varese', context: null, keywords: [], tags: ['p'], category: 'profile', scope: 'team', teamId: 't1', status: 'confirmed' }];
    const { svc, embedding } = makeService(store, notes);
    const report = await runToEnd(svc);

    const col = store.cols.get('user_memory')!;
    expect([...col.points.keys()]).toEqual(['n1']);              // n2 is no longer a confirmed note
    expect(col.points.get('n1')!.payload).toMatchObject({ scope: 'team', teamId: 't1', memoryId: 'n1' });
    expect(embedding.embedBatchQuery).toHaveBeenCalledWith(['Vive a Varese']);
    expect(report.collections[0]).toMatchObject({ source: 'memory-db', side: 'query', stale: 1, written: 1 });
  });

  it('back-fills confirmed memory notes that never got a vector (DB is the source of truth)', async () => {
    store.add('user_memory', 384, [['n1', { userId: 'u1', memoryId: 'n1', tags: [], category: null, scope: 'personal', teamId: null }]]);
    const note = (id: string, content: string) => ({ id, userId: 'u1', content, context: null, keywords: [], tags: [], category: null, scope: 'personal', teamId: null, status: 'confirmed' });
    const { svc } = makeService(store, [note('n1', 'Parla italiano'), note('n9', 'Usa Home Assistant')]);
    const plan = await svc.plan(['user_memory']);
    expect(plan.collections[0]).toMatchObject({ resolvable: 1, missingFromIndex: 1, action: 'reembed' });
    const report = await runToEnd(svc, ['user_memory']);
    expect(report.status).toBe('done');
    expect([...store.cols.get('user_memory')!.points.keys()].sort()).toEqual(['n1', 'n9']);
    expect(report.collections[0].written).toBe(2);
  });

  it('recreates an empty collection with the new dimension', async () => {
    store.add('feedback_memory', 384, []);
    const { svc } = makeService(store);
    const report = await runToEnd(svc);
    expect(store.cols.get('feedback_memory')!.size).toBe(1024);
    expect(report.collections[0].action).toBe('recreate-empty');
  });

  it('fails loudly when the final verification does not match (and keeps the export)', async () => {
    store.add('docs', 384, [['a', { text: 'uno' }], ['b', { text: 'due' }]]);
    store.failFinalUpsertOf = 'docs';
    const { svc } = makeService(store);
    const report = await runToEnd(svc);
    expect(report.status).toBe('failed');
    expect(report.error).toMatch(/final verification/);
    expect(report.error).toMatch(/preserved in "docs__reembed"/);
    expect(store.cols.get('docs__reembed')!.points.size).toBe(2);   // verified data kept for recovery
    expect(readFileSync(path.join(report.exportDir!, 'docs.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('self-check: each sampled point retrieves itself after a re-embed', async () => {
    store.add('docs', 384, [['a', { text: 'alfa' }], ['b', { text: 'beta' }], ['c', { text: 'gamma' }]]);
    // distinct one-hot vector per text, so self-retrieval is exact
    const slot: Record<string, number> = { alfa: 0, beta: 1, gamma: 2 };
    const onehot = (t: string) => Array(8).fill(0).map((_, k) => (k === slot[t] ? 1 : 0));
    const { svc, embedding } = makeService(store, [], [], 8);
    embedding.embedBatch.mockImplementation(async (t: string[]) => t.map(onehot));
    await runToEnd(svc);
    const res = await svc.selfCheck(10);
    expect(res).toEqual([{ name: 'docs', checked: 3, top1: 3, top3: 3 }]);
  });

  it('refuses a second run while one is in progress', async () => {
    store.add('docs', 384, [['a', { text: 'uno' }]]);
    const { svc } = makeService(store);
    await svc.start(undefined, 'test');
    await expect(svc.start(undefined, 'test')).rejects.toThrow(/already running/);
  });
});
