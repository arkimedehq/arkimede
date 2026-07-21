import { Injectable, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Message } from '../messages/messages.entity';
import { LlmConfigEntity } from '../llm-configs/llm-config.entity';
import { computeCost, type ModelPrice } from './pricing';

export interface UsageFilter {
  from?: Date;
  to?: Date;
  userId?: string;
}

/** Sum of tokens (always present) + optional cost (admin side only). */
export interface TokenGroup {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  messages: number;
  /** Estimated cost in $; present only in admin views. */
  cost?: number;
  /** true if some row of the group is missing the price (partial cost). */
  costMissing?: boolean;
}

interface AggRow {
  userId: string | null;
  userName: string | null;
  projectId: string | null;
  projectName: string | null;
  provider: string | null;
  model: string | null;
  inTok: number;
  outTok: number;
  cacheR: number;
  cacheW: number;
  msgs: number;
}

export interface UserUsageSummary {
  totals: TokenGroup;
  byProject: ({ projectId: string | null; projectName: string | null } & TokenGroup)[];
  byModel: ({ provider: string | null; model: string | null } & TokenGroup)[];
}

export interface AdminUsageSummary extends UserUsageSummary {
  byUser: ({ userId: string | null; userName: string | null } & TokenGroup)[];
}

@Injectable()
export class UsageService {
  constructor(
    @InjectRepository(Message)        private readonly messageRepo: Repository<Message>,
    @InjectRepository(LlmConfigEntity) private readonly llmConfigRepo: Repository<LlmConfigEntity>,
  ) {}

  // ── Aggregation query ────────────────────────────────────────────────────

  private async aggregate(filter: UsageFilter): Promise<AggRow[]> {
    const qb = this.messageRepo.createQueryBuilder('m')
      .innerJoin('chats', 'c', 'c.id = m."chatId"')
      .leftJoin('users', 'u', 'u.id = c."userId"')
      .leftJoin('projects', 'p', 'p.id = c."projectId"')
      .select('c."userId"', 'userId')
      .addSelect('u."name"', 'userName')
      .addSelect('c."projectId"', 'projectId')
      .addSelect('p."name"', 'projectName')
      .addSelect('m."provider"', 'provider')
      .addSelect('m."model"', 'model')
      .addSelect('COALESCE(SUM(m."inputTokens"), 0)', 'inTok')
      .addSelect('COALESCE(SUM(m."outputTokens"), 0)', 'outTok')
      .addSelect('COALESCE(SUM(m."cacheReadTokens"), 0)', 'cacheR')
      .addSelect('COALESCE(SUM(m."cacheWriteTokens"), 0)', 'cacheW')
      .addSelect('COUNT(*)', 'msgs')
      .where('m."role" = :role', { role: 'assistant' })
      .andWhere('(m."inputTokens" IS NOT NULL OR m."outputTokens" IS NOT NULL)')
      .groupBy('c."userId"')
      .addGroupBy('u."name"')
      .addGroupBy('c."projectId"')
      .addGroupBy('p."name"')
      .addGroupBy('m."provider"')
      .addGroupBy('m."model"');

    if (filter.userId) qb.andWhere('c."userId" = :uid', { uid: filter.userId });
    if (filter.from)   qb.andWhere('m."createdAt" >= :from', { from: filter.from });
    if (filter.to)     qb.andWhere('m."createdAt" < :to', { to: filter.to });

    const raw = await qb.getRawMany();
    return raw.map((r) => ({
      userId:      r.userId ?? null,
      userName:    r.userName ?? null,
      projectId:   r.projectId ?? null,
      projectName: r.projectName ?? null,
      provider:    r.provider ?? null,
      model:       r.model ?? null,
      inTok:  Number(r.inTok)  || 0,
      outTok: Number(r.outTok) || 0,
      cacheR: Number(r.cacheR) || 0,
      cacheW: Number(r.cacheW) || 0,
      msgs:   Number(r.msgs)   || 0,
    }));
  }

  // ── Price map from llm_configs ──────────────────────────────────────────────

  /**
   * Map keyed by exact `provider:model`. No per-provider fallback: each model
   * uses ONLY the price configured for itself; without a match the cost is 0 (costMissing).
   */
  private async buildPriceMap(): Promise<Map<string, ModelPrice>> {
    const configs = await this.llmConfigRepo.find();
    const map = new Map<string, ModelPrice>();
    for (const c of configs) {
      if (c.inputPricePerM == null || c.outputPricePerM == null) continue;
      map.set(`${c.provider}:${c.model ?? ''}`, {
        inputPerM:  Number(c.inputPricePerM),
        outputPerM: Number(c.outputPricePerM),
        cacheReadPerM:  c.cacheReadPricePerM  != null ? Number(c.cacheReadPricePerM)  : null,
        cacheWritePerM: c.cacheWritePricePerM != null ? Number(c.cacheWritePricePerM) : null,
      });
    }
    return map;
  }

  private lookupPrice(map: Map<string, ModelPrice>, provider: string | null, model: string | null): ModelPrice | null {
    if (!provider) return null;
    return map.get(`${provider}:${model ?? ''}`) ?? null;
  }

  // ── Accumulators ─────────────────────────────────────────────────────────────

  private emptyGroup(withCost: boolean): TokenGroup {
    const g: TokenGroup = {
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      totalTokens: 0, messages: 0,
    };
    if (withCost) { g.cost = 0; g.costMissing = false; }
    return g;
  }

  /** Adds a row to a group, computing the cost if requested. */
  private accumulate(
    g: TokenGroup, row: AggRow, withCost: boolean, priceMap: Map<string, ModelPrice>,
  ): void {
    g.inputTokens      += row.inTok;
    g.outputTokens     += row.outTok;
    g.cacheReadTokens  += row.cacheR;
    g.cacheWriteTokens += row.cacheW;
    g.totalTokens      += row.inTok + row.outTok;
    g.messages         += row.msgs;
    if (!withCost) return;

    const price = this.lookupPrice(priceMap, row.provider, row.model);
    if (!price) { g.costMissing = true; return; }
    g.cost = (g.cost ?? 0) + computeCost(row.provider!, {
      inputTokens: row.inTok, outputTokens: row.outTok,
      cacheReadTokens: row.cacheR, cacheWriteTokens: row.cacheW,
    }, price);
  }

  /** Groups the rows by a key, returning an array sorted by tokens desc. */
  private groupBy<T extends Record<string, any>>(
    rows: AggRow[], withCost: boolean, priceMap: Map<string, ModelPrice>,
    keyOf: (r: AggRow) => string, metaOf: (r: AggRow) => T,
  ): (T & TokenGroup)[] {
    const groups = new Map<string, T & TokenGroup>();
    for (const row of rows) {
      const key = keyOf(row);
      let g = groups.get(key);
      if (!g) { g = { ...metaOf(row), ...this.emptyGroup(withCost) }; groups.set(key, g); }
      this.accumulate(g, row, withCost, priceMap);
    }
    return [...groups.values()].sort((a, b) => b.totalTokens - a.totalTokens);
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  /** Summary for a single user: ONLY tokens, no cost. */
  async summaryForUser(userId: string, filter: Omit<UsageFilter, 'userId'>): Promise<UserUsageSummary> {
    const rows = await this.aggregate({ ...filter, userId });
    const noPrice = new Map<string, ModelPrice>();

    const totals = this.emptyGroup(false);
    for (const r of rows) this.accumulate(totals, r, false, noPrice);

    return {
      totals,
      byProject: this.groupBy(rows, false, noPrice,
        (r) => r.projectId ?? '∅',
        (r) => ({ projectId: r.projectId, projectName: r.projectName })),
      byModel: this.groupBy(rows, false, noPrice,
        (r) => `${r.provider ?? '∅'}:${r.model ?? ''}`,
        (r) => ({ provider: r.provider, model: r.model })),
    };
  }

  /** Global admin summary: tokens + estimated costs, with a breakdown by user too. */
  async summaryForAdmin(filter: UsageFilter): Promise<AdminUsageSummary> {
    const [rows, priceMap] = await Promise.all([this.aggregate(filter), this.buildPriceMap()]);

    const totals = this.emptyGroup(true);
    for (const r of rows) this.accumulate(totals, r, true, priceMap);

    return {
      totals,
      byUser: this.groupBy(rows, true, priceMap,
        (r) => r.userId ?? '∅',
        (r) => ({ userId: r.userId, userName: r.userName })),
      byProject: this.groupBy(rows, true, priceMap,
        (r) => r.projectId ?? '∅',
        (r) => ({ projectId: r.projectId, projectName: r.projectName })),
      byModel: this.groupBy(rows, true, priceMap,
        (r) => `${r.provider ?? '∅'}:${r.model ?? ''}`,
        (r) => ({ provider: r.provider, model: r.model })),
    };
  }
}
