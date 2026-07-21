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
};
