// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * AI schema enrichment — resilience to unusable LLM output
 * (`datasources/schema-enrichment.service.ts`).
 *
 * Invariants:
 *   - A model that answers correctly is called exactly once per batch (no extra calls).
 *   - Unusable output (empty, truncated at the token limit, invalid JSON — typical of
 *     reasoning models) splits the batch down to single tables, and a single table is
 *     retried once with the larger-budget model.
 *   - Provider/API errors (auth, quota, network) are NOT retried.
 *   - Relation inference falls back to chunked calls when the whole-schema call fails.
 */
import { describe, it, expect } from 'vitest';
import { SchemaEnrichmentService } from '../../src/datasources/schema-enrichment.service';
import { SchemaManifest, SchemaManifestTable } from '../../src/datasources/schema-manifest.types';

type Reply = { content: string; response_metadata?: Record<string, unknown> } | Error;

/** Fake chat model: `reply` decides the answer from the prompt text; calls are recorded. */
function fakeModel(reply: (prompt: string) => Reply) {
  const calls: string[] = [];
  return {
    calls,
    model: {
      invoke: async (messages: any[]) => {
        const prompt = String(messages[0].content);
        calls.push(prompt);
        const r = reply(prompt);
        if (r instanceof Error) throw r;
        return r;
      },
    } as any,
  };
}

function table(name: string, cols = 3): SchemaManifestTable {
  return {
    name, comment: '', deny: false,
    columns: Array.from({ length: cols }, (_, i) => ({ name: `${name}_id${i}`, type: 'int', comment: '' })),
  };
}

function manifest(tables: SchemaManifestTable[]): SchemaManifest {
  return { generatedAt: '', dialect: 'mysql', relations: [], tables };
}

/** Tables named in a comment prompt (from its JSON input). */
function tablesIn(prompt: string): string[] {
  // Skip the placeholder of the "Response format" example in the prompt.
  return [...prompt.matchAll(/"table": "([^"]+)"/g)].map((m) => m[1]).filter((t) => t !== 'table_name');
}

/** Valid comment JSON for the tables named in the prompt. */
function commentsFor(prompt: string): Reply {
  return {
    content: JSON.stringify(tablesIn(prompt).map((t) => ({ table: t, tableComment: `about ${t}`, columns: [] }))),
    response_metadata: { finish_reason: 'stop' },
  };
}

const TRUNCATED_EMPTY: Reply = { content: '', response_metadata: { finish_reason: 'length' } };

const svc = new SchemaEnrichmentService({} as any, {} as any) as any;

describe('schema enrichment — comment batches', () => {
  it('a working model is called once per batch (no regression)', async () => {
    const base = fakeModel(commentsFor);
    const large = fakeModel(commentsFor);
    const m = manifest([table('a'), table('b'), table('c')]);
    const res = await svc.fillComments({ base: base.model, large: async () => large.model }, m, 'test');
    expect(res.errors).toEqual([]);
    expect(base.calls).toHaveLength(1);
    expect(large.calls).toHaveLength(0);
    expect(m.tables.every((t) => t.comment.startsWith('about '))).toBe(true);
  });

  it('empty output at the token limit splits the batch down to single tables', async () => {
    // Multi-table prompts exhaust the budget; single-table prompts fit.
    const base = fakeModel((p) => (tablesIn(p).length > 1 ? TRUNCATED_EMPTY : commentsFor(p)));
    const large = fakeModel(commentsFor);
    const m = manifest([table('a'), table('b'), table('c'), table('d'), table('e')]);
    const res = await svc.fillComments({ base: base.model, large: async () => large.model }, m, 'test');
    expect(res.errors).toEqual([]);
    expect(m.tables.every((t) => t.comment === `about ${t.name}`)).toBe(true);
    expect(large.calls).toHaveLength(0);
  });

  it('a single table still truncated is retried once with the larger budget', async () => {
    const base = fakeModel(() => ({ content: '[{"table": "a", "tableCom', response_metadata: { finish_reason: 'length' } }));
    const large = fakeModel(commentsFor);
    const m = manifest([table('a')]);
    const res = await svc.fillComments({ base: base.model, large: async () => large.model }, m, 'test');
    expect(res.errors).toEqual([]);
    expect(base.calls).toHaveLength(1);
    expect(large.calls).toHaveLength(1);
    expect(m.tables[0].comment).toBe('about a');
  });

  it('invalid JSON without a finish reason is also treated as unusable output', async () => {
    const base = fakeModel((p) => (tablesIn(p).length > 1 ? { content: '[{"table": "a",}]' } : commentsFor(p)));
    const m = manifest([table('a'), table('b')]);
    const res = await svc.fillComments({ base: base.model, large: async () => base.model }, m, 'test');
    expect(res.errors).toEqual([]);
    expect(m.tables.map((t) => t.comment)).toEqual(['about a', 'about b']);
  });

  it('provider errors are reported without retries', async () => {
    const base = fakeModel(() => new Error('402 Insufficient Balance'));
    const large = fakeModel(commentsFor);
    const m = manifest([table('a'), table('b'), table('c')]);
    const res = await svc.fillComments({ base: base.model, large: async () => large.model }, m, 'test');
    expect(base.calls).toHaveLength(1);
    expect(large.calls).toHaveLength(0);
    expect(res.errors).toEqual(['402 Insufficient Balance']);
  });

  it('an empty answer reports a readable error once retries are exhausted', async () => {
    const base = fakeModel(() => TRUNCATED_EMPTY);
    const m = manifest([table('a')]);
    const res = await svc.fillComments({ base: base.model, large: async () => base.model }, m, 'test');
    expect(res.filled).toBe(0);
    expect(res.errors[0]).toMatch(/output-token limit was reached before any text/);
  });
});

describe('schema enrichment — relation inference', () => {
  const tables = Array.from({ length: 20 }, (_, i) => table(`t${i}`));

  it('falls back to chunked calls when the whole-schema output is unusable', async () => {
    const model = fakeModel((p) => {
      if (!p.includes('Possible target tables')) return TRUNCATED_EMPTY;   // whole-schema call
      const sources = [...p.matchAll(/"table": "(t\d+)"/g)].map((m) => m[1]);
      return { content: JSON.stringify(sources.map((s) => ({ from: `${s}.${s}_id1`, to: 't0.t0_id0' }))) };
    });
    const m = manifest(tables.map((t) => ({ ...t, columns: t.columns.map((c) => ({ ...c })) })));
    const res = await svc.inferRelations(model.model, m, 'test');
    expect(model.calls).toHaveLength(1 + Math.ceil(20 / 15));
    expect(res.added).toBe(20);
    expect(res.error).toBeUndefined();
  });

  it('a working model makes a single call (no regression)', async () => {
    const model = fakeModel(() => ({ content: '[{"from": "t1.t1_id1", "to": "t0.t0_id0"}]' }));
    const m = manifest(tables.map((t) => ({ ...t })));
    const res = await svc.inferRelations(model.model, m, 'test');
    expect(model.calls).toHaveLength(1);
    expect(res.added).toBe(1);
  });

  it('provider errors are not retried in chunks', async () => {
    const model = fakeModel(() => new Error('401 Unauthorized'));
    const m = manifest(tables.map((t) => ({ ...t })));
    const res = await svc.inferRelations(model.model, m, 'test');
    expect(model.calls).toHaveLength(1);
    expect(res).toEqual({ added: 0, error: '401 Unauthorized' });
  });
});
