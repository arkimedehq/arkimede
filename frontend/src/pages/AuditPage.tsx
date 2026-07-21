import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { ShieldAlert, RefreshCw } from 'lucide-react';
import { auditApi, type AuditEntry } from '../api/audit';

const OUTCOME_STYLE: Record<string, string> = {
  ok:     'bg-emerald-500/15 text-emerald-400 border-emerald-700/40',
  denied: 'bg-amber-500/15 text-amber-400 border-amber-700/40',
  error:  'bg-red-500/15 text-red-400 border-red-700/40',
};

/** Admin section: viewer for audit events (E4). */
export function AuditSection() {
  const { t } = useTranslation('audit');
  const [outcome, setOutcome] = useState<string>('');

  const { data: entries = [], isLoading, refetch, isFetching } = useQuery({
    queryKey: ['audit', outcome],
    queryFn:  () => auditApi.list({ outcome: outcome || undefined, limit: 200 }),
    staleTime: 10_000,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldAlert size={18} className="text-indigo-400" />
          <h2 className="text-lg font-semibold text-white">{t('title')}</h2>
        </div>
        <button
          onClick={() => refetch()}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-700 text-gray-300 hover:border-indigo-500/50"
        >
          <RefreshCw size={12} className={isFetching ? 'animate-spin' : ''} /> {t('refresh')}
        </button>
      </div>

      <p className="text-xs text-gray-500">{t('description')}</p>

      <div className="flex gap-2">
        {['', 'ok', 'denied', 'error'].map((o) => (
          <button
            key={o || 'all'}
            onClick={() => setOutcome(o)}
            className={`px-3 py-1 rounded-lg text-xs font-medium border transition-colors
              ${outcome === o ? 'bg-indigo-500/15 border-indigo-600/50 text-indigo-300' : 'border-gray-700 text-gray-400 hover:text-gray-200'}`}
          >
            {o === '' ? t('filters.all') : t(`outcomes.${o}`, { defaultValue: o })}
          </button>
        ))}
      </div>

      {isLoading ? (
        <p className="text-sm text-gray-500">{t('common:actions.loading')}</p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-gray-500">{t('empty')}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-800">
          <table className="w-full text-sm">
            <thead className="bg-gray-900/60 text-gray-400 text-xs">
              <tr>
                <th className="text-left px-3 py-2 font-medium">{t('table.when')}</th>
                <th className="text-left px-3 py-2 font-medium">{t('table.action')}</th>
                <th className="text-left px-3 py-2 font-medium">{t('table.outcome')}</th>
                <th className="text-left px-3 py-2 font-medium">{t('table.resource')}</th>
                <th className="text-left px-3 py-2 font-medium">{t('table.actor')}</th>
                <th className="text-left px-3 py-2 font-medium">{t('table.context')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {entries.map((e: AuditEntry) => (
                <tr key={e.id} className="text-gray-300">
                  <td className="px-3 py-2 whitespace-nowrap text-xs text-gray-500">
                    {new Date(e.createdAt).toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-xs" title={e.action}>
                    {t(`actions.${e.action}`, { defaultValue: e.action })}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`px-2 py-0.5 rounded text-xs border ${OUTCOME_STYLE[e.outcome] ?? 'border-gray-700 text-gray-400'}`}>
                      {t(`outcomes.${e.outcome}`, { defaultValue: e.outcome })}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs max-w-[220px] truncate" title={e.resource ?? ''}>{e.resource ?? '—'}</td>
                  <td className="px-3 py-2 text-xs text-gray-500">{e.actorName ?? e.actorId?.slice(0, 8) ?? t('systemActor')}</td>
                  <td className="px-3 py-2 text-xs text-gray-500 max-w-[260px] truncate" title={e.ctx ? JSON.stringify(e.ctx) : ''}>
                    {e.ctx ? JSON.stringify(e.ctx) : '—'}
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
