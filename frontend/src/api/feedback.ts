import api from './client';

export type FeedbackRating = 'up' | 'down';
export type FeedbackScope = 'personal' | 'shared';

export interface Feedback {
  id:         string;
  messageId:  string;
  userId:     string;
  rating:     FeedbackRating;
  comment:    string | null;
  question:   string | null;
  answer:     string | null;
  scope:      FeedbackScope;
  isApproved: boolean;
  createdAt:  string;
}

export interface FeedbackConfig {
  enabled:         boolean;
  vectorAvailable: boolean;
}

export const feedbackApi = {
  getConfig: () =>
    api.get<FeedbackConfig>('/feedback/config').then((r) => r.data),

  setEnabled: (enabled: boolean) =>
    api.patch<FeedbackConfig>('/feedback/config', { enabled }).then((r) => r.data),

  submit: (data: { messageId: string; rating: FeedbackRating; comment?: string; scope?: FeedbackScope }) =>
    api.post<Feedback>('/feedback', data).then((r) => r.data),

  listForChat: (chatId: string) =>
    api.get<Feedback[]>(`/feedback/chat/${chatId}`).then((r) => r.data),

  list: () =>
    api.get<Feedback[]>('/feedback').then((r) => r.data),

  approve: (id: string, approved: boolean) =>
    api.patch<Feedback>(`/feedback/${id}/approve`, { approved }).then((r) => r.data),

  setScope: (id: string, scope: FeedbackScope) =>
    api.patch<Feedback>(`/feedback/${id}/scope`, { scope }).then((r) => r.data),

  remove: (id: string) =>
    api.delete(`/feedback/${id}`).then((r) => r.data),
};
