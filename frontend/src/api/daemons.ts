import api from './client';

// ── Types ─────────────────────────────────────────────────────────────────────

export type DaemonStatus = 'starting' | 'running' | 'stopped' | 'error';

export interface SkillDaemon {
  id:             string;
  userId:         string;
  skillId:        string;
  scriptFilename: string;
  status:         DaemonStatus;
  pid:            number | null;
  startedAt:      string | null;
  lastEventAt:    string | null;
  lastError:      string | null;
  createdAt:      string;
  updatedAt:      string;
  skill?: {
    id:          string;
    name:        string;
    description: string;
  };
}

export interface StartDaemonPayload {
  skillId:        string;
  scriptFilename: string;
}

// ── API client ────────────────────────────────────────────────────────────────

export const daemonsApi = {
  /** List the current user's daemons */
  list: () =>
    api.get<SkillDaemon[]>('/daemons').then((r) => r.data),

  /** Single daemon detail */
  getById: (id: string) =>
    api.get<SkillDaemon>(`/daemons/${id}`).then((r) => r.data),

  /** Start a new daemon */
  start: (payload: StartDaemonPayload) =>
    api.post<SkillDaemon>('/daemons', payload).then((r) => r.data),

  /** Stop a daemon (status → stopped) */
  stop: (id: string) =>
    api.delete<SkillDaemon>(`/daemons/${id}`).then((r) => r.data),

  /** Restart a daemon */
  restart: (id: string) =>
    api.post<SkillDaemon>(`/daemons/${id}/restart`).then((r) => r.data),

  /** Delete the record (only if stopped or error) */
  remove: (id: string) =>
    api.delete<void>(`/daemons/${id}/record`).then((r) => r.data),
};
