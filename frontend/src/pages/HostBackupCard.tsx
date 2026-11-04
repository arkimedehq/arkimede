// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, CalendarClock, CheckCircle, HardDrive, Loader2, Network, Plug, Save, XCircle,
} from 'lucide-react';
import {
  hostBackupApi, type HostBackupDestType, type HostBackupDestination, type HostBackupNetworkType,
  type HostBackupStatus,
} from '../api/backup';

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

const fmt = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '—');

const inputCls = 'w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-indigo-500/50';
const labelCls = 'block text-xs text-gray-400 mb-1';

interface Form {
  schedule: string;
  keepDaily: number;
  keepBase: number;
  baseWeekday: number;
  walArchiving: boolean;
  destType: HostBackupDestType;
  dest: HostBackupDestination;
}

// ── Schedule presets ↔ cron expression ───────────────────────────────────────
type ScheduleMode = 'daily' | 'hours' | 'weekly' | 'custom';
interface Schedule { mode: ScheduleMode; minute: number; hour: number; every: number; weekday: number; cron: string }
const HOUR_STEPS = [1, 2, 3, 4, 6, 8, 12];

function parseSchedule(cron: string): Schedule {
  const base = { minute: 15, hour: 2, every: 6, weekday: 0, cron };
  let m = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(cron);
  if (m) return { ...base, mode: 'daily', minute: +m[1], hour: +m[2] };
  m = /^(\d{1,2}) \*\/(\d{1,2}) \* \* \*$/.exec(cron);
  if (m && HOUR_STEPS.includes(+m[2])) return { ...base, mode: 'hours', minute: +m[1], every: +m[2] };
  m = /^(\d{1,2}) (\d{1,2}) \* \* ([0-6])$/.exec(cron);
  if (m) return { ...base, mode: 'weekly', minute: +m[1], hour: +m[2], weekday: +m[3] };
  return { ...base, mode: 'custom' };
}

function toCron(s: Schedule): string {
  switch (s.mode) {
    case 'daily': return `${s.minute} ${s.hour} * * *`;
    case 'hours': return `${s.minute} */${s.every} * * *`;
    case 'weekly': return `${s.minute} ${s.hour} * * ${s.weekday}`;
    default: return s.cron.trim();
  }
}

const hhmm = (h: number, m: number) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

const emptyDest: HostBackupDestination = { host: '', port: null, share: '', path: '', domain: '', username: '', password: '', secure: false };

function toForm(s: HostBackupStatus['settings']): Form {
  return {
    schedule: s.schedule,
    keepDaily: s.keepDaily,
    keepBase: s.keepBase,
    baseWeekday: s.baseWeekday,
    walArchiving: s.walArchiving,
    destType: s.destType,
    dest: { ...emptyDest, ...(s.destination ?? {}), password: '' },
  };
}

/**
 * Scheduled host backups: settings read by scripts/backup.sh (root cron on the host) and
 * the state it writes back — destination, nightly snapshots, WAL archiving, alarms.
 */
export function HostBackupCard() {
  const { t } = useTranslation('backup');
  const qc = useQueryClient();
  const { data, isLoading, isError } = useQuery({
    queryKey: ['host-backup'],
    queryFn: hostBackupApi.status,
    refetchInterval: 30_000,
  });
  const [form, setForm] = useState<Form | null>(null);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => { if (data && !form) setForm(toForm(data.settings)); }, [data, form]);

  const saveMut = useMutation({
    mutationFn: (f: Form) => hostBackupApi.update({
      schedule: f.schedule,
      keepDaily: f.keepDaily,
      keepBase: f.keepBase,
      baseWeekday: f.baseWeekday,
      walArchiving: f.walArchiving,
      destType: f.destType,
      destination: f.destType === 'local' ? undefined : f.dest,
    }),
    onSuccess: (res) => { qc.setQueryData(['host-backup'], res); setForm(toForm(res.settings)); },
  });

  const testMut = useMutation({
    mutationFn: (f: Form) => hostBackupApi.test(f.destType as HostBackupNetworkType, f.dest),
    onSuccess: (r) => setTest(r.ok
      ? { ok: true, text: t('host.testOk', { label: r.label }) }
      : { ok: false, text: t(r.stage === 'write' ? 'host.testWriteFail' : 'host.testConnectFail', { error: r.error }) }),
    onError: (e: any) => setTest({ ok: false, text: e?.response?.data?.message ?? String(e) }),
  });

  if (isLoading || !form) {
    return isError
      ? <p className="text-sm text-red-400">{t('host.loadError')}</p>
      : <p className="text-sm text-gray-500">{t('loading')}</p>;
  }
  if (!data) return null;
  const { state } = data;
  const set = (patch: Partial<Form>) => setForm({ ...form, ...patch });
  const setDest = (patch: Partial<HostBackupDestination>) => setForm({ ...form, dest: { ...form.dest, ...patch } });
  const network = form.destType !== 'local';
  const walOn = state.archiver?.archiveMode === 'on';
  const neverRan = !state.lastDaily && !state.walShippedAt;

  // Problems first: what an admin must act on.
  const problems: string[] = [];
  if (state.lastDaily?.status === 'failed') problems.push(t('host.problemDaily', { when: fmt(state.lastDaily.startedAt), msg: state.lastDaily.message ?? '' }));
  if (state.destReachable === false) problems.push(t('host.problemDest', { when: fmt(state.destCheckedAt) }));
  if (state.walGapSegment) problems.push(t('host.problemGap', { seg: state.walGapSegment }));
  if (data.settings.walArchiving !== walOn) problems.push(t(data.settings.walArchiving ? 'host.pendingOn' : 'host.pendingOff'));

  return (
    <div className="space-y-4 rounded-xl border border-gray-800 p-4">
      <div className="flex items-center gap-2">
        <CalendarClock size={18} className="text-indigo-400" />
        <h3 className="text-base font-semibold text-white">{t('host.title')}</h3>
      </div>
      <p className="text-xs text-gray-500">{t('host.description')}</p>

      {neverRan && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          {t('host.neverRan')} <code className="font-mono">sudo ./scripts/backup.sh install-cron</code>
        </div>
      )}
      {problems.map((p) => (
        <div key={p} className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" /> <span className="break-words min-w-0">{p}</span>
        </div>
      ))}

      {/* State */}
      <div className="grid gap-3 sm:grid-cols-3 text-xs">
        <div className="rounded-lg bg-gray-800/50 p-3 min-w-0">
          <p className="text-gray-500 mb-1">{t('host.destination')}</p>
          <p className="text-gray-200 break-all">{state.destResolved ?? '—'}</p>
          {state.destReachable != null && (
            <p className={state.destReachable ? 'text-green-500 mt-1' : 'text-red-400 mt-1'}>
              {state.destReachable ? t('host.reachable') : t('host.unreachable')} · {fmt(state.destCheckedAt)}
            </p>
          )}
        </div>
        <div className="rounded-lg bg-gray-800/50 p-3 min-w-0">
          <p className="text-gray-500 mb-1">{t('host.lastDaily')}</p>
          <p className="text-gray-200">{fmt(state.lastDaily?.startedAt)}</p>
          {state.lastDaily && (
            <p className={state.lastDaily.status === 'ok' ? 'text-green-500 mt-1' : 'text-red-400 mt-1'}>
              {t(`host.status.${state.lastDaily.status}`, { defaultValue: state.lastDaily.status })}
              {state.lastDaily.sizeBytes != null && ` · ${humanSize(state.lastDaily.sizeBytes)}`}
            </p>
          )}
          <p className="text-gray-500 mt-1">{t('host.lastBase')}: {fmt(state.lastBase?.startedAt)}</p>
        </div>
        <div className="rounded-lg bg-gray-800/50 p-3 min-w-0">
          <p className="text-gray-500 mb-1">{t('host.wal')}</p>
          <p className={walOn ? 'text-green-500' : 'text-gray-400'}>{walOn ? t('host.walActive') : t('host.walInactive')}</p>
          {walOn && (
            <>
              <p className="text-gray-400 mt-1">{t('host.walShipped')}: {fmt(state.walShippedAt)}</p>
              <p className="text-gray-400">{t('host.walSpool')}: {humanSize(state.walSpoolBytes ?? 0)}</p>
              {!!state.archiver?.failedCount && (
                <p className="text-red-400">{t('host.walFailed', { n: state.archiver.failedCount, when: fmt(state.archiver.lastFailedTime) })}</p>
              )}
            </>
          )}
        </div>
      </div>

      {/* Schedule */}
      <ScheduleEditor value={form.schedule} onChange={(schedule) => set({ schedule })} />

      {/* Settings */}
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label className={labelCls}>{t('host.keepDaily')}</label>
          <input type="number" min={1} max={365} className={inputCls} value={form.keepDaily}
            onChange={(e) => set({ keepDaily: Number(e.target.value) })} />
        </div>
        <div>
          <label className={labelCls}>{t('host.keepBase')}</label>
          <input type="number" min={1} max={52} className={inputCls} value={form.keepBase}
            onChange={(e) => set({ keepBase: Number(e.target.value) })} />
        </div>
        <div>
          <label className={labelCls}>{t('host.baseWeekday')}</label>
          <select className={inputCls} value={form.baseWeekday} onChange={(e) => set({ baseWeekday: Number(e.target.value) })}>
            {[1, 2, 3, 4, 5, 6, 0].map((d) => <option key={d} value={d}>{t(`host.weekdays.${d}`)}</option>)}
          </select>
        </div>
      </div>

      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm text-gray-200">{t('host.walArchiving')}</p>
          <p className="text-xs text-gray-500 mt-0.5">{t('host.walArchivingHint')}</p>
        </div>
        <button
          role="switch"
          aria-checked={form.walArchiving}
          onClick={() => set({ walArchiving: !form.walArchiving })}
          className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors focus:outline-none
            ${form.walArchiving ? 'bg-blue-600' : 'bg-gray-700'}`}
        >
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform
            ${form.walArchiving ? 'translate-x-6' : 'translate-x-1'}`} />
        </button>
      </div>

      {/* Destination */}
      <div className="space-y-3">
        <div>
          <label className={labelCls}>{t('host.destType')}</label>
          <select className={inputCls} value={form.destType}
            onChange={(e) => { set({ destType: e.target.value as HostBackupDestType }); setTest(null); }}>
            <option value="local">{t('host.destLocal')}</option>
            <option value="smb">SMB / CIFS</option>
            <option value="sftp">SFTP</option>
            <option value="webdav">WebDAV</option>
          </select>
          <p className="text-xs text-gray-500 mt-1 flex items-start gap-1.5">
            {network ? <Network size={12} className="mt-0.5 flex-shrink-0" /> : <HardDrive size={12} className="mt-0.5 flex-shrink-0" />}
            <span>{network ? t('host.destNetworkHint') : t('host.destLocalHint')}</span>
          </p>
        </div>

        {network && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={labelCls}>{t('host.host')}</label>
              <input className={inputCls} value={form.dest.host} placeholder="192.168.1.10"
                onChange={(e) => setDest({ host: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>{t('host.port')}</label>
              <input type="number" className={inputCls} value={form.dest.port ?? ''}
                placeholder={form.destType === 'smb' ? '445' : form.destType === 'sftp' ? '22' : (form.dest.secure ? '443' : '80')}
                onChange={(e) => setDest({ port: e.target.value ? Number(e.target.value) : null })} />
            </div>
            {form.destType === 'smb' && (
              <>
                <div>
                  <label className={labelCls}>{t('host.share')}</label>
                  <input className={inputCls} value={form.dest.share ?? ''} placeholder="Backup"
                    onChange={(e) => setDest({ share: e.target.value })} />
                </div>
                <div>
                  <label className={labelCls}>{t('host.domain')}</label>
                  <input className={inputCls} value={form.dest.domain ?? ''} placeholder="WORKGROUP"
                    onChange={(e) => setDest({ domain: e.target.value })} />
                </div>
              </>
            )}
            <div className="sm:col-span-2">
              <label className={labelCls}>{t('host.path')}</label>
              <input className={inputCls} value={form.dest.path ?? ''} placeholder="arkimede"
                onChange={(e) => setDest({ path: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>{t('host.username')}</label>
              <input className={inputCls} value={form.dest.username} autoComplete="off"
                onChange={(e) => setDest({ username: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>{t('host.password')}</label>
              <input type="password" className={inputCls} value={form.dest.password ?? ''} autoComplete="new-password"
                placeholder={data.settings.hasPassword && data.settings.destType === form.destType ? t('host.passwordKeep') : ''}
                onChange={(e) => setDest({ password: e.target.value })} />
            </div>
            {form.destType === 'webdav' && (
              <label className="flex items-center gap-2 text-xs text-gray-300">
                <input type="checkbox" checked={!!form.dest.secure} onChange={(e) => setDest({ secure: e.target.checked })} />
                HTTPS
              </label>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => saveMut.mutate(form)}
          disabled={saveMut.isPending}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {saveMut.isPending ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} {t('host.save')}
        </button>
        {network && (
          <button
            onClick={() => { setTest(null); testMut.mutate(form); }}
            disabled={testMut.isPending}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-700 text-gray-300 hover:bg-gray-800 disabled:opacity-50"
          >
            {testMut.isPending ? <Loader2 size={13} className="animate-spin" /> : <Plug size={13} />} {t('host.test')}
          </button>
        )}
        {saveMut.isSuccess && <span className="text-xs text-green-500">{t('host.saved')}</span>}
        {saveMut.isError && (
          <span className="text-xs text-red-400">{(saveMut.error as any)?.response?.data?.message ?? t('host.saveError')}</span>
        )}
      </div>
      {test && (
        <p className={`flex items-start gap-1.5 text-xs ${test.ok ? 'text-green-500' : 'text-red-400'}`}>
          {test.ok ? <CheckCircle size={13} className="mt-0.5 flex-shrink-0" /> : <XCircle size={13} className="mt-0.5 flex-shrink-0" />}
          <span className="break-words min-w-0">{test.text}</span>
        </p>
      )}
      <p className="text-xs text-gray-600">{t('host.alertHint', { state: state.alertWebhookConfigured ? t('host.alertOn') : t('host.alertOff') })}</p>

      {/* Recent runs and alarms */}
      {data.runs.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-gray-800">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-gray-500 border-b border-gray-800">
                <th className="px-3 py-2 font-medium">{t('columns.date')}</th>
                <th className="px-3 py-2 font-medium">{t('host.kind')}</th>
                <th className="px-3 py-2 font-medium">{t('host.result')}</th>
                <th className="px-3 py-2 font-medium">{t('columns.size')}</th>
              </tr>
            </thead>
            <tbody>
              {data.runs.slice(0, 12).map((r) => (
                <tr key={r.id} className="border-b border-gray-800/60 last:border-0 text-gray-300 align-top">
                  <td className="px-3 py-2 whitespace-nowrap text-gray-400">{fmt(r.startedAt)}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{t(`host.kinds.${r.kind}`, { defaultValue: r.kind })}</td>
                  <td className="px-3 py-2 min-w-[12rem]">
                    {r.kind === 'alert'
                      ? <span className="text-amber-300">{r.message}</span>
                      : <span className={r.status === 'ok' ? 'text-green-500' : r.status === 'failed' ? 'text-red-400' : 'text-gray-400'}>
                          {t(`host.status.${r.status}`, { defaultValue: r.status })}{r.message ? ` — ${r.message}` : ''}
                        </span>}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-400">{r.sizeBytes != null ? humanSize(r.sizeBytes) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Snapshot schedule: daily / every N hours / weekly presets, or a free cron expression. */
function ScheduleEditor({ value, onChange }: { value: string; onChange: (cron: string) => void }) {
  const { t } = useTranslation('backup');
  const [s, setS] = useState<Schedule>(() => parseSchedule(value));
  useEffect(() => { if (toCron(s) !== value) setS(parseSchedule(value)); }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const update = (patch: Partial<Schedule>) => {
    const next = { ...s, ...patch };
    if (patch.mode === 'custom') next.cron = toCron(s);
    setS(next);
    onChange(toCron(next));
  };
  const time = (
    <input type="time" className={inputCls} value={hhmm(s.hour, s.minute)}
      onChange={(e) => { const [h, m] = e.target.value.split(':').map(Number); if (!Number.isNaN(h)) update({ hour: h, minute: m }); }} />
  );

  return (
    <div className="space-y-2">
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label className={labelCls}>{t('host.schedule')}</label>
          <select className={inputCls} value={s.mode} onChange={(e) => update({ mode: e.target.value as ScheduleMode })}>
            <option value="daily">{t('host.scheduleDaily')}</option>
            <option value="hours">{t('host.scheduleHours')}</option>
            <option value="weekly">{t('host.scheduleWeekly')}</option>
            <option value="custom">{t('host.scheduleCustom')}</option>
          </select>
        </div>
        {s.mode === 'daily' && <div><label className={labelCls}>{t('host.scheduleAt')}</label>{time}</div>}
        {s.mode === 'weekly' && (
          <>
            <div>
              <label className={labelCls}>{t('host.scheduleDay')}</label>
              <select className={inputCls} value={s.weekday} onChange={(e) => update({ weekday: Number(e.target.value) })}>
                {[1, 2, 3, 4, 5, 6, 0].map((d) => <option key={d} value={d}>{t(`host.weekdays.${d}`)}</option>)}
              </select>
            </div>
            <div><label className={labelCls}>{t('host.scheduleAt')}</label>{time}</div>
          </>
        )}
        {s.mode === 'hours' && (
          <>
            <div>
              <label className={labelCls}>{t('host.scheduleEvery')}</label>
              <select className={inputCls} value={s.every} onChange={(e) => update({ every: Number(e.target.value) })}>
                {HOUR_STEPS.map((n) => <option key={n} value={n}>{t('host.scheduleEveryN', { count: n })}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls}>{t('host.scheduleMinute')}</label>
              <input type="number" min={0} max={59} className={inputCls} value={s.minute}
                onChange={(e) => update({ minute: Math.min(59, Math.max(0, Number(e.target.value))) })} />
            </div>
          </>
        )}
        {s.mode === 'custom' && (
          <div className="sm:col-span-2">
            <label className={labelCls}>{t('host.scheduleCron')}</label>
            <input className={`${inputCls} font-mono`} value={s.cron} placeholder="15 2 * * *"
              onChange={(e) => update({ cron: e.target.value })} />
          </div>
        )}
      </div>
      <p className="text-xs text-gray-500">
        {t('host.scheduleHint')} <code className="font-mono text-gray-400">{toCron(s) || '—'}</code>
      </p>
    </div>
  );
}
