/**
 * @file tool-selection.service.ts
 *
 * Tool context optimization for the agent prompt — two orthogonal axes:
 *
 * ── AXIS 1: Selection — how many tools to inject ─────────────────────────────
 *   always_inject_all  → all tools (default, zero overhead)
 *   top_k_rag          → only the K tools semantically closest to the user query
 *   auto               → inject_all if n ≤ maxTools, otherwise top_k_rag
 *
 * ── AXIS 2: Schema format — how much detail per tool ─────────────────────────
 *   full       → full schema (default, current behavior)
 *   compressed → description truncated to the first sentence; Zod schema unchanged
 *   deferred   → tools exposed with a minimal description (schema unchanged);
 *                full list (name + 1-liner) injected into the system prompt;
 *                SKILL.md NOT pre-loaded — served on-demand via the meta-tool
 *                `get_tool_instructions(tool_name)` added by AgentService.
 *
 * Typical combinations:
 *   few tools   → always_inject_all + full        (no optimization)
 *   many tools  → auto             + compressed   (balanced)
 *   many tools  → top_k_rag        + compressed   (aggressive)
 *   many tools  → always_inject_all + deferred    (maximum reduction, all available)
 *   many tools  → top_k_rag        + deferred     (reduction + top-K limit)
 */

import { Injectable, Logger, Inject } from '@nestjs/common';
import { EmbeddingProviderService } from '../embed/embedding.provider.service';
import { ToolLoadingStrategy, ToolSchemaFormat } from '../app-config/app-config.entity';
import { toolsNotLoadedBlock } from '../prompts/prompts';

// ── Public types ──────────────────────────────────────────────────────────────

export interface ToolManifest {
  name: string;
  description: string;
  tool: any;
}

export interface ToolLoadingConfig {
  strategy:     ToolLoadingStrategy;
  maxTools:     number;
  schemaFormat: ToolSchemaFormat;
}

// ── Math utility ──────────────────────────────────────────────────────────────

/** Cosine similarity between two vectors of equal dimension. */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return normA && normB ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
}

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class ToolSelectionService {
  private readonly logger = new Logger(ToolSelectionService.name);

  /**
   * Tool embedding cache: key = buildEmbedText(t), value = vector.
   * Invalidated via invalidateEmbeddingCache() when the tools change.
   */
  private readonly embedCache = new Map<string, number[]>();

  /**
   * Builds the text to embed for a tool.
   *
   * Uses `name + description + input parameter names` (from the Zod schema).
   * The parameter names enrich the semantic signal to distinguish
   * tools with similar descriptions but different inputs.
   *
   * Example — send_email:
   *   "skill_gmail_send_email_py: Send an email via Gmail. Fields: to subject body cc bcc html attachments"
   *
   * Example — check_new_emails:
   *   "skill_gmail_check_new_emails_py: Check new emails. Fields: since_minutes max_results unread_only"
   *
   * → The embedding model associates "send it to mario@gmail.com" with `to`/`attachments`
   *   rather than with `since_minutes`/`unread_only`, disambiguating similar tools.
   */
  private buildEmbedText(t: ToolManifest): string {
    let fields = '';
    try {
      const shape = t.tool?.schema?.shape as Record<string, any> | undefined;
      if (shape) {
        fields = Object.keys(shape).join(' ');
      }
    } catch { /* schema unavailable — fall back to description only */ }

    return fields
      ? `${t.name}: ${t.description}. Fields: ${fields}`
      : `${t.name}: ${t.description}`;
  }

  constructor(
    @Inject(EmbeddingProviderService)
    private readonly embeddingProvider: EmbeddingProviderService,
  ) {}

  // ── Entry point ──────────────────────────────────────────────────────────────

  /**
   * Applies both optimization axes.
   *
   * @param allTools   Full list of the user's tools (custom + MCP + skill)
   * @param userInput  User message (needed for RAG selection)
   * @param config     Effective configuration (already resolved: user override or global)
   * @returns
   *   tools:         tool list ready for createReactAgent
   *   selectedNames: names of the selected tools for the SKILL.md filter
   *                  (null = no filter, includes all)
   *   toolListText:  <available_tools>…</available_tools> text to inject into the
   *                  system prompt (non-null only in deferred mode)
   *   excludedListText: <tools_not_loaded> catalog of the tools FILTERED OUT by
   *                  the selection (non-null only when top-K actually excluded
   *                  some) — without it the model denies capabilities that exist
   */
  async applyStrategy(
    allTools: ToolManifest[],
    userInput: string,
    config: ToolLoadingConfig,
  ): Promise<{
    tools: any[];
    selectedNames: Set<string> | null;
    toolListText: string | null;
    excludedListText: string | null;
  }> {
    if (allTools.length === 0) {
      return { tools: [], selectedNames: null, toolListText: null, excludedListText: null };
    }

    // Axis 1: Selection — determine the manifests to expose
    const { manifests, selectedNames } = await this.selectTools(allTools, userInput, config);

    // Tools filtered out by the selection: the model must know they exist
    // (name + one-liner) or it will claim the capability is missing.
    const excluded = selectedNames
      ? allTools.filter(t => !selectedNames.has(t.name))
      : [];
    const excludedListText = excluded.length
      ? toolsNotLoadedBlock(excluded.map(m => `- ${m.name}: ${this.oneLiner(m.description)}`))
      : null;

    // Axis 2: Schema format
    if (config.schemaFormat === 'deferred') {
      // Real tools exposed with a minimal description; list injected into the system prompt;
      // SKILL.md on-demand via get_tool_instructions (added by AgentService).
      const { tools, toolListText } = this.buildDeferredFormat(manifests);
      this.logger.debug(
        `[${config.strategy}/deferred] ${allTools.length} → ${manifests.length} minimal tools + list in prompt`,
      );
      return { tools, selectedNames, toolListText, excludedListText };
    }

    const formatted = config.schemaFormat === 'compressed'
      ? manifests.map(m => this.compressTool(m.tool))
      : manifests.map(m => m.tool);

    this.logger.debug(
      `[${config.strategy}/${config.schemaFormat}] ${allTools.length} → ${manifests.length} tool`,
    );

    return { tools: formatted, selectedNames, toolListText: null, excludedListText };
  }

  /** Invalidates the embedding cache (call when tools are modified/deleted). */
  invalidateEmbeddingCache(): void {
    this.embedCache.clear();
    this.logger.log('Tool embedding cache invalidated');
  }

  // ── Axis 1: Selection ────────────────────────────────────────────────────────

  /**
   * Returns the selected manifests and their names for the SKILL.md filter.
   *
   * selectedNames semantics:
   *   null        → no filter (always_inject_all, auto below threshold)
   *   Set<string> → only the skills with at least one tool in the set
   */
  private async selectTools(
    tools: ToolManifest[],
    query: string,
    config: ToolLoadingConfig,
  ): Promise<{ manifests: ToolManifest[]; selectedNames: Set<string> | null }> {
    switch (config.strategy) {
      case 'always_inject_all':
        return { manifests: tools, selectedNames: null };

      case 'top_k_rag': {
        const selected = await this.selectByRag(tools, query, config.maxTools);
        return { manifests: selected, selectedNames: new Set(selected.map(m => m.name)) };
      }

      case 'auto': {
        if (tools.length <= config.maxTools) {
          return { manifests: tools, selectedNames: null };
        }
        const selected = await this.selectByRag(tools, query, config.maxTools);
        return { manifests: selected, selectedNames: new Set(selected.map(m => m.name)) };
      }

      default:
        return { manifests: tools, selectedNames: null };
    }
  }

  /**
   * Selects the top-K most relevant tools for the user query using
   * **Multi-Sub-Query max-scoring**.
   *
   * Problem with plain top-K on composite queries:
   *   Query "search documents, generate pdf, send email" → the 3 search tools
   *   (embed_docs, search_docs, search_text) dominate the semantic ranking,
   *   taking 3/5 slots, leaving out necessary tools like gmail_send.
   *
   * Multi-Sub-Query solution:
   *   1. Split the query into sub-queries  →  ["search documents", "generate pdf", "send email"]
   *   2. Single batch embedding:  [fullQuery, subQ1, subQ2, ..., tool1, tool2, ...]  (1 API call)
   *   3. Each tool receives:  score = max(sim(tool, fullQuery), sim(tool, subQ1), ...)
   *   4. Top-K by max score
   *
   * Result: each sub-task of the composite query can elect its own tools,
   * preventing a semantically dominant cluster from taking all the slots.
   *
   * Batch optimization: all query vectors + uncached tools in a single API call.
   * Graceful fallback: if the provider does not respond, it returns all tools.
   */
  private async selectByRag(
    tools: ToolManifest[],
    query: string,
    topK: number,
  ): Promise<ToolManifest[]> {
    if (!query.trim()) {
      this.logger.debug('RAG: empty query → returning the first K tools');
      return tools.slice(0, topK);
    }

    try {
      // ── Split query into sub-queries ──────────────────────────────────────
      const subQueries    = this.splitSubQueries(query);
      const allQueryTexts = [query, ...subQueries];   // fullQuery + subQueries

      // Dynamic K: for N sub-tasks at least N claim slots + buffer are needed.
      // Example: 3 sub-queries with K=5 → effectiveK = max(5, 3+3) = 6
      const effectiveK = Math.min(
        tools.length,
        Math.max(topK, subQueries.length + Math.max(3, subQueries.length)),
      );

      // ── Identify tools not yet cached ────────────────────────────────────
      const uncached  = tools.filter(t => !this.embedCache.has(this.buildEmbedText(t)));
      const cacheHits = tools.length - uncached.length;

      // ── Batch: all queries + all uncached tools (a single API call) ──────
      const textsToEmbed = [
        ...allQueryTexts,
        ...uncached.map(t => this.buildEmbedText(t)),
      ];

      const batchVecs   = await this.embeddingProvider.embedBatchQuery(textsToEmbed);
      const queryVecs   = batchVecs.slice(0, allQueryTexts.length);   // [fullQ, subQ1, subQ2, ...]
      const toolVecsNew = batchVecs.slice(allQueryTexts.length);       // [tool1, tool2, ...]

      // ── Populate the cache with the new vectors ───────────────────────────
      uncached.forEach((t, i) => {
        this.embedCache.set(this.buildEmbedText(t), toolVecsNew[i]);
      });

      if (uncached.length > 0) {
        this.logger.debug(
          `Embedding batch: ${allQueryTexts.length} query vec + ` +
          `${uncached.length} new tools + ${cacheHits} from cache (1 API call)`,
        );
      }

      // ── Sub-query claim + global fill ────────────────────────────────────
      //
      // Problem with global top-K on multi-task queries:
      //   "search pdf, send it via email" → the 3 search tools take 3/5 slots
      //   because they dominate the semantic cluster, excluding send_email.
      //
      // Universal solution (no linguistic rules):
      //   Phase 1 — each sub-query "reserves" its most relevant tool
      //            (the best unclaimed one for that specific semantic vector)
      //   Phase 2 — the remaining slots are filled from the global top-K
      //            (full-query similarity, tools not yet reserved)
      //
      // Guarantees:
      //   - Each sub-task gets at least 1 dedicated tool
      //   - No semantic cluster can monopolize all the slots
      //   - Works for any skill in any domain/language
      //   - A single embedding call for the entire selection
      const toolVecsFull = tools.map(t => this.embedCache.get(this.buildEmbedText(t))!);
      const toolIndexMap  = new Map(tools.map((t, i) => [t.name, i]));

      type Entry = { manifest: ToolManifest; score: number; tag: string };
      const selected: Entry[]     = [];
      const claimedNames          = new Set<string>();

      // — Phase 1: each sub-query reserves its best tool ─────────────────
      for (let si = 0; si < subQueries.length && selected.length < effectiveK; si++) {
        const sqVec = queryVecs[si + 1];   // queryVecs[0] = fullQuery

        let bestScore = -Infinity;
        let bestIdx   = -1;
        for (let i = 0; i < tools.length; i++) {
          if (claimedNames.has(tools[i].name)) continue;
          const score = cosineSimilarity(sqVec, toolVecsFull[i]);
          if (score > bestScore) { bestScore = score; bestIdx = i; }
        }

        if (bestIdx >= 0) {
          selected.push({ manifest: tools[bestIdx], score: bestScore, tag: `subQ${si + 1}` });
          claimedNames.add(tools[bestIdx].name);
        }
      }

      // — Phase 2: fill the remaining slots with the global top ───────────
      const fullQueryVec = queryVecs[0];
      const remaining    = effectiveK - selected.length;

      tools
        .filter(t => !claimedNames.has(t.name))
        .map(t  => ({ manifest: t, score: cosineSimilarity(fullQueryVec, toolVecsFull[toolIndexMap.get(t.name)!]), tag: 'global' }))
        .sort((a, b) => b.score - a.score)
        .slice(0, remaining)
        .forEach(e => selected.push(e));

      const result = selected.map(e => e.manifest);

      const kNote    = effectiveK > topK ? ` K=${topK}→${effectiveK}` : '';
      const subQNote = subQueries.length > 0 ? ` [${subQueries.length} sub-query]` : '';
      const claimCount = selected.filter(e => e.tag !== 'global').length;
      this.logger.debug(
        `RAG tool selection${subQNote}${kNote}: ${tools.length} → ${result.length}` +
        ` (${claimCount} claim + ${result.length - claimCount} global)\n` +
        selected.map((e, i) =>
          `    [${i + 1}][${e.tag.padEnd(6)}] ${e.manifest.name} (sem=${e.score.toFixed(3)})`
        ).join('\n'),
      );

      return result;
    } catch (err: any) {
      this.logger.warn(`RAG selection fallback due to embedding error (${err.message}): using all tools`);
      return tools;
    }
  }

  /**
   * Splits a composite query into discrete sub-queries.
   * Purely syntactic separators: , ; . : — completely language-agnostic.
   * The period is used as a separator only if it is not surrounded by digits
   * (avoids splitting decimal numbers like "3.14" or IPs like "192.168.1.1").
   * Fragments < 6 characters are discarded.
   */
  private splitSubQueries(query: string): string[] {
    return query
      .split(/[,;:]|(?<!\d)\.(?!\d)/)
      .map(s => s.trim())
      .filter(s => s.length >= 6);
  }

  // ── Axis 2: Schema format ──────────────────────────────────────────────────

  /**
   * COMPRESSED mode: creates a Proxy of the tool that exposes only the first
   * sentence of the description. The Zod schema remains unchanged (needed
   * for argument validation by the LLM).
   *
   * Uses a Proxy so as not to mutate the original tool (which might be cached).
   */
  private compressTool(tool: any): any {
    if (!tool || typeof tool.description !== 'string') return tool;

    const desc = tool.description;
    // First meaningful sentence (>= 10 char), max 200 char
    const firstSentence = desc.split(/[.!?\n]/)[0].trim();
    const shortDesc = firstSentence.length >= 10
      ? firstSentence.slice(0, 200)
      : desc.slice(0, 200);

    // If already short do not create a pointless proxy
    if (shortDesc.length >= desc.length * 0.85) return tool;

    // The truncated docs stay reachable: AgentService exposes them via the
    // get_tool_instructions meta-tool — tell the model where to look.
    const compressed = `${shortDesc}. Full instructions: call get_tool_instructions('${tool.name}').`;

    return new Proxy(tool, {
      get(target, prop) {
        if (prop === 'description') return compressed;
        const val = (target as any)[prop];
        return typeof val === 'function' ? val.bind(target) : val;
      },
    });
  }

  /**
   * First meaningful sentence of a description, for one-line tool catalogs.
   * Fallback to the flattened prefix: descriptions starting with a newline or
   * a very short fragment (e.g. MCP docstrings) must not yield an empty line —
   * in the catalogs this line is all the model sees about the tool.
   */
  private oneLiner(description: string): string {
    const firstSentence = (description ?? '').split(/[.!?\n]/)[0].trim();
    return (firstSentence.length >= 10
      ? firstSentence
      : (description ?? '').replace(/\s+/g, ' ').trim()
    ).slice(0, 120);
  }

  // ── Axis 2 deferred: format helpers ───────────────────────────────────────

  /**
   * DEFERRED mode: real tools with a minimal description + list in the system prompt.
   *
   * - The tools remain directly callable by the LLM (no call proxy).
   * - Each tool's description is replaced with a minimal string
   *   (~80-90% savings compared to full).
   * - The full list (name + 1-liner) is returned as `toolListText`
   *   to be injected into the system prompt by AgentService.
   * - AgentService separately adds the `get_tool_instructions` meta-tool
   *   that serves the SKILL.md on-demand without pre-loading it.
   */
  buildDeferredFormat(manifests: ToolManifest[]): { tools: any[]; toolListText: string } {
    const lines = manifests.map(m => `- ${m.name}: ${this.oneLiner(m.description)}`);

    const toolListText = [
      '<available_tools>',
      ...lines,
      '</available_tools>',
    ].join('\n');

    const tools = manifests.map(m => this.minimalTool(m.tool));
    return { tools, toolListText };
  }

  /**
   * Creates a Proxy of the tool with its description reduced to just the name.
   * The Zod schema stays intact — the LLM needs it to build the arguments.
   * Uses a Proxy so as not to mutate the original tool (it might be cached).
   */
  private minimalTool(tool: any): any {
    if (!tool || typeof tool.description !== 'string') return tool;

    // If the description is already short do not create a pointless proxy
    if (tool.description.length <= 40) return tool;

    const minDesc =
      `Tool: ${tool.name ?? 'unknown'}. See <available_tools> in system prompt; ` +
      `full instructions: get_tool_instructions('${tool.name ?? 'unknown'}').`;
    return new Proxy(tool, {
      get(target, prop) {
        if (prop === 'description') return minDesc;
        const val = (target as any)[prop];
        return typeof val === 'function' ? val.bind(target) : val;
      },
    });
  }
}
