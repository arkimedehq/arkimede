import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Archive, DatabaseBackup, Download, Trash2, Loader2, Plus } from 'lucide-react';
import { backupApi, type BackupInfo } from '../api/backup';

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

/** Admin section: create / download / delete platform backups. */
export function BackupSection() {
  const { t } = useTranslation('backup');
  const qc = useQueryClient();
  const [downloading, setDownloading] = useState<string | null>(null);

  const { data: backups = [], isLoading } = useQuery({
    queryKey: ['backups'],
    queryFn: backupApi.list,
    staleTime: 10_000,
  });

  const createMut = useMutation({
    mutationFn: backupApi.create,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['backups'] }),
  });

  const removeMut = useMutation({
    mutationFn: backupApi.remove,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['backups'] }),
  });

  const handleDownload = async (b: BackupInfo) => {
    setDownloading(b.id);
    try {
      await backupApi.download(b.id);
    } finally {
      setDownloading(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <DatabaseBackup size={18} className="text-indigo-400" />
          <h2 className="text-lg font-semibold text-white">{t('title')}</h2>
        </div>
        <button
          onClick={() => createMut.mutate()}
          disabled={createMut.isPending}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
            bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors"
        >
          {createMut.isPending
            ? <><Loader2 size={13} className="animate-spin" /> {t('creating')}</>
            : <><Plus size={13} /> {t('create')}</>}
        </button>
      </div>

      <p className="text-xs text-gray-500">{t('description')}</p>
      <p className="text-xs text-gray-600">{t('note')}</p>

      {createMut.isError && (
        <p className="text-sm text-red-400">{t('createError')}</p>
      )}

      {isLoading ? (
        <p className="text-sm text-gray-500">{t('loading')}</p>
      ) : backups.length === 0 ? (
        <p className="text-sm text-gray-500">{t('empty')}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 border-b border-gray-800">
                <th className="px-4 py-2 font-medium">{t('columns.name')}</th>
                <th className="px-4 py-2 font-medium">{t('columns.size')}</th>
                <th className="px-4 py-2 font-medium">{t('columns.date')}</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {backups.map((b) => (
                <tr key={b.id} className="border-b border-gray-800/60 last:border-0 text-gray-300">
                  <td className="px-4 py-2.5">
                    <span className="inline-flex items-center gap-2">
                      <Archive size={14} className="text-gray-500 flex-shrink-0" />
                      <span className="font-mono text-xs break-all">{b.id}</span>
                    </span>
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-gray-400">{humanSize(b.size)}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap text-gray-400">
                    {new Date(b.createdAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center justify-end gap-1.5">
                      <button
                        onClick={() => handleDownload(b)}
                        disabled={downloading === b.id}
                        title={t('download')}
                        className="p-1.5 rounded-md text-gray-400 hover:text-indigo-300 hover:bg-gray-800 disabled:opacity-50"
                      >
                        {downloading === b.id
                          ? <Loader2 size={14} className="animate-spin" />
                          : <Download size={14} />}
                      </button>
                      <button
                        onClick={() => {
                          if (window.confirm(t('deleteConfirm'))) removeMut.mutate(b.id);
                        }}
                        disabled={removeMut.isPending}
                        title={t('delete')}
                        className="p-1.5 rounded-md text-gray-400 hover:text-red-400 hover:bg-gray-800 disabled:opacity-50"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
