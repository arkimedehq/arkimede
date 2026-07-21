/**
 * Per-scope RAG isolation — `buildDynamicTool` (executor 'rag') filters vector
 * queries by scope and assigns the scope to indexed documents:
 *   - search 'auto'      → 3 queries {universal} ∪ {personal,userId} ∪ {project,projectId}, union+rerank
 *   - search 'universal' → 1 query {scope:universal}
 *   - search 'all'       → 1 query with no filter
 *   - index              → scope derived from context (project/personal) or override
 * Migrated from scripts/smoke-rag-scope.ts. Pure logic: mocked RagContext, no DB.
 */
import { describe, it, expect } from 'vitest';
import { buildDynamicTool } from '../../src/custom-tools/custom-tool.factory';

function makeCtx() {
  const searchCalls: { filter?: any }[] = [];
  let ingestOpts: any;
  let upserted: any[] = [];
  const ctx: any = {
    embed: async () => [0.1, 0.2, 0.3],
    embedDoc: async () => [0.1, 0.2, 0.3],
    chunkText: async (t: string) => [t],
    ensureCollection: async () => {},
    upsert: async (_c: string, points: any[]) => { upserted = points; },
    ingestFile: async (_id: string, _u: string, col: string, opts: any) => { ingestOpts = opts; return { chunks: 1, collection: col }; },
    search: async (_c: string, _v: number[], limit: number, filter?: any) => {
      searchCalls.push({ filter });
      const scope = filter?.scope ?? 'any';
      return [{ id: `${scope}-1`, score: scope === 'project' ? 0.9 : scope === 'personal' ? 0.8 : 0.7, payload: { text: `doc-${scope}`, source: scope } }].slice(0, limit);
    },
  };
  return { ctx, get searchCalls() { return searchCalls; }, get ingestOpts() { return ingestOpts; }, get upserted() { return upserted; } };
}

const mkTool = (cfg: any, userId?: string, projectId?: string, ctx?: any) =>
  buildDynamicTool(
    { name: 'rag_t', description: 'd', parameters: [], executorType: 'rag', executorConfig: cfg } as any,
    {}, undefined, ctx, userId, undefined, projectId,
  );

describe('RAG search — filtro nativo per-scope', () => {
  it('auto: 3 query con i filtri universal/personal/project, rerank project>personal>universal', async () => {
    const m = makeCtx();
    const t = mkTool({ mode: 'search', collection: 'c', searchScope: 'auto' }, 'U1', 'P1', m.ctx);
    const out: string = await (t as any).func({ query: 'q' });
    const filters = m.searchCalls.map((c) => JSON.stringify(c.filter));
    expect(m.searchCalls).toHaveLength(3);
    expect(filters).toContain('{"scope":"universal"}');
    expect(filters).toContain('{"scope":"personal","userId":"U1"}');
    expect(filters).toContain('{"scope":"project","projectId":"P1"}');
    expect(out.indexOf('doc-project')).toBeLessThan(out.indexOf('doc-personal'));
    expect(out.indexOf('doc-personal')).toBeLessThan(out.indexOf('doc-universal'));
  });

  it('auto senza progetto: 2 query (universal + personal)', async () => {
    const m = makeCtx();
    await (mkTool({ mode: 'search', collection: 'c' }, 'U1', undefined, m.ctx) as any).func({ query: 'q' });
    expect(m.searchCalls).toHaveLength(2);
  });

  it('universal: 1 query con {scope:universal}', async () => {
    const m = makeCtx();
    await (mkTool({ mode: 'search', collection: 'c', searchScope: 'universal' }, 'U1', 'P1', m.ctx) as any).func({ query: 'q' });
    expect(m.searchCalls).toHaveLength(1);
    expect(m.searchCalls[0].filter).toEqual({ scope: 'universal' });
  });

  it('all: 1 query senza filtro', async () => {
    const m = makeCtx();
    await (mkTool({ mode: 'search', collection: 'c', searchScope: 'all' }, 'U1', 'P1', m.ctx) as any).func({ query: 'q' });
    expect(m.searchCalls).toHaveLength(1);
    expect(m.searchCalls[0].filter).toBeUndefined();
  });
});

describe('RAG index — scope assegnato ai documenti', () => {
  it('text in progetto → scope=project + projectId', async () => {
    const m = makeCtx();
    await (mkTool({ mode: 'index', collection: 'c', textParam: 'text' }, 'U1', 'P1', m.ctx) as any).func({ text: 'x' });
    expect(m.upserted[0]?.payload).toMatchObject({ scope: 'project', projectId: 'P1' });
  });

  it('text senza progetto → scope=personal + projectId null', async () => {
    const m = makeCtx();
    await (mkTool({ mode: 'index', collection: 'c', textParam: 'text' }, 'U1', undefined, m.ctx) as any).func({ text: 'x' });
    expect(m.upserted[0]?.payload).toMatchObject({ scope: 'personal', projectId: null });
  });

  it('override indexScope=universal → scope=universal + projectId null', async () => {
    const m = makeCtx();
    await (mkTool({ mode: 'index', collection: 'c', textParam: 'text', indexScope: 'universal' }, 'U1', 'P1', m.ctx) as any).func({ text: 'x' });
    expect(m.upserted[0]?.payload).toMatchObject({ scope: 'universal', projectId: null });
  });

  it('fileId → opts scope=project + projectId passati a ingestFile', async () => {
    const m = makeCtx();
    await (mkTool({ mode: 'index', collection: 'c', fileIdParam: 'fid' }, 'U1', 'P1', m.ctx) as any).func({ fid: 'file-123' });
    expect(m.ingestOpts).toMatchObject({ scope: 'project', projectId: 'P1' });
  });
});
