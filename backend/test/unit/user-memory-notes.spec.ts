/**
 * A-MEM F1: tolerant parsing and bounding of the summarizer-generated note
 * metadata. The note must be valid whatever the LLM returns.
 */
import { describe, it, expect } from 'vitest';
import { UserMemoryService } from '../../src/user-memory/user-memory.service';

// Private-method access on an instance built with inert dependencies.
const svc: any = new UserMemoryService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any);

describe('UserMemoryService — A-MEM note parsing (F1)', () => {
  it('parses the object-array shape with sanitized metadata', () => {
    const out = svc.parseNoteArray(JSON.stringify([{
      content: 'Develops in TypeScript',
      tags: ['Stack', 'DEV'],
      keywords: ['TypeScript', 'NestJS'],
      context: 'Useful when suggesting code.',
      category: 'Profile',
    }]));
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe('Develops in TypeScript');
    expect(out[0].tags).toEqual(['stack', 'dev']);          // lowercased
    expect(out[0].keywords).toEqual(['TypeScript', 'NestJS']); // verbatim
    expect(out[0].category).toBe('profile');
  });

  it('tolerates markdown fences and surrounding prose', () => {
    const out = svc.parseNoteArray('Sure! Here it is:\n```json\n[{"content":"x","tags":[],"keywords":[],"context":null,"category":null}]\n```');
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe('x');
  });

  it('accepts the legacy string-array shape (empty metadata)', () => {
    const out = svc.parseNoteArray('["Prefers concise answers"]');
    expect(out).toEqual([{ content: 'Prefers concise answers', tags: [], keywords: [], context: null, category: null }]);
  });

  it('drops malformed entries and survives garbage', () => {
    expect(svc.parseNoteArray('[{"nope":1}, 42, {"content":"ok"}]').map((n: any) => n.content)).toEqual(['ok']);
    expect(svc.parseNoteArray('not json at all')).toEqual([]);
    expect(svc.parseNoteArray('')).toEqual([]);
  });

  it('bounds metadata sizes (tags ≤3, keywords ≤5, context ≤250)', () => {
    const meta = svc.sanitizeMetadata({
      tags: ['a', 'b', 'c', 'd', 'e'],
      keywords: ['1', '2', '3', '4', '5', '6', '7'],
      context: 'x'.repeat(500),
      category: 'K'.repeat(100),
    });
    expect(meta.tags).toHaveLength(3);
    expect(meta.keywords).toHaveLength(5);
    expect(meta.context).toHaveLength(250);
    expect(meta.category).toHaveLength(64);
  });

  it('parses a single metadata object (enrichNote path), fenced too', () => {
    const obj = svc.parseJsonObject('```json\n{"tags":["x"],"keywords":["Y"],"context":"c","category":"preference"}\n```');
    const meta = svc.sanitizeMetadata(obj);
    expect(meta).toEqual({ tags: ['x'], keywords: ['Y'], context: 'c', category: 'preference' });
    expect(svc.parseJsonObject('garbage')).toBeNull();
  });
});

// ── F2: hybrid fusion ─────────────────────────────────────────────────────────
import { fuseHybrid } from '../../src/user-memory/user-memory.service';

describe('fuseHybrid — RRF fusion with cutoff (F2)', () => {
  it('ranks an id found by both legs above single-leg ids', () => {
    const out = fuseHybrid(['a', 'b'], [{ id: 'b', score: 0.9 }, { id: 'c', score: 0.8 }]);
    expect(out[0]).toBe('b');                    // both legs → highest fused score
    expect(out).toContain('a');
    expect(out).toContain('c');
  });

  it('drops vector-only candidates below the similarity cutoff', () => {
    const out = fuseHybrid([], [{ id: 'weak', score: 0.1 }, { id: 'strong', score: 0.6 }]);
    expect(out).toEqual(['strong']);
  });

  it('keeps low-score vector hits when the FTS leg also found them', () => {
    const out = fuseHybrid(['x'], [{ id: 'x', score: 0.05 }]);
    expect(out).toEqual(['x']);
  });

  it('preserves FTS order when the vector leg is empty (degraded mode)', () => {
    expect(fuseHybrid(['a', 'b', 'c'], [])).toEqual(['a', 'b', 'c']);
  });

  it('returns empty on two empty legs', () => {
    expect(fuseHybrid([], [])).toEqual([]);
  });
});

// ── F3: evolution plan sanitizer ─────────────────────────────────────────────
import { sanitizeEvolutionPlan } from '../../src/user-memory/memory-evolution.service';

describe('sanitizeEvolutionPlan — conservative evolution bounds (F3)', () => {
  const CANDS = ['n1', 'n2'];

  it('keeps only known ids for links, enrich and merge', () => {
    const plan = sanitizeEvolutionPlan({
      links: ['n1', 'ghost', 'n1'],
      enrich: [{ id: 'ghost', addTags: ['x'] }, { id: 'n2', addTags: ['Infra'], appendContext: 'Also used for backups.' }],
      merge: { withId: 'ghost', mergedContent: 'nope' },
    }, CANDS);
    expect(plan.links).toEqual(['n1']);                       // deduped, ghost dropped
    expect(plan.enrich).toEqual([{ id: 'n2', addTags: ['infra'], appendContext: 'Also used for backups.' }]);
    expect(plan.merge).toBeNull();                            // unknown target → dropped
  });

  it('accepts a valid merge and caps its content', () => {
    const plan = sanitizeEvolutionPlan({ links: [], enrich: [], merge: { withId: 'n2', mergedContent: 'x'.repeat(500) } }, CANDS);
    expect(plan.merge?.withId).toBe('n2');
    expect(plan.merge?.mergedContent).toHaveLength(300);
  });

  it('drops enrich entries with nothing to add and bounds tag count', () => {
    const plan = sanitizeEvolutionPlan({
      enrich: [
        { id: 'n1' },                                          // nothing to add
        { id: 'n2', addTags: ['a', 'b', 'c', 'd', 'e'] },      // capped at 3
      ],
    }, CANDS);
    expect(plan.enrich).toHaveLength(1);
    expect(plan.enrich[0].addTags).toEqual(['a', 'b', 'c']);
  });

  it('survives garbage and null', () => {
    expect(sanitizeEvolutionPlan(null, CANDS)).toEqual({ links: [], enrich: [], merge: null });
    expect(sanitizeEvolutionPlan({ links: 'x', enrich: 42, merge: 'y' }, CANDS)).toEqual({ links: [], enrich: [], merge: null });
  });
});
