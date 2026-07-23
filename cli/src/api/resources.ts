// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

// Lean read-only clients for the settings panel lists. Only the fields the
// TUI displays are typed; the backend returns more.

import type {CliConfig} from '../config.js';
import {apiFetch} from './http.js';

export type Scope = 'personal' | 'team' | 'org';

export interface CustomToolSummary {
    id: string;
    name: string;
    description: string;
    executorType: string;
    executorConfig?: Record<string, unknown>;
    enabled: boolean;
    scope: Scope;
}

export interface SkillSummary {
    id: string;
    name: string;
    version: string;
    description: string;
    kind: 'typed' | 'descriptive';
    status: string;
    enabled: boolean;
    scope: Scope;
}

export interface DataSourceSummary {
    id: string;
    name: string;
    description: string | null;
    engine: string;
    scope: Scope;
}

export interface McpServerSummary {
    id: string;
    name: string;
    description: string | null;
    transport: string;
    url: string | null;
    command: string | null;
    enabled: boolean;
}

export interface TokenGroup {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
    messages: number;
    cost?: number;
}

export interface UsageSummary {
    totals: TokenGroup;
    byProject: ({projectId: string | null; projectName: string | null} & TokenGroup)[];
    byModel: ({provider: string | null; model: string | null} & TokenGroup)[];
    /** Admin endpoint only. */
    byUser?: ({userId: string | null; userName: string | null} & TokenGroup)[];
}

export const resourcesApi = {
    tools: (cfg: CliConfig) => apiFetch<CustomToolSummary[]>(cfg, '/api/custom-tools'),
    skills: (cfg: CliConfig) => apiFetch<SkillSummary[]>(cfg, '/api/skills'),
    dataSources: (cfg: CliConfig) => apiFetch<DataSourceSummary[]>(cfg, '/api/data-sources'),
    mcpServers: (cfg: CliConfig) => apiFetch<McpServerSummary[]>(cfg, '/api/mcp-servers'),
    usageMe: (cfg: CliConfig) => apiFetch<UsageSummary>(cfg, '/api/usage/me'),
    /** Admin-only: includes byUser and costs. */
    usageAll: (cfg: CliConfig) => apiFetch<UsageSummary>(cfg, '/api/usage'),

    /** Flips the tool's enabled flag server-side; returns the updated tool. */
    toggleTool: (cfg: CliConfig, id: string) =>
        apiFetch<CustomToolSummary>(cfg, `/api/custom-tools/${id}/toggle`, {method: 'PATCH'}),
    setSkillEnabled: (cfg: CliConfig, id: string, enabled: boolean) =>
        apiFetch<SkillSummary>(cfg, `/api/skills/${id}/enabled`, {method: 'PATCH', body: {enabled}}),
    setMcpEnabled: (cfg: CliConfig, id: string, enabled: boolean) =>
        apiFetch<McpServerSummary>(cfg, `/api/mcp-servers/${id}`, {method: 'PATCH', body: {enabled}}),

    createTool: (cfg: CliConfig, body: Record<string, unknown>) =>
        apiFetch<CustomToolSummary>(cfg, '/api/custom-tools', {method: 'POST', body}),
    updateTool: (cfg: CliConfig, id: string, body: Record<string, unknown>) =>
        apiFetch<CustomToolSummary>(cfg, `/api/custom-tools/${id}`, {method: 'PUT', body}),
    removeTool: (cfg: CliConfig, id: string) =>
        apiFetch<void>(cfg, `/api/custom-tools/${id}`, {method: 'DELETE'}),

    createMcp: (cfg: CliConfig, body: Record<string, unknown>) =>
        apiFetch<McpServerSummary>(cfg, '/api/mcp-servers', {method: 'POST', body}),
    updateMcp: (cfg: CliConfig, id: string, body: Record<string, unknown>) =>
        apiFetch<McpServerSummary>(cfg, `/api/mcp-servers/${id}`, {method: 'PATCH', body}),
    removeMcp: (cfg: CliConfig, id: string) =>
        apiFetch<void>(cfg, `/api/mcp-servers/${id}`, {method: 'DELETE'}),
};
