// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { api } from './client';

/** Long-lived opaque API key (row view — the secret exists only at creation). */
export interface ApiKeyRow {
  id: string;
  userId: string;
  name: string;
  /** Identification prefix, e.g. "ak_3fk9aB". */
  prefix: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

/** Create response: `key` is the CLEAR credential, shown once. */
export interface ApiKeyCreated {
  key: string;
  row: ApiKeyRow;
}

export const apiKeysApi = {
  /** Own keys (no secrets). */
  list: () => api.get<ApiKeyRow[]>('/api-keys').then((r) => r.data),

  /** Create a key for yourself; expiresInDays omit/0 = never expires. */
  create: (name: string, expiresInDays?: number) =>
    api.post<ApiKeyCreated>('/api-keys', { name, expiresInDays }).then((r) => r.data),

  /** [Admin] Keys of another user. */
  listForUser: (userId: string) =>
    api.get<ApiKeyRow[]>(`/api-keys/user/${userId}`).then((r) => r.data),

  /** [Admin] Create a key for any user (service accounts). */
  createForUser: (userId: string, name: string, expiresInDays?: number) =>
    api.post<ApiKeyCreated>('/api-keys/admin', { userId, name, expiresInDays }).then((r) => r.data),

  /** Revoke (owner or admin). */
  revoke: (id: string) => api.delete(`/api-keys/${id}`),
};
