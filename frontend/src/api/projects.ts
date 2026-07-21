import api from './client';
import type { Project } from '../store/useStore';

export type ProjectTeamRole = 'collaborator' | 'viewer';

/** Assegnazione di un team a un progetto condiviso. */
export interface ProjectTeam {
  id:        string;
  projectId: string;
  teamId:    string;
  role:      ProjectTeamRole;
  addedAt:   string;
  team?: { id: string; name: string; description: string | null; color: string | null };
}

export const projectsApi = {
  list: () => api.get<Project[]>('/projects').then((r) => r.data),
  get: (id: string) => api.get<Project>(`/projects/${id}`).then((r) => r.data),
  create: (data: { name: string; description?: string; color?: string; systemPrompt?: string | null }) =>
    api.post<Project>('/projects', data).then((r) => r.data),
  update: (id: string, data: Partial<Project>) =>
    api.put<Project>(`/projects/${id}`, data).then((r) => r.data),
  delete: (id: string) => api.delete(`/projects/${id}`).then((r) => r.data),

  // ── Condivisione con i team ──
  listTeams: (id: string) =>
    api.get<ProjectTeam[]>(`/projects/${id}/teams`).then((r) => r.data),
  addTeam: (id: string, teamId: string, role: ProjectTeamRole = 'collaborator') =>
    api.post<ProjectTeam>(`/projects/${id}/teams`, { teamId, role }).then((r) => r.data),
  setTeamRole: (id: string, teamId: string, role: ProjectTeamRole) =>
    api.patch<ProjectTeam>(`/projects/${id}/teams/${teamId}`, { role }).then((r) => r.data),
  removeTeam: (id: string, teamId: string) =>
    api.delete<void>(`/projects/${id}/teams/${teamId}`).then((r) => r.data),
};
