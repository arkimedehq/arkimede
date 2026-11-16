// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import api from './client';

export type UserRole = 'admin' | 'user';
export type UserStatus = 'active' | 'disabled';

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ListUsersResult {
  items: AdminUser[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ListUsersParams {
  search?: string;
  role?: UserRole;
  status?: UserStatus;
  page?: number;
  pageSize?: number;
}

export interface CreateUserPayload {
  email: string;
  name: string;
  password: string;
  role?: UserRole;
}

export const adminUsersApi = {
  list: (params: ListUsersParams = {}) =>
    api.get<ListUsersResult>('/admin/users', { params }).then((r) => r.data),

  /** Every user, page after page (the backend serves at most 100 a page): for pickers that list them all. */
  listAll: async (): Promise<AdminUser[]> => {
    const all: AdminUser[] = [];
    for (let page = 1; ; page++) {
      const r = await adminUsersApi.list({ page, pageSize: 100 });
      all.push(...r.items);
      if (!r.items.length || all.length >= r.total) return all;
    }
  },

  get: (id: string) => api.get<AdminUser>(`/admin/users/${id}`).then((r) => r.data),

  create: (payload: CreateUserPayload) =>
    api.post<AdminUser>('/admin/users', payload).then((r) => r.data),

  update: (id: string, payload: { name?: string; email?: string }) =>
    api.patch<AdminUser>(`/admin/users/${id}`, payload).then((r) => r.data),

  setRole: (id: string, role: UserRole) =>
    api.patch<AdminUser>(`/admin/users/${id}/role`, { role }).then((r) => r.data),

  setStatus: (id: string, status: UserStatus) =>
    api.patch<AdminUser>(`/admin/users/${id}/status`, { status }).then((r) => r.data),

  resetPassword: (id: string, newPassword: string) =>
    api.post<void>(`/admin/users/${id}/reset-password`, { newPassword }).then((r) => r.data),

  remove: (id: string) => api.delete<void>(`/admin/users/${id}`).then((r) => r.data),

  /** A user's memory and voice agent (a service account has nobody to sign in and set them). */
  memory: (id: string) => api.get<UserMemorySettings>(`/admin/users/${id}/memory`).then((r) => r.data),
  setMemory: (id: string, patch: Partial<Pick<UserMemorySettings, 'autoMemoryEnabled' | 'sharedMemoryEnabled' | 'episodicMemoryEnabled' | 'episodicMemoryMode' | 'voiceAgentId'>>) =>
    api.patch<UserMemorySettings>(`/admin/users/${id}/memory`, patch).then((r) => r.data),
};

export interface UserMemorySettings {
  autoMemoryEnabled: boolean;
  sharedMemoryEnabled: boolean;
  episodicMemoryEnabled: boolean;
  episodicMemoryAvailable?: boolean;
  episodicMemoryStatus?: 'off' | 'active' | 'unknown';
  episodicMemoryMode?: 'personal' | 'entity' | null;
  /** The agent of the user's voice turns (null: the standard pipeline), and the ones they can pick. */
  voiceAgentId: string | null;
  voiceAgents: Array<{ id: string; name: string }>;
}
