/**
 * History compaction (rolling summary) — AgentService.compactHistory.
 *
 * When the history exceeds a configurable % of the token budget, the older turns
 * are summarized into an incremental summary persisted on the Chat, and only the
 * most recent turns are kept verbatim. This exercises the REAL private method
 * (no LLM, no DB): `summarize` is stubbed and `chatRepo` is an in-memory fake, so
 * the branching/threshold/persistence logic is verified deterministically.
 *
 * Token model under test: est(s) = ceil(s.length / 4). `fill(n)` produces a string
 * that weighs exactly `n` tokens; a message's weight is content + toolCalls payload.
 */
import { describe, it, expect, vi } from 'vitest';
import { AgentService } from '../../src/agent/agent.service';

// ── helpers ───────────────────────────────────────────────────────────────────

/** String whose est() weight is exactly `tokens` (length = 4*tokens). */
const fill = (tokens: number) => 'x'.repeat(tokens * 4);
const estTok = (s: string) => Math.ceil((s ?? '').length / 4);

/** Assistant message weighing `tokens` tokens of content (+ optional toolCalls). */
function M(id: string, tokens: number, toolCalls: any[] | null = null) {
  return { id, role: 'assistant', content: fill(tokens), toolCalls } as any;
}

/** A toolCalls payload whose JSON weighs ~`tokens` tokens (content stays tiny). */
function heavyToolCalls(tokens: number): any[] {
  // JSON.stringify([{ name, input, output }]) length ≈ output length + small overhead.
  return [{ name: 'sql', input: {}, output: 'y'.repeat(tokens * 4) }];
}

type FakeChat = {
  id: string;
  summary: string | null;
  summaryUpToMessageId: string | null;
  summaryTokens: number | null;
};

/**
 * Instance of the REAL AgentService with only the deps compactHistory touches.
 * Object.create skips the 15-arg constructor; `summarize` is stubbed so no LLM runs.
 */
function makeService(chat: FakeChat | null, summarizeImpl?: (prev: string | null, turns: any[]) => Promise<string>) {
  const svc: any = Object.create(AgentService.prototype);
  svc.chatRepo = {
    findOne: vi.fn(async () => chat),
    save:    vi.fn(async (c: any) => c),
  };
  svc.logger = { log: vi.fn(), warn: vi.fn() };
  svc.summarize = vi.fn(summarizeImpl ?? (async () => 'SUMMARY'));
  return svc;
}

const call = (svc: any, history: any[], max: number, enabled: boolean, pct: number, chatId: string | undefined = 'chat1') =>
  svc.compactHistory(chatId, history, max, enabled, pct);

// ── no-op guards ──────────────────────────────────────────────────────────────

describe('compactHistory · guardie no-op', () => {
  it('toggle disabilitato → history intatta, summary null, repo mai toccato', async () => {
    const svc = makeService({ id: 'chat1', summary: 'X', summaryUpToMessageId: null, summaryTokens: 1 });
    const history = [M('m0', 500), M('m1', 500)];
    const res = await call(svc, history, 1000, /* enabled */ false, 80);
    expect(res).toEqual({ summary: null, effectiveHistory: history });
    expect(svc.chatRepo.findOne).not.toHaveBeenCalled();
    expect(svc.summarize).not.toHaveBeenCalled();
  });

  it('chatId assente → no-op', async () => {
    const svc = makeService(null);
    const history = [M('m0', 900)];
    // Call directly: passing undefined through the `call` helper would hit its default chatId.
    const res = await svc.compactHistory(undefined, history, 1000, true, 80);
    expect(res).toEqual({ summary: null, effectiveHistory: history });
    expect(svc.chatRepo.findOne).not.toHaveBeenCalled();
  });

  it('budget <= 0 → no-op', async () => {
    const svc = makeService({ id: 'chat1', summary: null, summaryUpToMessageId: null, summaryTokens: null });
    const history = [M('m0', 900)];
    const res = await call(svc, history, 0, true, 80);
    expect(res).toEqual({ summary: null, effectiveHistory: history });
    expect(svc.chatRepo.findOne).not.toHaveBeenCalled();
  });

  it('chat inesistente → no-op (history intatta)', async () => {
    const svc = makeService(null); // findOne resolves null
    const history = [M('m0', 900)];
    const res = await call(svc, history, 1000, true, 80);
    expect(res).toEqual({ summary: null, effectiveHistory: history });
    expect(svc.summarize).not.toHaveBeenCalled();
  });
});

// ── below threshold ─────────────────────────────────────────────────────────

describe('compactHistory · sotto soglia', () => {
  it('summary+fresh entro la soglia → nessuna sintesi, ritorna summary corrente + fresh', async () => {
    const chat: FakeChat = { id: 'chat1', summary: 'OLD', summaryUpToMessageId: null, summaryTokens: 1 };
    const svc = makeService(chat);
    const history = [M('m0', 100), M('m1', 100)]; // 200 tok « trigger 800
    const res = await call(svc, history, 1000, true, 80);
    expect(res.summary).toBe('OLD');
    expect(res.effectiveHistory).toEqual(history);
    expect(svc.summarize).not.toHaveBeenCalled();
    expect(svc.chatRepo.save).not.toHaveBeenCalled();
  });

  it('"fresh" esclude i messaggi fino a summaryUpToMessageId', async () => {
    const chat: FakeChat = { id: 'chat1', summary: 'OLD', summaryUpToMessageId: 'm1', summaryTokens: 1 };
    const svc = makeService(chat);
    const history = [M('m0', 50), M('m1', 50), M('m2', 50), M('m3', 50), M('m4', 50)];
    const res = await call(svc, history, 1000, true, 80);
    // Only m2..m4 are "fresh"; total is below the trigger → returned verbatim.
    expect(res.effectiveHistory.map((m: any) => m.id)).toEqual(['m2', 'm3', 'm4']);
    expect(svc.summarize).not.toHaveBeenCalled();
  });
});

// ── above threshold → summarize ───────────────────────────────────────────────

describe('compactHistory · sopra soglia → compattazione', () => {
  it('sintetizza i turni vecchi, mantiene i recenti, persiste il summary sul Chat', async () => {
    const chat: FakeChat = { id: 'chat1', summary: null, summaryUpToMessageId: null, summaryTokens: null };
    const svc = makeService(chat);
    // 10 msg × 100 tok = 1000 > trigger 800; keepBudget = 400 → keep last 4, summarize first 6.
    const history = Array.from({ length: 10 }, (_, i) => M(`m${i}`, 100));
    const res = await call(svc, history, 1000, true, 80);

    // summarize called once with (previousSummary=null, the 6 oldest fresh messages).
    expect(svc.summarize).toHaveBeenCalledTimes(1);
    const [prev, turns] = svc.summarize.mock.calls[0];
    expect(prev).toBeNull();
    expect(turns.map((m: any) => m.id)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5']);

    // Only the last 4 are kept verbatim; the new summary replaces the summarized span.
    expect(res.summary).toBe('SUMMARY');
    expect(res.effectiveHistory.map((m: any) => m.id)).toEqual(['m6', 'm7', 'm8', 'm9']);

    // Chat persisted: summary, cursor = last summarized id, token estimate of the summary.
    expect(svc.chatRepo.save).toHaveBeenCalledTimes(1);
    expect(chat.summary).toBe('SUMMARY');
    expect(chat.summaryUpToMessageId).toBe('m5');
    expect(chat.summaryTokens).toBe(estTok('SUMMARY'));
  });

  it('il payload di toolCalls pesa sul budget (compatta quando il solo content non basterebbe)', async () => {
    const chat: FakeChat = { id: 'chat1', summary: null, summaryUpToMessageId: null, summaryTokens: null };
    const svc = makeService(chat);
    // m0: tiny content but a ~900-tok toolCalls payload; m1..m3: 50 tok each.
    // Content-only total = 10 + 150 = 160 « 800 (would NOT trigger); with toolCalls it does.
    const history = [
      M('m0', 10, heavyToolCalls(900)),
      M('m1', 50), M('m2', 50), M('m3', 50),
    ];
    const res = await call(svc, history, 1000, true, 80);

    expect(svc.summarize).toHaveBeenCalledTimes(1); // triggered → toolCalls counted
    const turns = svc.summarize.mock.calls[0][1];
    expect(turns.map((m: any) => m.id)).toEqual(['m0']); // the heavy turn is the one summarized
    expect(res.effectiveHistory.map((m: any) => m.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('la soglia è configurabile e clampata a un minimo del 50%', async () => {
    // thresholdPct=10 must clamp up to 50 → trigger = 500. Fresh = 400 tok stays BELOW.
    // (Un-clamped 10% → trigger 100 → it would wrongly compact.)
    const chat: FakeChat = { id: 'chat1', summary: null, summaryUpToMessageId: null, summaryTokens: null };
    const svc = makeService(chat);
    const history = [M('m0', 100), M('m1', 100), M('m2', 100), M('m3', 100)]; // 400 tok
    const res = await call(svc, history, 1000, true, /* thresholdPct */ 10);
    expect(svc.summarize).not.toHaveBeenCalled();
    expect(res.effectiveHistory).toEqual(history);
  });
});

// ── resilience / edge cases ───────────────────────────────────────────────────

describe('compactHistory · resilienza', () => {
  it('errore del summarizer → fallback al solo trim (nessun throw, Chat invariato)', async () => {
    const chat: FakeChat = { id: 'chat1', summary: null, summaryUpToMessageId: null, summaryTokens: null };
    const svc = makeService(chat, async () => { throw new Error('LLM down'); });
    const history = Array.from({ length: 10 }, (_, i) => M(`m${i}`, 100)); // triggers

    const res = await call(svc, history, 1000, true, 80);

    // Falls back to the full fresh history; summary stays as it was; nothing persisted.
    expect(res.summary).toBeNull();
    expect(res.effectiveHistory).toEqual(history);
    expect(svc.chatRepo.save).not.toHaveBeenCalled();
    expect(chat.summary).toBeNull();
    expect(svc.logger.warn).toHaveBeenCalled();
  });

  it('un unico turno enorme (nulla da sintetizzare) → no-op, lascia decidere il trim', async () => {
    const chat: FakeChat = { id: 'chat1', summary: null, summaryUpToMessageId: null, summaryTokens: null };
    const svc = makeService(chat);
    const history = [M('m0', 900)]; // over trigger but alone: keepFrom collapses → toSummarize empty
    const res = await call(svc, history, 1000, true, 80);
    expect(svc.summarize).not.toHaveBeenCalled();
    expect(svc.chatRepo.save).not.toHaveBeenCalled();
    expect(res.effectiveHistory).toEqual(history);
  });
});
