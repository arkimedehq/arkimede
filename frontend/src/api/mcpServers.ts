import { api } from './client';

export interface McpServer {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  transport: 'http' | 'sse' | 'local' | 'remote';
  url: string | null;
  command: string | null;
  args: string[] | null;
  headers: Record<string, string> | null;
  env: Record<string, string> | null;
  enabled: boolean;
  /** If false, the server's tools do not enter the chat's flat context (only via agent). */
  loadOnFirst: boolean;
  secrets: { id: string; serverId: string; keyName: string }[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateMcpServerPayload {
  name: string;
  description?: string;
  transport: 'http' | 'sse' | 'local' | 'remote';
  url?: string;
  command?: string;
  args?: string[];
  headers?: Record<string, string>;
  env?: Record<string, string>;
  loadOnFirst?: boolean;
  secrets?: Record<string, string>;
}

export interface UpdateMcpServerPayload extends Partial<Omit<CreateMcpServerPayload, 'transport'>> {
  enabled?: boolean;
}

export const mcpServersApi = {
  list: () =>
    api.get<McpServer[]>('/mcp-servers').then((r) => r.data),

  create: (payload: CreateMcpServerPayload) =>
    api.post<McpServer>('/mcp-servers', payload).then((r) => r.data),

  get: (id: string) =>
    api.get<McpServer>(`/mcp-servers/${id}`).then((r) => r.data),

  update: (id: string, payload: UpdateMcpServerPayload) =>
    api.patch<McpServer>(`/mcp-servers/${id}`, payload).then((r) => r.data),

  remove: (id: string) =>
    api.delete(`/mcp-servers/${id}`),

  toggle: (id: string, enabled: boolean) =>
    api.patch<McpServer>(`/mcp-servers/${id}`, { enabled }).then((r) => r.data),

  // Secrets
  getSecretKeys: (id: string) =>
    api.get<{ keys: string[] }>(`/mcp-servers/${id}/secrets`).then((r) => r.data.keys),

  upsertSecrets: (id: string, secrets: Record<string, string>) =>
    api.put(`/mcp-servers/${id}/secrets`, secrets),

  removeSecret: (id: string, key: string) =>
    api.delete(`/mcp-servers/${id}/secrets/${key}`),

  // Bridge
  getBridgeStatus: (id: string) =>
    api.get<{ connected: boolean }>(`/mcp-servers/${id}/status`).then((r) => r.data),

  refreshBridge: () =>
    api.post('/mcp-servers/bridge/refresh'),
};
