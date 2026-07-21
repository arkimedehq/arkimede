/**
 * @file memory-evolution.service.ts
 *
 * A-MEM F3 — CONSERVATIVE memory evolution (decision taken with the owner,
 * anti-drift correctives from Hermes Agent): when a note is confirmed, a
 * background job looks up its related notes and lets the summarizer decide
 *   - which notes to LINK (bidirectional linkedIds — reversible),
 *   - which related notes to ENRICH — ADDITIVELY ONLY (append to context,
 *     add tags; the content is NEVER rewritten),
 *   - whether the new note near-duplicates an existing one → a MERGE PROPOSAL
 *     (pending note carrying mergeOfIds; the user confirms, never automatic).
 *
 * Guards: evolution is enqueued ONLY by note-confirmation events (the appends
 * performed here never re-enqueue → no recursive cascades); candidates are
 * capped; the whole job is best-effort and its LLM call runs as
 * background/system (visible in llm_calls).
 */
import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { Queue, Worker, Job, ConnectionOptions } from 'bullmq';
import { UserMemory } from './user-memory.entity';
import { fuseHybrid } from './user-memory.service';
import { LlmProviderService } from '../app-config/llm-provider.service';
import { EmbeddingProviderService } from '../embed/embedding.provider.service';
import { VectorStoreProviderService } from '../vector-db/vector-store-provider.service';
import { AuditService } from '../audit/audit.service';
import { runWithLlmCallContext } from '../usage/llm-call-context';

const QUEUE_NAME = 'memory-evolution';
/** Delay before processing: lets the fire-and-forget enrichment land first. */
const JOB_DELAY_MS = 4_000;
/** Related notes given to the summarizer. */
const MAX_CANDIDATES = 6;
/** Tags cap after additive enrichment (F1 generates ≤3; appends may add). */
const MAX_TAGS = 6;
/** Context cap after appends. */
const MAX_CONTEXT = 400;

interface EvolutionJobData { noteId: string }

/** What the summarizer may decide. Everything else is dropped by sanitize. */
export interface EvolutionPlan {
  links: string[];
  enrich: Array<{ id: string; addTags: string[]; appendContext: string | null }>;
  merge: { withId: string; mergedContent: string } | null;
}

/**
 * Bounds an LLM-proposed plan to the candidate set (pure function, unit-tested):
 * unknown ids are dropped, tags/context lengths are capped, the merge must
 * target a candidate and carry non-empty content.
 */
export function sanitizeEvolutionPlan(raw: any, candidateIds: string[]): EvolutionPlan {
  const known = new Set(candidateIds);
  const links: string[] = Array.isArray(raw?.links)
    ? [...new Set<string>(raw.links.filter((x: unknown): x is string => typeof x === 'string' && known.has(x)))]
    : [];
  const enrich = Array.isArray(raw?.enrich)
    ? raw.enrich
        .filter((e: any) => e && typeof e.id === 'string' && known.has(e.id))
        .map((e: any) => ({
          id: e.id,
          addTags: Array.isArray(e.addTags)
            ? e.addTags.filter((t: unknown): t is string => typeof t === 'string' && !!t.trim())
                .map((t: string) => t.trim().toLowerCase().slice(0, 40)).slice(0, 3)
            : [],
          appendContext: typeof e.appendContext === 'string' && e.appendContext.trim()
            ? e.appendContext.trim().slice(0, 200) : null,
        }))
        .filter((e: any) => e.addTags.length || e.appendContext)
    : [];
  const merge = raw?.merge && typeof raw.merge.withId === 'string' && known.has(raw.merge.withId)
      && typeof raw.merge.mergedContent === 'string' && raw.merge.mergedContent.trim()
    ? { withId: raw.merge.withId, mergedContent: raw.merge.mergedContent.trim().slice(0, 300) }
    : null;
  return { links, enrich, merge };
}

@Injectable()
export class MemoryEvolutionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MemoryEvolutionService.name);
  private readonly connection: ConnectionOptions;
  private queue?: Queue;
  private worker?: Worker;
  private enabled = false;

  constructor(
    private readonly config: ConfigService,
    @InjectRepository(UserMemory) private readonly repo: Repository<UserMemory>,
    private readonly llmProvider: LlmProviderService,
    private readonly embedding: EmbeddingProviderService,
    private readonly vectorStore: VectorStoreProviderService,
    @Optional() private readonly audit?: AuditService,
  ) {
    const url = new URL(this.config.get<string>('REDIS_URL', 'redis://localhost:6379'));
    this.connection = { host: url.hostname, port: Number(url.port || 6379) };
  }

  onModuleInit(): void {
    try {
      this.queue = new Queue(QUEUE_NAME, { connection: this.connection });
      this.worker = new Worker(QUEUE_NAME, (job) => this.process(job), {
        connection: this.connection,
        concurrency: 1,
      });
      this.worker.on('failed', (job, err) => this.logger.warn(`Evolution job ${job?.id} failed: ${err?.message}`));
      this.worker.on('error', (err) => this.logger.warn(`Evolution worker error: ${err?.message}`));
      this.enabled = true;
      this.logger.log('MemoryEvolution queue started (BullMQ).');
    } catch (err: any) {
      this.enabled = false;
      this.logger.warn(`MemoryEvolution disabled (Redis unreachable?): ${err?.message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close().catch(() => undefined);
    await this.queue?.close().catch(() => undefined);
  }

  /**
   * Schedules the evolution of a freshly confirmed note. Best-effort and
   * optional by design: without Redis the memory simply does not evolve.
   */
  enqueue(noteId: string): void {
    if (!this.enabled || !this.queue) return;
    void this.queue
      .add('evolve', { noteId } satisfies EvolutionJobData, {
        delay: JOB_DELAY_MS,
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: 50,
      })
      .catch((err) => this.logger.warn(`Evolution enqueue failed: ${err?.message}`));
  }

  // ── Worker ──────────────────────────────────────────────────────────────────

  private async process(job: Job<EvolutionJobData>): Promise<void> {
    const note = await this.repo.findOne({ where: { id: job.data.noteId, status: 'confirmed' } });
    if (!note) return;

    const candidates = await this.findCandidates(note);
    if (!candidates.length) return;

    const plan = await this.proposePlan(note, candidates);
    if (!plan.links.length && !plan.enrich.length && !plan.merge) return;

    await this.applyPlan(note, candidates, plan);
  }

  /**
   * Hybrid search (FTS OR-tokens + vector) among the OTHER confirmed notes of
   * the SAME SCOPE (F4): evolution never crosses scopes — a personal note can
   * neither link nor touch a team/org note, and vice versa.
   */
  private async findCandidates(note: UserMemory): Promise<UserMemory[]> {
    const query = [note.content, (note.keywords ?? []).join(' ')].join(' ');
    const terms = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2))].slice(0, 16);

    // Same-scope constraint, both legs.
    const scope = note.scope ?? 'personal';
    const scopeSql =
      scope === 'personal' ? `"scope" = 'personal' AND "userId" = $1::uuid`
      : scope === 'team'   ? `"scope" = 'team' AND "teamId" = $1::uuid`
      :                      `"scope" = 'org' AND $1::uuid IS NULL`;
    const scopeParam = scope === 'personal' ? note.userId : scope === 'team' ? note.teamId : null;
    const vectorFilter =
      scope === 'personal' ? { userId: note.userId, scope: 'personal' }
      : scope === 'team'   ? { scope: 'team', teamId: note.teamId }
      :                      { scope: 'org' };

    const [ftsIds, vectorHits] = await Promise.all([
      (terms.length
        ? this.repo.query(
            `SELECT "id" FROM "user_memory"
              WHERE (${scopeSql}) AND "status" = 'confirmed' AND "id" != $3
                AND "tsv" @@ to_tsquery('simple', $2)
              ORDER BY ts_rank("tsv", to_tsquery('simple', $2)) DESC
              LIMIT ${MAX_CANDIDATES * 2}`,
            [scopeParam, terms.join(' | '), note.id],
          )
        : Promise.resolve([]))
        .then((rows: Array<{ id: string }>) => rows.map((r) => r.id))
        .catch(() => []),
      this.embedding
        .embed(note.content)
        .then((v) => this.vectorStore.search('user_memory', v, MAX_CANDIDATES * 2, vectorFilter))
        .then((hits) => hits.map((h) => ({ id: String(h.payload?.memoryId ?? h.id), score: h.score })))
        .catch(() => []),
    ]);

    const ids = fuseHybrid(ftsIds, vectorHits).filter((id) => id !== note.id).slice(0, MAX_CANDIDATES);
    if (!ids.length) return [];
    const where = scope === 'personal'
      ? { id: In(ids), userId: note.userId, scope: 'personal' as const, status: 'confirmed' as const }
      : scope === 'team'
        ? { id: In(ids), scope: 'team' as const, teamId: note.teamId, status: 'confirmed' as const }
        : { id: In(ids), scope: 'org' as const, status: 'confirmed' as const };
    return this.repo.find({ where });
  }

  /** Asks the summarizer for the evolution plan (background/system class). */
  private async proposePlan(note: UserMemory, candidates: UserMemory[]): Promise<EvolutionPlan> {
    const model = await this.llmProvider.getSummarizerModel();
    const list = candidates
      .map((c) => `- id: ${c.id}\n  content: ${c.content}\n  context: ${c.context ?? '-'}\n  tags: [${(c.tags ?? []).join(', ')}]`)
      .join('\n');
    const prompt =
      'You maintain a network of long-term memory notes about a user. A NEW note was just confirmed. ' +
      'Given the RELATED existing notes, decide conservatively:\n' +
      '- "links": ids of notes genuinely related to the new one (empty if none);\n' +
      '- "enrich": for at most 2 related notes, OPTIONAL additive touch-ups: "addTags" (0-2 lowercase tags) ' +
      'and/or "appendContext" (ONE short sentence to append to that note\'s context — NEVER rewrite content);\n' +
      '- "merge": ONLY if the new note says essentially the same thing as one existing note, propose ' +
      '{"withId": "<that id>", "mergedContent": "<one sentence combining both>"} — otherwise null.\n' +
      'Be conservative: no links/enrich/merge is a perfectly good answer.\n\n' +
      `NEW NOTE (id ${note.id}):\ncontent: ${note.content}\ncontext: ${note.context ?? '-'}\ntags: [${(note.tags ?? []).join(', ')}]\n\n` +
      `RELATED NOTES:\n${list}\n\n` +
      'Respond EXCLUSIVELY with one JSON object, no extra text:\n' +
      '{"links":["id1"],"enrich":[{"id":"id1","addTags":["tag"],"appendContext":"..."}],"merge":null}';

    const res = await runWithLlmCallContext({ priority: 'background', origin: 'system' }, () => model.invoke(prompt));
    const text = typeof res.content === 'string'
      ? res.content
      : Array.isArray(res.content) ? res.content.map((b: any) => (b?.type === 'text' ? b.text : '')).join('') : '';
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    let raw: any = null;
    if (start >= 0 && end > start) { try { raw = JSON.parse(text.slice(start, end + 1)); } catch { raw = null; } }
    return sanitizeEvolutionPlan(raw, candidates.map((c) => c.id));
  }

  /** Applies the sanitized plan: bidirectional links, additive appends, merge proposal. */
  private async applyPlan(note: UserMemory, candidates: UserMemory[], plan: EvolutionPlan): Promise<void> {
    const byId = new Map(candidates.map((c) => [c.id, c]));

    // Bidirectional links (reversible; never re-enqueue evolution).
    if (plan.links.length) {
      const mine = [...new Set([...(note.linkedIds ?? []), ...plan.links])];
      await this.repo.update(note.id, { linkedIds: mine });
      for (const id of plan.links) {
        const other = byId.get(id)!;
        await this.repo.update(id, { linkedIds: [...new Set([...(other.linkedIds ?? []), note.id])] });
      }
    }

    // Additive enrichment: append-only context, capped union of tags.
    for (const e of plan.enrich) {
      const target = byId.get(e.id)!;
      const tags = [...new Set([...(target.tags ?? []), ...e.addTags])].slice(0, MAX_TAGS);
      const context = e.appendContext
        ? ((target.context ? `${target.context} • ` : '') + e.appendContext).slice(0, MAX_CONTEXT)
        : target.context;
      await this.repo.update(e.id, { tags, context });
      await this.reindex(e.id);
    }

    // Merge: ALWAYS a pending proposal (one per pair; the user decides).
    let mergeProposed = false;
    if (plan.merge) {
      const other = byId.get(plan.merge.withId)!;
      const pair = [note.id, other.id].sort();
      const existing = await this.repo
        .query(`SELECT 1 FROM "user_memory" WHERE "status"='pending' AND "mergeOfIds" @> $1::jsonb LIMIT 1`, [JSON.stringify(pair)])
        .catch(() => []);
      if (!existing.length) {
        await this.repo.save(this.repo.create({
          userId: note.userId,
          scope: note.scope ?? 'personal',
          teamId: note.teamId ?? null,
          content: plan.merge.mergedContent,
          status: 'pending',
          sourceChatId: null,
          tags: [...new Set([...(note.tags ?? []), ...(other.tags ?? [])])].slice(0, MAX_TAGS),
          keywords: [...new Set([...(note.keywords ?? []), ...(other.keywords ?? [])])].slice(0, 8),
          context: note.context ?? other.context ?? null,
          category: note.category ?? other.category ?? null,
          mergeOfIds: pair,
        }));
        mergeProposed = true;
      }
    }

    await this.audit?.record({
      actorId: note.userId,
      action: 'memory.evolved',
      resource: note.content.slice(0, 80),
      outcome: 'ok',
      ctx: { noteId: note.id, links: plan.links.length, enriched: plan.enrich.length, mergeProposed },
    });
    this.logger.log(
      `Memory evolution (${note.id}): ${plan.links.length} links, ${plan.enrich.length} enriched, merge=${mergeProposed}`,
    );
  }

  /** Re-embeds a note whose retrievable text changed (append/tags). */
  private async reindex(id: string): Promise<void> {
    try {
      const note = await this.repo.findOne({ where: { id } });
      if (!note || note.status !== 'confirmed') return;
      const text = [note.content, note.context ?? '', (note.keywords ?? []).join(' ')].join('\n').trim();
      const vector = await this.embedding.embed(text);
      await this.vectorStore.upsert('user_memory', [{
        id: note.id,
        vector,
        payload: { userId: note.userId, memoryId: note.id, tags: note.tags ?? [], category: note.category ?? null },
      }]);
    } catch (err: any) {
      this.logger.warn(`Evolution reindex failed (${id}): ${err?.message ?? err}`);
    }
  }
}
