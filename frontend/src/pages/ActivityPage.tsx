import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import {
  Activity, Loader2, Cpu, CalendarClock, Workflow, History,
  CheckCircle2, XCircle, Clock, PlayCircle, RefreshCw,
} from 'lucide-react';
import { activityApi, type ActivityRun } from '../api/activity';

/**
 * "Activity in progress" section: a read-only dashboard that aggregates everything
 * running or scheduled — skill daemons, automations (Auto-Scheduling),
 * flows with cron/scheduled triggers, and the latest flow runs. Refetches every 10s.
 */
export function ActivitySection() {
  const { t } = useTranslation('activity');

  const query = useQuery({
    queryKey: ['activity'],
    queryFn: activityApi.get,
    refetchInterval: 10_000,
    staleTime: 5_000,
  });

  const data = query.data;
  const fmt = (s: string | null) => (s ? new Date(s).toLocaleString() : '—');

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-gray-800 flex items-center justify-center text-gray-300"><Activity size={18} /></div>
        <div className="flex-1">
          <h2 className="text-lg font-semibold text-white">{t('title')}</h2>
          <p className="text-sm text-gray-500">{t('subtitle')}</p>
        </div>
        {query.isFetching && <RefreshCw size={15} className="text-gray-500 animate-spin" />}
      </div>

      {query.isLoading ? (
        <div className="text-center py-10 text-gray-500"><Loader2 className="animate-spin inline" size={18} /></div>
      ) : !data ? (
        <div className="text-center py-10 text-gray-500">{t('loadError')}</div>
      ) : (
        <>
          {/* Counters */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <CountCard icon={<Cpu size={15} />} label={t('counts.daemons')} value={data.counts.daemons} />
            <CountCard icon={<CalendarClock size={15} />} label={t('counts.automationsActive')} value={data.counts.automationsActive}
              sub={data.counts.automationsPending > 0 ? t('counts.automationsPending', { count: data.counts.automationsPending }) : undefined} />
            <CountCard icon={<Workflow size={15} />} label={t('counts.scheduledFlows')} value={data.counts.scheduledFlows} />
            <CountCard icon={<History size={15} />} label={t('counts.recentRuns')} value={data.recentRuns.length} />
          </div>

          {/* Running skill daemons */}
          <Block title={t('daemon.blockTitle')} icon={<Cpu size={14} />} empty={data.daemons.length === 0} emptyText={t('daemon.empty')}>
            {data.daemons.map((d) => (
              <Row key={d.id}
                left={<><StatusDot ok={d.status === 'running'} /> <span className="text-gray-100 truncate">{d.script || d.skillId || d.id}</span></>}
                right={<span className="text-xs text-gray-500">{d.status} · {t('daemon.startedPrefix')} {fmt(d.startedAt)}{d.lastEventAt ? ` · ${t('daemon.lastEventPrefix')} ${fmt(d.lastEventAt)}` : ''}</span>}
              />
            ))}
          </Block>

          {/* Automations */}
          <Block title={t('automation.blockTitle')} icon={<CalendarClock size={14} />} empty={data.automations.length === 0} emptyText={t('automation.empty')}>
            {data.automations.map((a) => (
              <Row key={a.id}
                left={<>{statusIcon(a.status)} <span className="text-gray-100 truncate">{a.title || t('automation.untitled')}</span>
                  {a.status === 'pending' && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300">{t('automation.badgePending')}</span>}
                  {!a.enabled && a.status === 'active' && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-500/15 text-gray-400">{t('automation.badgePaused')}</span>}</>}
                right={<span className="text-xs text-gray-500">
                  {a.scheduleType === 'cron' ? `cron ${a.cron}` : `${t('automation.oncePrefix')} · ${fmt(a.runAt)}`}
                  {a.lastRunAt ? ` · ${t('automation.lastRunPrefix')} ${fmt(a.lastRunAt)}` : ''}
                  {a.totalTokens > 0 ? ` · ${a.totalTokens.toLocaleString()} ${t('automation.tokSuffix')}` : ''}
                </span>}
              />
            ))}
          </Block>

          {/* Scheduled flows */}
          <Block title={t('scheduledFlow.blockTitle')} icon={<Workflow size={14} />} empty={data.scheduledFlows.length === 0} emptyText={t('scheduledFlow.empty')}>
            {data.scheduledFlows.map((f) => (
              <Row key={f.id}
                left={<><Clock size={14} className="text-sky-400" /> <span className="text-gray-100 truncate">{f.name}</span></>}
                right={<span className="text-xs text-gray-500">{f.type === 'cron' ? `cron ${f.cron}` : `${t('scheduledFlow.oncePrefix')} · ${fmt(f.runAt)}`}</span>}
              />
            ))}
          </Block>

          {/* Recent runs */}
          <Block title={t('recentRun.blockTitle')} icon={<History size={14} />} empty={data.recentRuns.length === 0} emptyText={t('recentRun.empty')}>
            {data.recentRuns.map((r) => (
              <Row key={r.id}
                left={<>{runIcon(r)} <span className="text-gray-100 truncate">{r.flowName || t('recentRun.deletedFlow')}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-500/15 text-gray-400">{r.triggeredBy}</span></>}
                right={<span className="text-xs text-gray-500">{r.status} · {fmt(r.startedAt)}</span>}
              />
            ))}
          </Block>
        </>
      )}
    </div>
  );
}

function CountCard({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: number; sub?: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <div className="flex items-center gap-2 text-gray-500 text-xs">{icon}<span>{label}</span></div>
      <p className="text-2xl font-semibold mt-1 text-gray-100">{value}</p>
      {sub && <p className="text-xs text-amber-400 mt-0.5">{sub}</p>}
    </div>
  );
}

function Block({ title, icon, empty, emptyText, children }: {
  title: string; icon: React.ReactNode; empty: boolean; emptyText: string; children: React.ReactNode;
}) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <div className="px-4 py-2.5 border-b border-gray-800 flex items-center gap-2 text-gray-300">
        {icon}<h3 className="text-sm font-semibold">{title}</h3>
      </div>
      {empty ? (
        <p className="px-4 py-5 text-xs text-gray-600">{emptyText}</p>
      ) : (
        <div className="divide-y divide-gray-800/50">{children}</div>
      )}
    </div>
  );
}

function Row({ left, right }: { left: React.ReactNode; right: React.ReactNode }) {
  return (
    <div className="px-4 py-2.5 flex items-center justify-between gap-3">
      <div className="flex items-center gap-2 min-w-0">{left}</div>
      <div className="flex-shrink-0 text-right">{right}</div>
    </div>
  );
}

function StatusDot({ ok }: { ok: boolean }) {
  return <span className={`inline-block w-2 h-2 rounded-full ${ok ? 'bg-emerald-400' : 'bg-amber-400'}`} />;
}

function statusIcon(s: string) {
  if (s === 'done') return <CheckCircle2 size={14} className="text-emerald-400" />;
  if (s === 'error') return <XCircle size={14} className="text-red-400" />;
  if (s === 'pending') return <Clock size={14} className="text-amber-400" />;
  return <PlayCircle size={14} className="text-indigo-400" />;
}

function runIcon(r: ActivityRun) {
  if (r.status === 'completed') return <CheckCircle2 size={14} className="text-emerald-400" />;
  if (r.status === 'error') return <XCircle size={14} className="text-red-400" />;
  if (r.status === 'cancelled') return <XCircle size={14} className="text-gray-500" />;
  if (r.status === 'running') return <Loader2 size={14} className="text-indigo-400 animate-spin" />;
  return <Clock size={14} className="text-gray-400" />;
}
