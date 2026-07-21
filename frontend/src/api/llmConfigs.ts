import api from './client';
import { LlmProvider } from './appConfig';

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

export interface CreateLlmConfigPayload {
  name: string;
  provider: LlmProvider;
  model?: string | null;
  apiKey?: string | null;
  baseUrl?: string | null;
  maxTokens?: number | null;
  maxConcurrency?: number | null;
  inputPricePerM?: number | null;
  outputPricePerM?: number | null;
  cacheReadPricePerM?: number | null;
  cacheWritePricePerM?: number | null;
}

export interface UpdateLlmConfigPayload extends Partial<CreateLlmConfigPayload> {}

export const llmConfigsApi = {
  list: (): Promise<LlmConfigDto[]> =>
    api.get('/llm-configs').then((r) => r.data),

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
