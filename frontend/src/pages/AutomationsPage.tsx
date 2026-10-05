// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Trash2, Loader2, X, CheckCircle2, XCircle, Clock, Play, Pencil, ArrowLeft } from 'lucide-react';
import { scheduledTasksApi, type ScheduledTask, type UpdateScheduledTask } from '../api/scheduledTasks';
import { agentsApi } from '../api/agents';
import { useStore } from '../store/useStore';
import { Field } from './UsersPage';
import { ToolPicker } from '../components/ToolPicker';

/**
 * "Automations" section: the tasks scheduled by the user (also from the chat
 * via the schedule_task tool). See Auto-Scheduling in PROJECT.md.
 */
export function AutomationsSection() {
  const { t } = useTranslation('automations');
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [editing, setEditing] = useState<ScheduledTask | null>(null);
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

  // Editor replaces the list in-place (same pattern as the agents section).
  if (editing) {
    return (
      <AutomationEditor
        task={editing}
        onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); invalidate(); }}
      />
    );
  }

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
                    {task.maxTokensPerRun != null && (
                      <span className="text-gray-600"> · {task.maxTokensPerRun === 0 ? t('info.capOff') : t('info.cap', { count: task.maxTokensPerRun.toLocaleString() })}</span>
                    )}
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
                  <button title={t('actions.edit')} className="text-gray-500 hover:text-indigo-400"
                    onClick={() => { setErr(null); setInfo(null); setEditing(task); }}>
                    <Pencil size={15} />
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

/** ISO instant → value for <input type="datetime-local"> (local time, minutes). */
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Inline editor of an automation: instruction, schedule (cron or date — the type
 * is fixed), allowed tools and per-run token cap. Raising the cap above the
 * global default, or removing it, is admin-only (enforced by the backend too).
 */
function AutomationEditor({ task, onClose, onSaved }: { task: ScheduledTask; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation('automations');
  const isAdmin = (useStore((s) => s.user) as any)?.role === 'admin';
  const isCron = task.scheduleType === 'cron';

  const [title, setTitle] = useState(task.title ?? '');
  const [instruction, setInstruction] = useState(task.instruction);
  const [cron, setCron] = useState(task.cron ?? '');
  const [runAt, setRunAt] = useState(toLocalInput(task.runAt));
  const [timezone, setTimezone] = useState(task.timezone ?? '');
  const [useTools, setUseTools] = useState(task.toolFilter?.mode === 'names' || task.toolFilter?.mode === 'all');
  const [tools, setTools] = useState<Set<string>>(new Set(task.toolFilter?.names ?? []));
  const [customCap, setCustomCap] = useState(task.maxTokensPerRun != null);
  const [cap, setCap] = useState(task.maxTokensPerRun != null ? String(task.maxTokensPerRun) : '');
  const [err, setErr] = useState<string | null>(null);

  const limits = useQuery({ queryKey: ['scheduled-tasks-limits'], queryFn: scheduledTasksApi.limits, staleTime: 60_000 });
  const defaultCap = limits.data?.defaultMaxTokensPerRun;
  // Same query as the picker (cached): tool names saved on the task that the
  // catalog doesn't list (e.g. built-ins) stay selected and are shown separately.
  const catalog = useQuery({ queryKey: ['agent-tool-catalog'], queryFn: () => agentsApi.toolCatalog(), staleTime: 30_000 });
  const known = new Set((catalog.data?.groups ?? []).flatMap((g) => [...g.tools.map((x) => x.name), ...(g.wildcard ? [g.wildcard] : [])]));
  const unknownTools = catalog.data ? [...tools].filter((n) => !known.has(n)) : [];

  const capNum = cap.trim() === '' ? NaN : Number(cap);
  const capValid = !customCap || (Number.isInteger(capNum) && capNum >= 0);
  const capAboveDefault = customCap && capValid && defaultCap != null
    && (capNum === 0 ? defaultCap !== 0 : defaultCap !== 0 && capNum > defaultCap);

  const save = useMutation({
    mutationFn: () => {
      const data: UpdateScheduledTask = {
        title: title.trim(),
        instruction,
        timezone: timezone.trim() || null,
        // mode 'all' is kept as-is unless the user turns tools off.
        toolFilter: !useTools ? { mode: 'none' }
          : task.toolFilter?.mode === 'all' ? { mode: 'all' }
          : { mode: 'names', names: [...tools] },
        maxTokensPerRun: customCap ? capNum : null,
      };
      if (isCron) data.cron = cron.trim();
      else if (runAt !== toLocalInput(task.runAt)) data.runAt = new Date(runAt).toISOString();
      return scheduledTasksApi.update(task.id, data);
    },
    onSuccess: onSaved,
    onError: (e: any) => {
      const m = e?.response?.data?.message;
      setErr(Array.isArray(m) ? m.join(', ') : m ?? t('errors.saveFailed'));
    },
  });

  const canSave = instruction.trim() !== '' && (isCron ? cron.trim() !== '' : runAt !== '')
    && capValid && (isAdmin || !capAboveDefault);

  return (
    <div>
      <div className="flex items-center gap-3 mb-5">
        <button onClick={onClose} className="text-gray-400 hover:text-white flex items-center gap-1 text-sm flex-shrink-0">
          <ArrowLeft size={16} /> {t('heading')}
        </button>
        <h3 className="text-base font-semibold text-white truncate">{task.title || task.instruction.slice(0, 60)}</h3>
      </div>
      <div className="max-w-2xl">
        {err && (
          <div className="flex items-center justify-between gap-3 bg-red-950/50 border border-red-900 text-red-300 text-sm rounded-lg px-3 py-2 mb-3">
            <span>{err}</span><button onClick={() => setErr(null)}><X size={14} /></button>
          </div>
        )}

        <Field label={t('edit.title')}>
          <input className="input-field w-full" value={title} maxLength={160} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label={t('edit.instruction')}>
          <textarea className="input-field w-full text-sm" rows={8} value={instruction} onChange={(e) => setInstruction(e.target.value)} />
        </Field>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3">
          {isCron ? (
            <Field label={t('edit.cron')}>
              <input className="input-field w-full font-mono" value={cron} placeholder="0 8 * * *" onChange={(e) => setCron(e.target.value)} />
              <span className="block text-[11px] text-gray-500 mt-1">{t('edit.cronHint')}</span>
            </Field>
          ) : (
            <Field label={t('edit.runAt')}>
              <input type="datetime-local" className="input-field w-full" value={runAt} onChange={(e) => setRunAt(e.target.value)} />
            </Field>
          )}
          <Field label={t('edit.timezone')}>
            <input className="input-field w-full" value={timezone} placeholder="Europe/Rome" onChange={(e) => setTimezone(e.target.value)} />
          </Field>
        </div>

        <div className="mb-3">
          <label className="flex items-center gap-2 text-xs font-medium text-gray-400 mb-2">
            <input type="checkbox" className="accent-indigo-500" checked={useTools} onChange={(e) => setUseTools(e.target.checked)} />
            {t('edit.useTools')}
          </label>
          {useTools && (task.toolFilter?.mode === 'all'
            ? <p className="text-xs text-gray-500">{t('edit.toolsAll')}</p>
            : (
              <>
                <ToolPicker selected={tools} onChange={setTools} />
                {unknownTools.length > 0 && (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] text-gray-500">{t('edit.otherTools')}</span>
                    {unknownTools.map((n) => (
                      <span key={n} className="inline-flex items-center gap-1 text-[11px] font-mono px-1.5 py-0.5 rounded bg-gray-800 text-gray-300">
                        {n}
                        <button type="button" className="text-gray-500 hover:text-red-400"
                          onClick={() => { const next = new Set(tools); next.delete(n); setTools(next); }}>
                          <X size={11} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </>
            ))}
        </div>

        <div className="mb-4">
          <span className="block text-xs font-medium text-gray-400 mb-1">{t('edit.tokenCap')}</span>
          <label className="flex items-center gap-2 text-sm text-gray-300 mb-1.5">
            <input type="radio" className="accent-indigo-500" checked={!customCap} onChange={() => setCustomCap(false)} />
            {defaultCap == null ? t('edit.capDefault')
              : defaultCap === 0 ? t('edit.capDefaultOff')
              : t('edit.capDefaultValue', { count: defaultCap.toLocaleString() })}
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-300">
            <input type="radio" className="accent-indigo-500" checked={customCap} onChange={() => setCustomCap(true)} />
            {t('edit.capCustom')}
            <input type="number" min={0} step={1000} className="input-field w-40" disabled={!customCap}
              value={cap} onChange={(e) => setCap(e.target.value)} />
          </label>
          <p className="text-[11px] text-gray-500 mt-1">{isAdmin ? t('edit.capHintAdmin') : t('edit.capHintUser')}</p>
          {!capValid && <p className="text-[11px] text-red-400 mt-1">{t('edit.capInvalid')}</p>}
          {capAboveDefault && !isAdmin && <p className="text-[11px] text-red-400 mt-1">{t('edit.capAdminOnly')}</p>}
        </div>

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white">{t('common:actions.cancel')}</button>
          <button onClick={() => save.mutate()} disabled={!canSave || save.isPending}
            className="btn-primary px-4 py-2 text-sm flex items-center gap-2 disabled:opacity-50">
            {save.isPending && <Loader2 size={14} className="animate-spin" />}
            {t('common:actions.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
