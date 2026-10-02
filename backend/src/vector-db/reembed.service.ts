// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { BadRequestException, ConflictException, Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { VectorStoreProviderService } from './vector-store-provider.service';
import { EmbeddingProviderService } from '../embed/embedding.provider.service';
import { UserMemory } from '../user-memory/user-memory.entity';
import { Feedback } from '../feedback/feedback.entity';
import { MEMORY_COLLECTION, memoryIndexText, memoryVectorPayload } from '../user-memory/memory-index';
import { FEEDBACK_COLLECTION, feedbackIndexText } from '../feedback/feedback-index';
import type { ScrolledPoint } from './vector-store.types';

/**
 * Admin re-embed: recomputes every vector of the selected collections with the ACTIVE
 * embedding model, without losing data.
 *
 * Per collection: export ids + payloads (JSONL) → embed into a shadow collection with the
 * same ids/payloads → verify (count, id set, payload hashes) → recreate the original with
 * the new dimension and copy the verified points back → verify again → drop the shadow.
 *
 * Text source and embedding side mirror the original writers:
 * - `user_memory`     → DB notes (confirmed), query side, payload regenerated from the note;
 * - `feedback_memory` → DB feedback rows, query side, original payload;
 * - any other         → `payload.text`, document side, original payload.
 * Points with blank text are dropped (whitespace-only chunks carry no information); DB
 * points whose source row no longer exists are dropped as stale. A collection with points
 * that have NO text and no DB source (e.g. skill catalogues that keep only structured
 * fields) is left untouched and reported as "needs-reingest": its owner must re-ingest it.
 */

const SHADOW_SUFFIX = '__reembed';
const PAGE = 128;
const EMBED_BATCH = 32;

type TextSource = 'memory-db' | 'feedback-db' | 'payload';
type Side = 'query' | 'document';
export type ReembedAction = 'reembed' | 'recreate-empty' | 'needs-reingest' | 'empty';

export interface CollectionPlan {
  name:        string;
  vectorSize:  number | null;
  points:      number;
  source:      TextSource;
  side:        Side;
  resolvable:  number;
  blank:       number;
  stale:       number;
  missingText: number;
  /** DB-backed collections: source rows (e.g. confirmed notes) with no point yet — indexed by the run. */
  missingFromIndex: number;
  action:      ReembedAction;
}

export interface CollectionResult extends CollectionPlan {
  status:   'done' | 'skipped' | 'failed';
  written?: number;
  error?:   string;
}

export interface ReembedReport {
  status:       'running' | 'done' | 'failed';
  dryRun:       boolean;
  startedAt:    string;
  finishedAt?:  string;
  targetModel:  string;
  targetSize:   number;
  exportDir?:   string;
  collections:  CollectionResult[];
  error?:       string;
}

/** Deterministic JSON (sorted keys) for payload hashing. */
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object).sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((v as any)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

const hashPayload = (p: unknown) => createHash('sha256').update(stableStringify(p)).digest('hex');

interface Resolved { id: string | number; text: string; payload: Record<string, any> }

@Injectable()
export class ReembedService {
  private readonly logger = new Logger(ReembedService.name);
  private current: ReembedReport | null = null;

  constructor(
    private readonly vectorStore: VectorStoreProviderService,
    @Inject(forwardRef(() => EmbeddingProviderService))
    private readonly embedding: EmbeddingProviderService,
    @InjectRepository(UserMemory) private readonly memoryRepo: Repository<UserMemory>,
    @InjectRepository(Feedback)   private readonly feedbackRepo: Repository<Feedback>,
    private readonly config: ConfigService,
  ) {}

  /** Last (or running) report. */
  status(): ReembedReport | null {
    return this.current;
  }

  /** Dry run: what would happen to each collection with the active model. */
  async plan(only?: string[]): Promise<{ targetModel: string; targetSize: number; collections: CollectionPlan[] }> {
    this.embedding.invalidateCache(); // probe the model the embedding service runs NOW
    const targetSize  = await this.embedding.getVectorSize();
    const targetModel = await this.embedding.getIdentity();
    const names = await this.selectCollections(only);
    const collections: CollectionPlan[] = [];
    for (const name of names) collections.push(await this.planCollection(name, targetSize));
    return { targetModel, targetSize, collections };
  }

  /** Starts the re-embed in the background; poll `status()`. */
  async start(only: string[] | undefined, actor: string): Promise<ReembedReport> {
    if (this.current?.status === 'running') throw new ConflictException('A re-embed is already running');
    const { targetModel, targetSize, collections } = await this.plan(only);
    const report: ReembedReport = {
      status: 'running', dryRun: false, startedAt: new Date().toISOString(),
      targetModel, targetSize, collections: collections.map((c) => ({ ...c, status: 'skipped' as const })),
    };
    this.current = report;
    this.logger.log(`Re-embed started by ${actor}: ${collections.length} collection(s) → ${targetModel}`);
    void this.run(report).catch((err) => {
      report.status = 'failed';
      report.error = err?.message ?? String(err);
      report.finishedAt = new Date().toISOString();
      this.logger.error(`Re-embed failed: ${report.error}`);
    });
    return report;
  }

  // ── Run ──────────────────────────────────────────────────────────────────────

  private async run(report: ReembedReport): Promise<void> {
    // 1. Safety export of every selected collection before touching anything.
    const stamp = report.startedAt.replace(/[:.]/g, '-');
    const exportDir = path.join(this.config.get<string>('UPLOAD_DIR', './uploads'), 'reembed-exports', stamp);
    await fs.mkdir(exportDir, { recursive: true });
    report.exportDir = exportDir;
    for (const c of report.collections) await this.exportCollection(c.name, exportDir);

    // 2. Collections one by one; a failure stops the run (the failed collection is intact
    //    or fully restorable from its verified shadow / export).
    for (const c of report.collections) {
      try {
        if (c.action === 'reembed') {
          c.written = await this.reembedCollection(c, report.targetSize);
          c.status = 'done';
        } else if (c.action === 'recreate-empty') {
          await this.vectorStore.recreateCollection(c.name, report.targetSize);
          c.status = 'done';
        }
      } catch (err: any) {
        c.status = 'failed';
        c.error = err?.message ?? String(err);
        throw new Error(`Collection "${c.name}": ${c.error}`);
      }
    }

    report.status = 'done';
    report.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(exportDir, 'report.json'), JSON.stringify(report, null, 2));
    this.logger.log(`Re-embed done → report ${path.join(exportDir, 'report.json')}`);
  }

  private async reembedCollection(plan: CollectionPlan, targetSize: number): Promise<number> {
    const shadow = plan.name + SHADOW_SUFFIX;
    await this.vectorStore.deleteCollection(shadow);
    await this.vectorStore.ensureCollection(shadow, targetSize);

    // Embed into the shadow, remembering the expected payload hash of every point.
    const expected = new Map<string, string>();
    const lookup = await this.dbLookup(plan.source);
    for await (const page of this.pages(plan.name, false, plan.points === 0)) {
      const resolved = page.map((p) => this.resolve(plan.source, p, lookup)).filter((r): r is Resolved => !!r?.text);
      for (let i = 0; i < resolved.length; i += EMBED_BATCH) {
        const batch = resolved.slice(i, i + EMBED_BATCH);
        const texts = batch.map((r) => r.text);
        const vectors = plan.side === 'query'
          ? await this.embedding.embedBatchQuery(texts)
          : await this.embedding.embedBatch(texts);
        if (vectors.some((v) => v.length !== targetSize)) {
          throw new Error(`embedding service returned vectors of size ${vectors[0]?.length}, expected ${targetSize}`);
        }
        // Original id type preserved (Qdrant accepts UUIDs or unsigned integers).
        await this.vectorStore.upsert(shadow, batch.map((r, j) => ({ id: r.id as string, vector: vectors[j], payload: r.payload })));
        batch.forEach((r) => expected.set(String(r.id), hashPayload(r.payload)));
      }
    }

    // DB is the source of truth: also index source rows that never got a point.
    const missing = this.unindexedSources(plan.source, lookup, new Set(expected.keys()));
    for (let i = 0; i < missing.length; i += EMBED_BATCH) {
      const batch = missing.slice(i, i + EMBED_BATCH);
      const vectors = await this.embedding.embedBatchQuery(batch.map((r) => r.text));
      await this.vectorStore.upsert(shadow, batch.map((r, j) => ({ id: r.id as string, vector: vectors[j], payload: r.payload })));
      batch.forEach((r) => expected.set(String(r.id), hashPayload(r.payload)));
    }

    await this.verify(shadow, expected, 'shadow');

    // Swap: recreate the original with the new dimension and copy the verified points.
    // From here on the verified shadow is the source of truth: it is only dropped after the
    // final verification passes (one retry of the copy); otherwise it is kept for recovery.
    let lastError: unknown;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await this.vectorStore.recreateCollection(plan.name, targetSize);
        for await (const page of this.pages(shadow, true)) {
          await this.vectorStore.upsert(plan.name, page.map((p) => ({ id: p.id as string, vector: p.vector!, payload: p.payload })));
        }
        await this.verify(plan.name, expected, 'final');
        lastError = undefined;
        break;
      } catch (err) {
        lastError = err;
        this.logger.warn(`Swap of "${plan.name}" failed (attempt ${attempt}): ${(err as Error)?.message ?? err}`);
      }
    }
    if (lastError) {
      throw new Error(
        `${(lastError as Error)?.message ?? lastError}. The verified re-embedded points are preserved in ` +
        `"${shadow}" (and ids/payloads in the export): copy them back or restore the snapshot.`,
      );
    }
    await this.vectorStore.deleteCollection(shadow);
    this.logger.log(`Re-embedded "${plan.name}": ${expected.size} points`);
    return expected.size;
  }

  /** Count, id set and payload hashes of `collection` must equal `expected`. */
  private async verify(collection: string, expected: Map<string, string>, stage: string): Promise<void> {
    const seen = new Set<string>();
    for await (const page of this.pages(collection, false)) {
      for (const p of page) {
        const id = String(p.id);
        const want = expected.get(id);
        if (want === undefined) throw new Error(`${stage} verification: unexpected point ${id}`);
        if (want !== hashPayload(p.payload)) throw new Error(`${stage} verification: payload of ${id} differs`);
        seen.add(id);
      }
    }
    if (seen.size !== expected.size) {
      throw new Error(`${stage} verification: ${seen.size} points, expected ${expected.size}`);
    }
  }

  // ── Functional check ─────────────────────────────────────────────────────────

  /**
   * Model-agnostic sanity check: for a sample of points, search with their own text (same
   * side as the writer) — each point must come back in the top-3. Catches corrupted vectors,
   * wrong embedding side or a wrong query prefix after a model change.
   */
  async selfCheck(sample = 30, only?: string[]): Promise<Array<{ name: string; checked: number; top1: number; top3: number; skipped?: string }>> {
    this.embedding.invalidateCache();
    const out: Array<{ name: string; checked: number; top1: number; top3: number; skipped?: string }> = [];
    for (const name of await this.selectCollections(only)) {
      const source: TextSource = name === MEMORY_COLLECTION ? 'memory-db' : name === FEEDBACK_COLLECTION ? 'feedback-db' : 'payload';
      const lookup = await this.dbLookup(source);
      const picked: Resolved[] = [];
      for await (const page of this.pages(name, false)) {
        for (const p of page) {
          const r = this.resolve(source, p, lookup);
          if (r?.text) picked.push(r);
        }
        if (picked.length >= sample * 4) break;
      }
      if (!picked.length) { out.push({ name, checked: 0, top1: 0, top3: 0, skipped: 'no resolvable text' }); continue; }
      const step = Math.max(1, Math.floor(picked.length / sample));
      const probes = picked.filter((_, i) => i % step === 0).slice(0, sample);
      const vectors = source === 'payload'
        ? await this.embedding.embedBatch(probes.map((r) => r.text))
        : await this.embedding.embedBatchQuery(probes.map((r) => r.text));
      let top1 = 0, top3 = 0;
      for (let i = 0; i < probes.length; i++) {
        const hits = await this.vectorStore.search(name, vectors[i], 3);
        const ids = hits.map((h: any) => String(h.id));
        if (ids[0] === String(probes[i].id)) top1++;
        if (ids.includes(String(probes[i].id))) top3++;
      }
      out.push({ name, checked: probes.length, top1, top3 });
    }
    return out;
  }

  // ── Planning ─────────────────────────────────────────────────────────────────

  private async selectCollections(only?: string[]): Promise<string[]> {
    const all = (await this.vectorStore.listCollections()).filter((n) => !n.endsWith(SHADOW_SUFFIX)).sort();
    if (!only?.length) return all;
    const unknown = only.filter((n) => !all.includes(n));
    if (unknown.length) throw new BadRequestException(`Unknown collection(s): ${unknown.join(', ')}`);
    return all.filter((n) => only.includes(n));
  }

  private async planCollection(name: string, targetSize: number): Promise<CollectionPlan> {
    const info = await this.vectorStore.getCollectionInfo(name);
    const source: TextSource = name === MEMORY_COLLECTION ? 'memory-db' : name === FEEDBACK_COLLECTION ? 'feedback-db' : 'payload';
    const side: Side = source === 'payload' ? 'document' : 'query';
    const plan: CollectionPlan = {
      name, vectorSize: info.vectorSize ?? null, points: info.pointsCount ?? 0, source, side,
      resolvable: 0, blank: 0, stale: 0, missingText: 0, missingFromIndex: 0, action: 'reembed',
    };
    const lookup = await this.dbLookup(source);
    const seen = new Set<string>();
    if (plan.points) {
      for await (const page of this.pages(name, false)) {
        for (const p of page) {
          const r = this.resolve(source, p, lookup);
          if (r === null) plan.stale++;
          else if (r === undefined) plan.missingText++;
          else if (!r.text) plan.blank++;
          else { plan.resolvable++; seen.add(String(r.id)); }
        }
      }
    }
    plan.missingFromIndex = this.unindexedSources(source, lookup, seen).length;
    if (!plan.points && !plan.missingFromIndex) {
      plan.action = plan.vectorSize === targetSize ? 'empty' : 'recreate-empty';
      return plan;
    }
    if (plan.missingText > 0) plan.action = 'needs-reingest';
    return plan;
  }

  // ── Text resolution ──────────────────────────────────────────────────────────

  private async dbLookup(source: TextSource): Promise<Map<string, any> | null> {
    if (source === 'memory-db') {
      const notes = await this.memoryRepo.find({ where: { status: 'confirmed' } as any });
      return new Map(notes.map((n) => [n.id, n]));
    }
    if (source === 'feedback-db') {
      const rows = await this.feedbackRepo.find({ where: { vectorId: In(await this.allFeedbackVectorIds()) } as any });
      return new Map(rows.map((f) => [f.vectorId!, f]));
    }
    return null;
  }

  /**
   * Source rows with no point in the collection (memory only: every confirmed note must be
   * indexed). Feedback is vectorized only when the feature is on, so it is not back-filled.
   */
  private unindexedSources(source: TextSource, lookup: Map<string, any> | null, indexed: Set<string>): Resolved[] {
    if (source !== 'memory-db' || !lookup) return [];
    return [...lookup.values()]
      .filter((note) => !indexed.has(String(note.id)))
      .map((note) => ({ id: note.id, text: memoryIndexText(note), payload: memoryVectorPayload(note) }))
      .filter((r) => !!r.text);
  }

  private async allFeedbackVectorIds(): Promise<string[]> {
    const ids: string[] = [];
    for await (const page of this.pages(FEEDBACK_COLLECTION, false)) ids.push(...page.map((p) => String(p.id)));
    return ids.length ? ids : ['00000000-0000-0000-0000-000000000000'];
  }

  /**
   * Resolved text + payload for a point; `{text: ''}` = blank (dropped), `null` = stale DB
   * point (dropped), `undefined` = no text and no DB source (collection needs re-ingest).
   */
  private resolve(source: TextSource, p: ScrolledPoint, lookup: Map<string, any> | null): Resolved | null | undefined {
    if (source === 'memory-db') {
      const note = lookup!.get(String(p.payload?.memoryId ?? p.id));
      return note ? { id: p.id, text: memoryIndexText(note), payload: memoryVectorPayload(note) } : null;
    }
    if (source === 'feedback-db') {
      const row = lookup!.get(String(p.id));
      return row ? { id: p.id, text: feedbackIndexText(row), payload: p.payload } : null;
    }
    const text = p.payload?.text;
    if (typeof text !== 'string') return undefined;
    return { id: p.id, text: text.trim() ? text : '', payload: p.payload };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  private async *pages(collection: string, withVectors: boolean, skip = false): AsyncGenerator<ScrolledPoint[]> {
    if (skip) return;
    let offset: string | number | null = null;
    do {
      const page = await this.vectorStore.scroll(collection, { limit: PAGE, offset, withVectors });
      if (page.points.length) yield page.points;
      offset = page.nextOffset;
    } while (offset !== null);
  }

  private async exportCollection(name: string, dir: string): Promise<void> {
    const file = path.join(dir, `${name}.jsonl`);
    const handle = await fs.open(file, 'w');
    try {
      for await (const page of this.pages(name, false)) {
        await handle.write(page.map((p) => JSON.stringify({ id: p.id, payload: p.payload })).join('\n') + '\n');
      }
    } finally {
      await handle.close();
    }
  }
}
