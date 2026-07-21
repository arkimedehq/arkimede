import api from './client';

export interface AuditEntry {
  id: string;
  createdAt: string;
  actorId: string | null;
  actorName: string | null;
  actAsId: string | null;
  action: string;
  resource: string | null;
  outcome: 'ok' | 'denied' | 'error';
  ctx: Record<string, unknown> | null;
}

export interface AuditFilters {
  action?: string;
  outcome?: string;
  limit?: number;
}

export const auditApi = {
  list: async (filters: AuditFilters = {}): Promise<AuditEntry[]> => {
    const params = new URLSearchParams();
    if (filters.action)  params.set('action', filters.action);
    if (filters.outcome) params.set('outcome', filters.outcome);
    params.set('limit', String(filters.limit ?? 200));
    const { data } = await api.get(`/audit?${params.toString()}`);
    return data;
  },
};
