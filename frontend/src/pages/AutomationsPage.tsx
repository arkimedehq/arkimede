import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Trash2, Loader2, X, CheckCircle2, XCircle, Clock, Play } from 'lucide-react';
import { scheduledTasksApi, type ScheduledTask } from '../api/scheduledTasks';

/**
 * "Automations" section: the tasks scheduled by the user (also from the chat
 * via the schedule_task tool). See Auto-Scheduling in PROJECT.md.
 */
export function AutomationsSection() {
  const { t } = useTranslation('automations');
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const query = useQuery({ queryKey: ['scheduled-tasks'], queryFn: scheduledTasksApi.list, staleTime: 5_000 });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['scheduled-tasks'] });

  const toggleM = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => scheduledTasksApi.setEnabled(id, enabled),
    onSuccess: invalidate,
    onError: (e: any) => setErr(e?.response?.data?.message ?? t('errors.operationFailed')),
  });
  const removeM = useMutation({
    mutationFn: (id: string) => scheduledTasksApi.remove(id),
    onSuccess: invalidate,
    onError: (e: any) => setErr(e?.response?.data?.message ?? t('errors.deleteFailed')),
  });
  const activateM = useMutation({
    mutationFn: (id: string) => scheduledTasksApi.activate(id),
    onSuccess: invalidate,
    onError: (e: any) => setErr(e?.response?.data?.message ?? t('errors.activationFailed')),
  });
  // "Run now": the run is asynchronous (same worker as a scheduled fire) — the outcome
  // arrives as a notification and in chat, so here we only confirm it was started.
  const runM = useMutation({
    mutationFn: (id: string) => scheduledTasksApi.runNow(id),
    onSuccess: () => { setErr(null); setInfo(t('info.runStarted')); invalidate(); },
    onError: (e: any) => setErr(e?.response?.data?.message ?? t('errors.runFailed')),
  });

  const tasks = query.data ?? [];
  const when = (task: ScheduledTask) =>
    task.scheduleType === 'cron'
      ? `cron ${task.cron}`
      : t('schedule.once', { datetime: task.runAt ? new Date(task.runAt).toLocaleString() : '—' });

  return (
    <div>
      <div className="flex items-center gap-3 mb-5">
        <div className="w-9 h-9 rounded-lg bg-gray-800 flex items-center justify-center text-gray-300"><CalendarClock size={18} /></div>
        <div>
          <h2 className="text-lg font-semibold text-white">{t('heading')}</h2>
          <p className="text-sm text-gray-500">{t('subheading')}</p>
        </div>
      </div>

      {err && (
        <div className="flex items-center justify-between gap-3 bg-red-950/50 border border-red-900 text-red-300 text-sm rounded-lg px-3 py-2 mb-3">
          <span>{err}</span><button onClick={() => setErr(null)}><X size={14} /></button>
        </div>
      )}

      {info && (
        <div className="flex items-center justify-between gap-3 bg-indigo-950/50 border border-indigo-900 text-indigo-300 text-sm rounded-lg px-3 py-2 mb-3">
          <span>{info}</span><button onClick={() => setInfo(null)}><X size={14} /></button>
        </div>
      )}

      {query.isLoading ? (
        <div className="text-center py-10 text-gray-500"><Loader2 className="animate-spin inline" size={18} /></div>
      ) : tasks.length === 0 ? (
        <div className="text-center py-10 text-gray-500 border border-dashed border-gray-800 rounded-xl">
          {t('empty')}
        </div>
      ) : (
        <div className="space-y-3">
          {tasks.map((task) => (
            <div key={task.id} className="border border-gray-800 rounded-xl p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-medium text-gray-100 truncate flex items-center gap-2">
                    {task.status === 'done' ? <CheckCircle2 size={14} className="text-emerald-400" />
                      : task.status === 'error' ? <XCircle size={14} className="text-red-400" />
                      : task.status === 'pending' ? <Clock size={14} className="text-amber-400" />
                      : <Clock size={14} className="text-indigo-400" />}
                    {task.title || task.instruction.slice(0, 60)}
                    {task.status === 'pending' && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-300">{t('badge.pending')}</span>}
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {when(task)} · {task.status}{task.lastRunAt ? ` · ${t('info.lastRun', { datetime: new Date(task.lastRunAt).toLocaleString() })}` : ''}
                    {(task.lastInputTokens != null || task.lastOutputTokens != null) && (
                      <span className="text-gray-600"> · {task.lastInputTokens ?? 0}→{task.lastOutputTokens ?? 0} token</span>
                    )}
                    {task.totalTokens > 0 && <span className="text-gray-600"> · {t('info.totalTokens', { count: task.totalTokens.toLocaleString() })}</span>}
                    <span className="text-gray-600"> · {t('info.toolLabel')}: {task.toolFilter?.mode === 'none' || !task.toolFilter ? t('info.toolNone') : task.toolFilter.mode === 'all' ? t('info.toolAll') : (task.toolFilter.names ?? []).join(', ') || '—'}</span>
                  </div>
                  {/* bg-gray-800/50, not gray-900/40: only some opacity steps are remapped
                      in the light theme, the others stay dark (see index.css). */}
                  {task.lastResult && (
                    <pre className="text-[11px] text-gray-400 mt-2 whitespace-pre-wrap break-words max-h-24 overflow-y-auto border border-gray-800 rounded p-2 bg-gray-800/50">{task.lastResult}</pre>
                  )}
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                  <button title={t('actions.runNow')} className="text-gray-500 hover:text-indigo-400 disabled:opacity-50"
                    disabled={runM.isPending && runM.variables === task.id}
                    onClick={() => runM.mutate(task.id)}>
                    {runM.isPending && runM.variables === task.id
                      ? <Loader2 size={15} className="animate-spin" />
                      : <Play size={15} />}
                  </button>
                  {task.status === 'pending' ? (
                    <button onClick={() => activateM.mutate(task.id)}
                      className="text-xs px-2.5 py-1 rounded-md bg-emerald-700 hover:bg-emerald-600 text-white">{t('actions.activate')}</button>
                  ) : task.status !== 'done' ? (
                    <label className="flex items-center gap-1.5 text-xs text-gray-400">
                      <input type="checkbox" checked={task.enabled} onChange={(e) => toggleM.mutate({ id: task.id, enabled: e.target.checked })} />
                      {t('actions.enableLabel')}
                    </label>
                  ) : null}
                  <button title={t('common:actions.delete')} className="text-gray-500 hover:text-red-400"
                    onClick={() => { if (confirm(t('actions.deleteConfirm'))) removeM.mutate(task.id); }}>
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
