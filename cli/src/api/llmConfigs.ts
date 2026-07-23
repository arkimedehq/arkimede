// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import type {CliConfig} from '../config.js';
import {apiFetch} from './http.js';

/** DTO returned by the backend — the apiKey is never included (hasApiKey flag). */
export interface LlmConfigDto {
    id: string;
    name: string;
    provider: string;
    model: string | null;
    baseUrl?: string | null;
    hasApiKey: boolean;
    maxTokens: number | null;
    maxConcurrency?: number | null;
    inputPricePerM?: number | null;
    outputPricePerM?: number | null;
    isDefault: boolean;
    isSummarizer: boolean;
    isVision: boolean;
}

/** Providers accepted by the backend (LLM_PROVIDERS in llm-configs.controller). */
export const LLM_PROVIDERS = [
    'anthropic',
    'openai',
    'gemini',
    'ollama',
    'lmstudio',
    'openai-compatible',
    'deepseek',
] as const;

export interface LlmConfigPayload {
    name?: string;
    provider?: string;
    model?: string | null;
    /** undefined = keep the stored key; a non-empty string sets a new one. */
    apiKey?: string;
    baseUrl?: string | null;
    maxTokens?: number | null;
}

export const llmConfigsApi = {
    /** Admin-only on the backend: 403 for regular users. */
    list: (cfg: CliConfig) => apiFetch<LlmConfigDto[]>(cfg, '/api/llm-configs'),

    /** Admin-only: makes this config the one used by all chats. */
    setDefault: (cfg: CliConfig, id: string) =>
        apiFetch<LlmConfigDto>(cfg, `/api/llm-configs/${id}/set-default`, {method: 'POST'}),

    create: (cfg: CliConfig, payload: LlmConfigPayload) =>
        apiFetch<LlmConfigDto>(cfg, '/api/llm-configs', {method: 'POST', body: payload}),

    update: (cfg: CliConfig, id: string, payload: LlmConfigPayload) =>
        apiFetch<LlmConfigDto>(cfg, `/api/llm-configs/${id}`, {method: 'PATCH', body: payload}),

    /** The backend refuses to delete the last remaining config. */
    remove: (cfg: CliConfig, id: string) =>
        apiFetch<void>(cfg, `/api/llm-configs/${id}`, {method: 'DELETE'}),
};
