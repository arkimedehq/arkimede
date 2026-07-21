/**
 * @file llm-usage.util.ts
 *
 * Extraction/sum of the tokens from a LangGraph result (list of messages).
 * Used to account for the usage of **team** (Multi-Agent) and **headless**
 * (automations) runs, which do not go through the chat streaming where the tokens
 * are already captured.
 *
 * Note: usage_metadata's `input_tokens` (LangChain) already includes the cache
 * tokens; the details (`input_token_details.cache_read/cache_creation`) are
 * extracted here so pricing.ts can price them with the correct multipliers.
 */
export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export const emptyUsage = (): LlmUsage => ({
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
});

export const addUsage = (a: LlmUsage, b: LlmUsage): LlmUsage => ({
  inputTokens:      a.inputTokens      + b.inputTokens,
  outputTokens:     a.outputTokens     + b.outputTokens,
  cacheReadTokens:  a.cacheReadTokens  + b.cacheReadTokens,
  cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
});

/** Extracts the tokens from a single usage block (usage_metadata or legacy equivalents). */
function tokensFromUsage(u: any): LlmUsage {
  return {
    inputTokens:      Number(u.input_tokens ?? u.promptTokens ?? u.prompt_tokens ?? 0) || 0,
    outputTokens:     Number(u.output_tokens ?? u.completionTokens ?? u.completion_tokens ?? 0) || 0,
    cacheReadTokens:  Number(u.input_token_details?.cache_read ?? 0) || 0,
    cacheWriteTokens: Number(u.input_token_details?.cache_creation ?? 0) || 0,
  };
}

/** Sums `usage_metadata` over all the messages (AIMessage) of a result. */
export function sumUsageFromMessages(messages: any[] | undefined): LlmUsage {
  let out = emptyUsage();
  for (const m of messages ?? []) {
    const u = (m as any)?.usage_metadata
      ?? (m as any)?.response_metadata?.usage
      ?? (m as any)?.response_metadata?.tokenUsage;
    if (!u) continue;
    out = addUsage(out, tokensFromUsage(u));
  }
  return out;
}

/** Usage from a single `model.invoke(...)` response. */
export function usageFromResult(res: any): LlmUsage {
  const u = res?.usage_metadata ?? res?.response_metadata?.usage ?? res?.response_metadata?.tokenUsage;
  if (!u) return emptyUsage();
  return tokensFromUsage(u);
}
