import api from './client';

export interface TokenGroup {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  messages: number;
  /** Admin views only. */
  cost?: number;
  costMissing?: boolean;
}

export type ProjectRow = { projectId: string | null; projectName: string | null } & TokenGroup;
export type ModelRow   = { provider: string | null; model: string | null } & TokenGroup;
export type UserRow    = { userId: string | null; userName: string | null } & TokenGroup;

export interface UserUsageSummary {
  totals: TokenGroup;
  byProject: ProjectRow[];
  byModel: ModelRow[];
}

export interface AdminUsageSummary extends UserUsageSummary {
  byUser: UserRow[];
}

// ── Serving metrics (call-level, admin) ──────────────────────────────────────

export interface ServingGroup {
  llmConfigId: string | null;
  configName: string | null;
  provider: string | null;
  model: string | null;
  calls: number;
  errors: number;
  errorRate: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  maxLatencyMs: number;
  /** Null until the request scheduler exists. */
  avgQueuedMs: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  tokensPerSecond: number | null;
}

export interface ServingTimelinePoint {
  bucket: string;
  calls: number;
  errors: number;
  p95LatencyMs: number;
}

export interface ServingSummary {
  from: string;
  to: string;
  bucket: 'minute' | 'hour' | 'day';
  totals: Omit<ServingGroup, 'llmConfigId' | 'configName' | 'provider' | 'model'>;
  byConfig: ServingGroup[];
  timeline: ServingTimelinePoint[];
}

interface Range { from?: string; to?: string }

export const usageApi = {
  /** My usage (tokens only). */
  me: (range: Range = {}): Promise<UserUsageSummary> =>
    api.get('/usage/me', { params: range }).then((r) => r.data),

  /** Global usage + costs (admin). */
  all: (range: Range = {}): Promise<AdminUsageSummary> =>
    api.get('/usage', { params: range }).then((r) => r.data),

  /** Call-level serving metrics: latency percentiles, error rate, timeline (admin). */
  serving: (range: Range = {}): Promise<ServingSummary> =>
    api.get('/usage/serving', { params: range }).then((r) => r.data),

  /** Live dispatcher queues: active/waiting/max per gated config (admin). */
  servingLive: (): Promise<ServingLiveEntry[]> =>
    api.get('/usage/serving/live').then((r) => r.data),
};

export interface ServingLiveEntry {
  llmConfigId: string;
  configName: string | null;
  active: number;
  waiting: number;
  max: number | null;
}
