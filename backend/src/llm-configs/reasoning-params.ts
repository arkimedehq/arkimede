// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { LlmProvider } from '../app-config/app-config.entity';

/**
 * Reasoning ("thinking") setting of an LLM config. null = the provider's default.
 * 'off' turns thinking off where the provider allows it; low/medium/high set the
 * reasoning effort. Latency-sensitive callers (voice) gain the most: hidden
 * reasoning tokens are generated before every answer and every tool call.
 */
export const REASONING_EFFORTS = ['off', 'low', 'medium', 'high'] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];

/** Providers whose request accepts the setting, with the values each one supports. */
const SUPPORTED: Partial<Record<LlmProvider, readonly ReasoningEffort[]>> = {
  deepseek:            ['off', 'low', 'medium', 'high'],
  openai:              ['low', 'medium', 'high'],
  'openai-compatible': ['low', 'medium', 'high'],
  lmstudio:            ['low', 'medium', 'high'],
};

export function supportedReasoningEfforts(provider: LlmProvider): readonly ReasoningEffort[] {
  return SUPPORTED[provider] ?? [];
}

/**
 * Extra request-body fields (OpenAI-style `modelKwargs`) for a config's setting.
 * Empty when the setting is null or the provider does not support that value, so
 * the request stays exactly as without the setting.
 */
export function reasoningModelKwargs(provider: LlmProvider, effort: ReasoningEffort | null | undefined): Record<string, unknown> {
  if (!effort || !supportedReasoningEfforts(provider).includes(effort)) return {};
  if (effort === 'off') return { thinking: { type: 'disabled' } };
  return { reasoning_effort: effort };
}
