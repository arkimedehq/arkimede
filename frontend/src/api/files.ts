import api from './client';
import { downloadWithAuth } from '../utils/downloadWithAuth';

/** Scope of an indexed document: universal (company) | project | personal. */
export type DocScope = 'universal' | 'project' | 'personal';

/** File access scope (C2): personal | team | organization. */
export type FileScope = 'personal' | 'team' | 'org';

export interface FileRecord {
  id: string;
  originalName: string;
  mimeType: string;
  size: number;
  vectorized: boolean;
  /** Name of the vector collection the file was indexed into, if vectorized=true */
  vectorCollectionId?: string;
  projectId?: string;
  scope?: FileScope;
  teamId?: string | null;
  /** Relative path for the download (?rel=), populated by the search. */
  rel?: string | null;
  createdAt: string;
}

export const filesApi = {
  list: (opts?: { projectId?: string; chatId?: string }) =>
    api.get<FileRecord[]>('/files', { params: opts ?? {} }).then((r) => r.data),

  search: (q?: string, limit?: number) =>
    api.get<FileRecord[]>('/files/search', { params: { q: q ?? '', limit: limit ?? 50 } }).then((r) => r.data),

  upload: (file: File, opts?: { projectId?: string; scope?: FileScope; teamId?: string }) => {
    const form = new FormData();
    form.append('file', file);
    return api.post<FileRecord>(
      '/files/upload',
      form,
      {
        params: {
          ...(opts?.projectId ? { projectId: opts.projectId } : {}),
          ...(opts?.scope ? { scope: opts.scope } : {}),
          ...(opts?.teamId ? { teamId: opts.teamId } : {}),
        },
        headers: { 'Content-Type': 'multipart/form-data' },
      },
    ).then((r) => r.data);
  },

  setScope: (id: string, scope: FileScope, teamId?: string | null) =>
    api.patch<FileRecord>(`/files/${id}/scope`, { scope, teamId: teamId ?? null }).then((r) => r.data),

  ingest: (fileId: string, opts: { scope: DocScope; collection?: string; projectId?: string }) =>
    api.post(`/embed/${fileId}`, {
      scope: opts.scope,
      ...(opts.collection ? { collection: opts.collection } : {}),
      ...(opts.scope === 'project' && opts.projectId ? { projectId: opts.projectId } : {}),
    }).then((r) => r.data),

  listCollections: () =>
    api.get<string[]>('/embed/collections').then((r) => r.data),

  download: (fileId: string, filename?: string) =>
    downloadWithAuth(`/files/${fileId}/download`, filename),

  delete: (fileId: string) => api.delete(`/files/${fileId}`).then((r) => r.data),

  formatSize: (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  },
};
