// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

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

// ── Scheduled host backups (scripts/backup.sh on the host; settings + state here) ──

export type HostBackupNetworkType = 'smb' | 'sftp' | 'webdav';
export type HostBackupDestType = 'local' | HostBackupNetworkType;

export interface HostBackupDestination {
  type?: HostBackupNetworkType;
  host: string;
  port?: number | null;
  share?: string | null;
  path?: string | null;
  domain?: string | null;
  username: string;
  password?: string; // write-only: empty keeps the stored one
  secure?: boolean | null;
}

export interface HostBackupRun {
  id: string;
  kind: 'daily' | 'base' | 'alert';
  status: string; // ok | failed | running; for alerts, the subject
  startedAt: string;
  finishedAt: string | null;
  sizeBytes: number | null;
  location: string | null;
  message: string | null;
}

export interface HostBackupStatus {
  settings: {
    schedule: string; // cron expression, host local time
    keepDaily: number;
    keepBase: number;
    baseWeekday: number;
    walArchiving: boolean;
    destType: HostBackupDestType;
    destination: HostBackupDestination | null;
    hasPassword: boolean;
  };
  state: {
    destResolved: string | null;
    destReachable: boolean | null;
    destCheckedAt: string | null;
    walAppliedMode: string | null;
    walShippedAt: string | null;
    walLastSegment: string | null;
    walSpoolBytes: number | null;
    walGapSegment: string | null;
    archiver: {
      archiveMode: string;
      archivedCount: number;
      lastArchivedWal: string | null;
      lastArchivedTime: string | null;
      failedCount: number;
      lastFailedWal: string | null;
      lastFailedTime: string | null;
    } | null;
    lastDaily: HostBackupRun | null;
    lastBase: HostBackupRun | null;
    alertWebhookConfigured: boolean;
  };
  runs: HostBackupRun[];
}

export interface HostBackupUpdate {
  schedule?: string;
  keepDaily?: number;
  keepBase?: number;
  baseWeekday?: number;
  walArchiving?: boolean;
  destType?: HostBackupDestType;
  destination?: HostBackupDestination;
}

export const hostBackupApi = {
  status: () => api.get<HostBackupStatus>('/admin/backup/host').then((r) => r.data),
  update: (dto: HostBackupUpdate) => api.patch<HostBackupStatus>('/admin/backup/host', dto).then((r) => r.data),
  test: (type: HostBackupNetworkType, destination: HostBackupDestination) =>
    api.post<{ ok: boolean; stage?: 'connect' | 'write'; error?: string; label?: string }>(
      '/admin/backup/host/test', { type, destination },
    ).then((r) => r.data),
};
