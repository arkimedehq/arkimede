import api from './client';

// ── Types (mirror of backend/src/agents/agent.types.ts) ────────────────────────

export type AgentScope = 'personal' | 'team' | 'org';
export type TeamTopology = 'supervisor' | 'sequential' | 'parallel';
export interface AgentToolFilter { mode: 'all' | 'names' | 'none'; names?: string[]; }

export interface Agent {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  systemPrompt: string;
  llmConfigId: string | null;
  toolFilter: AgentToolFilter;
  maxIterations: number | null;
  exposeAsTool: boolean;
  scope: AgentScope;
  teamId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentTeamMember {
  id: string;
  teamId: string;
  agentId: string;
  position: number;
  role: string | null;
}

export interface AgentTeam {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  topology: TeamTopology;
  supervisorAgentId: string | null;
  exposeAsTool: boolean;
  scope: AgentScope;
  teamId: string | null;
  createdAt: string;
  updatedAt: string;
  members?: AgentTeamMember[];
}

export interface UpsertAgentPayload {
  name: string;
  description?: string | null;
  systemPrompt?: string;
  llmConfigId?: string | null;
  toolFilter?: AgentToolFilter;
  maxIterations?: number | null;
  exposeAsTool?: boolean;
  scope?: AgentScope;
  teamId?: string | null;
}

export interface UpsertTeamPayload {
  name: string;
  description?: string | null;
  topology?: TeamTopology;
  supervisorAgentId?: string | null;
  exposeAsTool?: boolean;
  scope?: AgentScope;
  teamId?: string | null;
}

export interface MemberInput { agentId: string; position?: number; role?: string | null; }

// ── API ───────────────────────────────────────────────────────────────────────

export const agentsApi = {
  list: (): Promise<Agent[]> => api.get('/agents').then((r) => r.data),
  get: (id: string): Promise<Agent> => api.get(`/agents/${id}`).then((r) => r.data),
  create: (p: UpsertAgentPayload): Promise<Agent> => api.post('/agents', p).then((r) => r.data),
  update: (id: string, p: UpsertAgentPayload): Promise<Agent> => api.put(`/agents/${id}`, p).then((r) => r.data),
  remove: (id: string): Promise<void> => api.delete(`/agents/${id}`).then((r) => r.data),
};

export const agentTeamsApi = {
  list: (): Promise<AgentTeam[]> => api.get('/agent-teams').then((r) => r.data),
  get: (id: string): Promise<AgentTeam> => api.get(`/agent-teams/${id}`).then((r) => r.data),
  create: (p: UpsertTeamPayload): Promise<AgentTeam> => api.post('/agent-teams', p).then((r) => r.data),
  update: (id: string, p: UpsertTeamPayload): Promise<AgentTeam> => api.put(`/agent-teams/${id}`, p).then((r) => r.data),
  remove: (id: string): Promise<void> => api.delete(`/agent-teams/${id}`).then((r) => r.data),
  setMembers: (id: string, members: MemberInput[]): Promise<AgentTeamMember[]> =>
    api.put(`/agent-teams/${id}/members`, { members }).then((r) => r.data),
};
