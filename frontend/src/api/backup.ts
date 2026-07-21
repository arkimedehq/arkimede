import { api } from './client';

export interface BackupInfo {
  id: string; // archive filename, also the download/delete key
  size: number; // bytes
  createdAt: string; // ISO
}

export const backupApi = {
  list: () => api.get<BackupInfo[]>('/admin/backup').then((r) => r.data),

  create: () => api.post<BackupInfo>('/admin/backup').then((r) => r.data),

  remove: (id: string) =>
    api.delete(`/admin/backup/${encodeURIComponent(id)}`).then((r) => r.data),

  /** Streams the archive (auth-protected) and triggers a browser download. */
  download: async (id: string) => {
    const res = await api.get(`/admin/backup/${encodeURIComponent(id)}/download`, {
      responseType: 'blob',
    });
    const url = URL.createObjectURL(res.data as Blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = id;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
};
