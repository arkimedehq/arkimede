import api from './client';
import type { Chat } from '../store/useStore';

export const chatsApi = {
  list: (projectId?: string) =>
    api.get<Chat[]>('/chats', { params: projectId ? { projectId } : {} }).then((r) => r.data),
  get: (id: string) => api.get<Chat>(`/chats/${id}`).then((r) => r.data),
  create: (data: { title?: string; projectId?: string }) =>
    api.post<Chat>('/chats', data).then((r) => r.data),
  updateTitle: (id: string, title: string) =>
    api.patch<Chat>(`/chats/${id}/title`, { title }).then((r) => r.data),
  setAgentTeam: (id: string, agentTeamId: string | null) =>
    api.patch<Chat>(`/chats/${id}/agent-team`, { agentTeamId }).then((r) => r.data),
  markRead: (id: string) => api.patch(`/chats/${id}/read`).then((r) => r.data),
  delete: (id: string) => api.delete(`/chats/${id}`).then((r) => r.data),
};
