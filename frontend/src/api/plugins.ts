// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import api from './client';

export type PluginStatus = 'pending_approval' | 'active' | 'disabled' | 'error';
export type PluginScope = 'personal' | 'team' | 'org';
export type TrustLevel = 'official' | 'verified' | 'community' | 'unsigned';
/** Personal: uses one person's account, data or memory — only ever the owner's copy. Shared: may serve a team or the org. */
export type PluginAudience = 'personal' | 'shared';

export interface PluginPermissions {
  services: string[];
  subscribes: string[];
  network: string[];
  daemons: string[];
  routes: string[];
  pages: string[];
  storageKb: number;
}

export interface PluginView {
  id: string;
  name: string;
  version: string;
  contract: number;
  label: string;
  description: string;
  status: PluginStatus;
  statusDetail: string | null;
  scope: PluginScope;
  teamId: string | null;
  agentId: string | null;
  ownerId: string;
  audience: PluginAudience;
  trust: TrustLevel;
  signedBy: string | null;
  sha256: string;
  grants: PluginPermissions | null;
  pending: boolean;
  approvedAt: string | null;
  updatedAt: string;
}

export interface PluginSettingView {
  key: string;
  description?: string;
  required: boolean;
  secret: boolean;
  value: string | null;
  set: boolean;
}

export interface PluginIdentity {
  id: string;
  externalId: string;
  displayName: string | null;
  userId: string | null;
  authorized: boolean;
  /** The Home Assistant person linked to the id (an account's own wins). */
  haPerson: string | null;
}

/** One of the people a plugin knows (its people script). */
export interface KnownPerson { id: string; name: string | null; lastSeen: string | null }

export interface PluginDetail {
  plugin: PluginView;
  manifest: Record<string, any>;
  permissions: PluginPermissions;
  newPermissions: string[];
  contents: {
    skills: Array<{ id: string; name: string; status: string }>;
    mcp: Array<{ id: string; name: string }>;
    flows: Array<{ id: string; name: string; enabled: boolean }>;
  };
  settings: PluginSettingView[];
  identities: PluginIdentity[];
}

export interface PluginEventRow {
  id: string;
  eventId: string;
  type: string;
  at: string;
  outcome: 'accepted' | 'duplicate' | 'invalid' | 'rate_limited';
  detail: string | null;
  createdAt: string;
}

export interface PluginTrust {
  allowUnsigned: boolean;
  keys: Array<{ id: string | null; keyId: string; level: string; publicKey: string; official: boolean }>;
}

export interface RegistryPlugin {
  name: string;
  version: string;
  label?: string;
  description?: string;
  author?: string;
  homepage?: string;
  audience?: PluginAudience;
}

export interface PluginPages {
  name: string;
  label: string;
  pages: Array<{ id: string; title: string }>;
}

export interface AccessPayload {
  scope?: PluginScope;
  teamId?: string | null;
  agentId?: string | null;
}

/** An API path (`/api/…`) as a URL the browser can load, whatever the API base is. */
export function apiUrl(path: string): string {
  const base = String(api.defaults.baseURL ?? '/api').replace(/\/$/, '');
  return path.startsWith('/api/') ? `${base}${path.slice(4)}` : path;
}

const ROUTE_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/**
 * A plugin route's path as a page may ask for it: plain segments only. A `..`, `.`, an encoded slash or dot, a query
 * or a fragment could make the browser resolve the request outside the plugin's routes, with the user's credentials.
 */
export function safeRoutePath(path: unknown): string | null {
  if (typeof path !== 'string' || !path || path.length > 1000) return null;
  const clean = path.replace(/^\/+/, '');
  if (!/^[A-Za-z0-9_.:~-]+(\/[A-Za-z0-9_.:~-]+)*$/.test(clean)) return null;
  return clean.split('/').some((seg) => seg === '.' || seg === '..') ? null : clean;
}

export const pluginsApi = {
  // ── any user ──
  pages: () => api.get<PluginPages[]>('/plugins/pages').then((r) => r.data),
  pageUrl: (name: string, page: string) =>
    api.get<{ url: string; title: string }>(`/plugins/${encodeURIComponent(name)}/pages/${encodeURIComponent(page)}/url`).then((r) => r.data),
  /** A request to a plugin route, as the user (the bridge of a plugin page). */
  route: async (name: string, method: string, path: string, body?: unknown, query?: Record<string, string>) => {
    const verb = String(method).toUpperCase();
    const clean = safeRoutePath(path);
    if (!ROUTE_METHODS.includes(verb) || !clean) return { status: 400, body: { error: 'Invalid method or path' } };
    const r = await api.request({
      method: verb, url: `/plugins/${encodeURIComponent(name)}/routes/${clean}`, data: body, params: query, validateStatus: () => true,
    });
    return { status: r.status, body: r.data };
  },

  // ── installs: an admin sees and manages every copy, a user their own; trust, approval and sharing are the admin's ──
  list: () => api.get<PluginView[]>('/plugin-installs').then((r) => r.data),
  get: (id: string) => api.get<PluginDetail>(`/plugin-installs/${id}`).then((r) => r.data),
  events: (id: string) => api.get<PluginEventRow[]>(`/plugin-installs/${id}/events`).then((r) => r.data),
  /** `forUserId`: an admin installs the copy of that user. */
  upload: (file: File, signature?: string, forUserId?: string | null) => {
    const form = new FormData();
    form.append('file', file);
    if (signature?.trim()) form.append('signature', signature.trim());
    if (forUserId) form.append('forUserId', forUserId);
    return api.post<PluginDetail>('/plugin-installs/upload', form).then((r) => r.data);
  },
  /** Updates (or reinstalls) this copy from a package of the same plugin: its settings and people stay. */
  update: (id: string, file: File, signature?: string) => {
    const form = new FormData();
    form.append('file', file);
    if (signature?.trim()) form.append('signature', signature.trim());
    return api.post<PluginDetail>(`/plugin-installs/${id}/upload`, form).then((r) => r.data);
  },
  registry: (refresh = false) => api.get<RegistryPlugin[]>('/plugin-installs/registry', { params: refresh ? { refresh: 1 } : {} }).then((r) => r.data),
  installFromRegistry: (name: string, forUserId?: string | null) =>
    api.post('/plugin-installs/registry/install', { name, ...(forUserId ? { forUserId } : {}) }).then((r) => r.data),
  approve: (id: string, p: AccessPayload) => api.post<PluginView>(`/plugin-installs/${id}/approve`, p).then((r) => r.data),
  reject: (id: string) => api.post(`/plugin-installs/${id}/reject`),
  enable: (id: string) => api.post<PluginView>(`/plugin-installs/${id}/enable`).then((r) => r.data),
  disable: (id: string) => api.post<PluginView>(`/plugin-installs/${id}/disable`).then((r) => r.data),
  setAccess: (id: string, p: AccessPayload) => api.put<PluginView>(`/plugin-installs/${id}/access`, p).then((r) => r.data),
  setSettings: (id: string, values: Record<string, string>) =>
    api.put<PluginSettingView[]>(`/plugin-installs/${id}/settings`, { values }).then((r) => r.data),
  setIdentity: (id: string, p: { externalId: string; userId?: string | null; authorized?: boolean; displayName?: string | null; haPerson?: string | null }) =>
    api.put<PluginIdentity>(`/plugin-installs/${id}/identities`, p).then((r) => r.data),
  /** The people the plugin knows, to pick one; `available: false` → ids typed by hand. */
  knownPeople: (id: string, refresh = false) =>
    api.get<{ available: boolean; people: KnownPerson[] }>(`/plugin-installs/${id}/known-people`, { params: refresh ? { refresh: 1 } : {} }).then((r) => r.data),
  removeIdentity: (id: string, identityId: string) => api.delete(`/plugin-installs/${id}/identities/${identityId}`),
  uninstall: (id: string) => api.delete(`/plugin-installs/${id}`),
  trust: () => api.get<PluginTrust>('/plugin-installs/trust').then((r) => r.data),
  setAllowUnsigned: (allowUnsigned: boolean) => api.put<PluginTrust>('/plugin-installs/trust/unsigned', { allowUnsigned }).then((r) => r.data),
  addKey: (p: { keyId: string; level: 'verified' | 'community'; publicKey: string }) =>
    api.post<PluginTrust>('/plugin-installs/trust/keys', p).then((r) => r.data),
  removeKey: (id: string) => api.delete<PluginTrust>(`/plugin-installs/trust/keys/${id}`).then((r) => r.data),
};
