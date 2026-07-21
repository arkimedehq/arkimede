import api from './client';

export type TeamRole = 'owner' | 'member';

export interface Team {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TeamWithCount extends Team {
  memberCount: number;
}

export interface TeamMembership {
  id: string;
  teamId: string;
  userId: string;
  role: TeamRole;
  createdAt: string;
  user?: { id: string; name: string; email: string };
}

export interface CreateTeamPayload {
  name: string;
  description?: string | null;
  color?: string | null;
}

export const teamsApi = {
  /** The current user's teams (for the scope selectors). */
  mine: () => api.get<Team[]>('/teams/mine').then((r) => r.data),

  // ── admin ──
  list: () => api.get<TeamWithCount[]>('/teams').then((r) => r.data),
  get: (id: string) => api.get<Team>(`/teams/${id}`).then((r) => r.data),
  create: (payload: CreateTeamPayload) => api.post<Team>('/teams', payload).then((r) => r.data),
  update: (id: string, payload: Partial<CreateTeamPayload>) =>
    api.patch<Team>(`/teams/${id}`, payload).then((r) => r.data),
  remove: (id: string) => api.delete<void>(`/teams/${id}`).then((r) => r.data),

  members: (id: string) => api.get<TeamMembership[]>(`/teams/${id}/members`).then((r) => r.data),
  addMember: (id: string, userId: string, role: TeamRole = 'member') =>
    api.post<TeamMembership>(`/teams/${id}/members`, { userId, role }).then((r) => r.data),
  setMemberRole: (id: string, userId: string, role: TeamRole) =>
    api.patch<TeamMembership>(`/teams/${id}/members/${userId}`, { role }).then((r) => r.data),
  removeMember: (id: string, userId: string) =>
    api.delete<void>(`/teams/${id}/members/${userId}`).then((r) => r.data),
};
