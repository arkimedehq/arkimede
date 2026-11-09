// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import api from './client';
import { LlmProvider } from './appConfig';

export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high';

/** Reasoning values each provider accepts (mirror of backend reasoning-params.ts). */
export const REASONING_EFFORTS_BY_PROVIDER: Partial<Record<LlmProvider, ReasoningEffort[]>> = {
  deepseek:            ['off', 'low', 'medium', 'high'],
  openai:              ['low', 'medium', 'high'],
  'openai-compatible': ['low', 'medium', 'high'],
  lmstudio:            ['low', 'medium', 'high'],
};

export interface LlmConfigDto {
  id: string;
  name: string;
  provider: LlmProvider;
  model: string | null;
  hasApiKey: boolean;
  baseUrl: string | null;
  maxTokens: number | null;
  /** Concurrent-call cap enforced by the dispatcher. null = unlimited (cloud default). */
  maxConcurrency: number | null;
  /** Reasoning setting (off | low | medium | high). null = the provider's default. */
  reasoningEffort: ReasoningEffort | null;
  /** Price $ per 1M input/output tokens (for the usage dashboard). null = unknown. */
  inputPricePerM: number | null;
  outputPricePerM: number | null;
  /** Price $ per 1M cache tokens (hit/write). null = estimate with default multipliers. */
  cacheReadPricePerM: number | null;
  cacheWritePricePerM: number | null;
  isDefault: boolean;
  isSummarizer: boolean;
  isVision: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Model-picker option, readable by every user (no key/URL/prices). */
export interface LlmConfigOption {
  id: string;
  name: string;
  provider: LlmProvider;
  model: string | null;
  isDefault: boolean;
  isSummarizer: boolean;
}

export interface CreateLlmConfigPayload {
  name: string;
  provider: LlmProvider;
  model?: string | null;
  apiKey?: string | null;
  baseUrl?: string | null;
  maxTokens?: number | null;
  maxConcurrency?: number | null;
  reasoningEffort?: ReasoningEffort | null;
  inputPricePerM?: number | null;
  outputPricePerM?: number | null;
  cacheReadPricePerM?: number | null;
  cacheWritePricePerM?: number | null;
}

export interface UpdateLlmConfigPayload extends Partial<CreateLlmConfigPayload> {}

export const llmConfigsApi = {
  list: (): Promise<LlmConfigDto[]> =>
    api.get('/llm-configs').then((r) => r.data),

  /** For model pickers: works for non-admin users too (list() is admin-only). */
  options: (): Promise<LlmConfigOption[]> =>
    api.get('/llm-configs/options').then((r) => r.data),

  create: (payload: CreateLlmConfigPayload): Promise<LlmConfigDto> =>
    api.post('/llm-configs', payload).then((r) => r.data),

  update: (id: string, payload: UpdateLlmConfigPayload): Promise<LlmConfigDto> =>
    api.patch(`/llm-configs/${id}`, payload).then((r) => r.data),

  remove: (id: string): Promise<void> =>
    api.delete(`/llm-configs/${id}`).then((r) => r.data),

  setDefault: (id: string): Promise<LlmConfigDto[]> =>
    api.post(`/llm-configs/${id}/set-default`).then((r) => r.data),

  /** Designates the config as the summarizer for history compaction. */
  setSummarizer: (id: string): Promise<LlmConfigDto[]> =>
    api.post(`/llm-configs/${id}/set-summarizer`).then((r) => r.data),

  /** Clears the designated summarizer (compaction will use the default). */
  clearSummarizer: (): Promise<LlmConfigDto[]> =>
    api.post('/llm-configs/clear-summarizer').then((r) => r.data),

  /** Designates the config for vision/multimodal tasks (e.g. image OCR). */
  setVision: (id: string): Promise<LlmConfigDto[]> =>
    api.post(`/llm-configs/${id}/set-vision`).then((r) => r.data),

  /** Clears the designated vision config (vision tasks will use the default). */
  clearVision: (): Promise<LlmConfigDto[]> =>
    api.post('/llm-configs/clear-vision').then((r) => r.data),

  testConnection: (id: string): Promise<{ ok: boolean; error?: string }> =>
    api.post(`/llm-configs/${id}/test`).then((r) => r.data),
};
