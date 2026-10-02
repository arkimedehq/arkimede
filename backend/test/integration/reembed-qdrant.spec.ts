// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Re-embed job against a REAL Qdrant (pagination, UUID and numeric ids, swap, cleanup).
 * Runs only when QDRANT_TEST_URL points to a disposable instance, e.g.
 *   docker run -d --rm -p 6399:6333 qdrant/qdrant && QDRANT_TEST_URL=http://localhost:6399 npm run test:int
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { QdrantAdapter } from '../../src/vector-db/adapters/qdrant.adapter';
import { ReembedService } from '../../src/vector-db/reembed.service';

const URL = process.env.QDRANT_TEST_URL;

describe.skipIf(!URL)('ReembedService on a real Qdrant', () => {
  it('re-embeds across pages, drops blank chunks, leaves text-less collections untouched', async () => {
    const q = new QdrantAdapter(URL!);
    for (const n of ['docs', 'catalogue', 'docs__reembed']) await q.deleteCollection(n);
    const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    await q.ensureCollection('docs', 384);
    const pts = Array.from({ length: 300 }, (_, i) => ({
      id: uuid(i), vector: Array(384).fill(0.01 * ((i % 7) + 1)),
      payload: { text: i === 5 ? '   ' : `chunk ${i}`, fileId: `f${i % 3}` },
    }));
    for (let i = 0; i < pts.length; i += 100) await q.upsert('docs', pts.slice(i, i + 100));
    await q.ensureCollection('catalogue', 384);
    await q.upsert('catalogue', [{ id: 42 as any, vector: Array(384).fill(0.2), payload: { name: 'Item A' } }]);

    const embedding = {
      invalidateCache: vi.fn(), getVectorSize: async () => 1024, getIdentity: async () => 'test|model|1024|',
      embedBatch: async (t: string[]) => t.map((_, i) => Array(1024).fill(0).map((__, k) => (k === i % 1024 ? 1 : 0))),
      embedBatchQuery: async (t: string[]) => t.map(() => Array(1024).fill(0.03)),
    };
    const dir = mkdtempSync(path.join(tmpdir(), 'reembed-int-'));
    const svc = new ReembedService(q as any, embedding as any, { find: async () => [] } as any,
      { find: async () => [] } as any, { get: (k: string, d: any) => (k === 'UPLOAD_DIR' ? dir : d) } as any);
    await svc.start(['docs', 'catalogue'], 'int');
    for (let i = 0; i < 400 && svc.status()?.status === 'running'; i++) await new Promise((r) => setTimeout(r, 50));

    expect(svc.status()).toMatchObject({ status: 'done' });
    expect(await q.getCollectionInfo('docs')).toEqual({ exists: true, vectorSize: 1024, pointsCount: 299 });
    expect(await q.getCollectionInfo('catalogue')).toEqual({ exists: true, vectorSize: 384, pointsCount: 1 });
    expect((await q.getCollectionInfo('docs__reembed')).exists).toBe(false);
    const page = await q.scroll('docs', { limit: 3, withVectors: true });
    expect(page.points[0].vector).toHaveLength(1024);
    expect(page.points[0].payload.text).toMatch(/^chunk /);
  }, 60000);
});
