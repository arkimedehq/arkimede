// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import {
  Activity, Loader2, Cpu, CalendarClock, Workflow, History,
  CheckCircle2, XCircle, Clock, PlayCircle, RefreshCw,
  Radio, ChevronRight, Wrench, Check, X, MessageSquareText, Mic, Volume2, KeyRound,
} from 'lucide-react';
import { activityApi, type ActivityRun } from '../api/activity';
import { invocationsApi, type Invocation } from '../api/invocations';
import { useStore } from '../store/useStore';

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

          {/* External invocations (OpenAI-compat) */}
          <InvocationsBlock />
        </>
      )}
    </div>
  );
}

// ── External invocation log (OpenAI-compat calls) ─────────────────────────────
//
// Calls arriving from outside the chat UI (voice satellites, third-party
// OpenAI-dialect clients) create no chat rows: this block is their only trace.
// Per-user by default; admins can switch to the all-users view.

const ROUTE_META: Record<string, { icon: React.ReactNode; labelKey: string }> = {
  chat:          { icon: <MessageSquareText size={13} />, labelKey: 'invocations.routeChat' },
  transcription: { icon: <Mic size={13} />,               labelKey: 'invocations.routeTranscription' },
  speech:        { icon: <Volume2 size={13} />,           labelKey: 'invocations.routeSpeech' },
};

const PAGE_SIZE = 25;

function InvocationsBlock() {
  const { t } = useTranslation('activity');
  const user = useStore((s) => s.user);
  const isAdmin = (user as any)?.role === 'admin';

  const [all,   setAll]   = useState(false);
  const [route, setRoute] = useState('');
  const [limit, setLimit] = useState(PAGE_SIZE);

  const query = useQuery({
    queryKey: ['invocations', { all, route, limit }],
    queryFn: () => invocationsApi.list({ all, route: route || undefined, limit }),
    refetchInterval: 30_000,
    staleTime: 10_000,
  });
  const items = query.data?.items ?? [];
  const total = query.data?.total ?? 0;

  const filterBtn = (value: string, label: string) => (
    <button
      key={value}
      onClick={() => { setRoute(value); setLimit(PAGE_SIZE); }}
      className={`px-2 py-0.5 text-xs rounded border transition-colors
        ${route === value
          ? 'border-indigo-500 bg-indigo-900/40 text-indigo-300'
          : 'border-gray-700 text-gray-500 hover:border-gray-600 hover:text-gray-400'}`}
    >
      {label}
    </button>
  );

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <div className="px-4 py-2.5 border-b border-gray-800 flex flex-wrap items-center gap-2 text-gray-300">
        <Radio size={14} />
        <h3 className="text-sm font-semibold">{t('invocations.blockTitle')}</h3>
        <span className="text-[10px] text-gray-600">{t('invocations.count', { count: total })}</span>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {filterBtn('', t('invocations.filterAllRoutes'))}
          {filterBtn('chat', t('invocations.routeChat'))}
          {filterBtn('transcription', t('invocations.routeTranscription'))}
          {filterBtn('speech', t('invocations.routeSpeech'))}
          {isAdmin && (
            <button
              onClick={() => { setAll((v) => !v); setLimit(PAGE_SIZE); }}
              className={`px-2 py-0.5 text-xs rounded border transition-colors
                ${all
                  ? 'border-amber-500 bg-amber-500/15 text-amber-300'
                  : 'border-gray-700 text-gray-500 hover:border-gray-600 hover:text-gray-400'}`}
            >
              {t('invocations.allUsers')}
            </button>
          )}
        </div>
      </div>

      {query.isLoading ? (
        <p className="px-4 py-5 text-xs text-gray-600"><Loader2 size={12} className="animate-spin inline" /></p>
      ) : items.length === 0 ? (
        <p className="px-4 py-5 text-xs text-gray-600">{t('invocations.empty')}</p>
      ) : (
        <div className="divide-y divide-gray-800/50">
          {items.map((inv) => <InvocationRow key={inv.id} inv={inv} showUser={all} />)}
          {items.length < total && (
            <button
              onClick={() => setLimit((l) => Math.min(l + PAGE_SIZE, 100))}
              disabled={limit >= 100}
              className="w-full px-4 py-2 text-xs text-gray-500 hover:text-gray-300 hover:bg-gray-800/40 transition-colors disabled:opacity-50"
            >
              {limit >= 100 ? t('invocations.capReached') : t('invocations.loadMore', { count: total - items.length })}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function InvocationRow({ inv, showUser }: { inv: Invocation; showUser: boolean }) {
  const { t } = useTranslation('activity');
  const [open, setOpen] = useState(false);
  const meta = ROUTE_META[inv.route] ?? ROUTE_META.chat;
  const when = new Date(inv.createdAt).toLocaleString();

  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full px-4 py-2.5 flex items-center gap-2 text-left hover:bg-gray-800/40 transition-colors"
      >
        <ChevronRight size={12} className={`text-gray-500 flex-shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
        {inv.status === 'ok'
          ? <Check size={13} className="text-emerald-400 flex-shrink-0" />
          : <X size={13} className="text-red-400 flex-shrink-0" />}
        <span className="text-gray-400 flex-shrink-0" title={t(meta.labelKey)}>{meta.icon}</span>
        {inv.model && <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-300 font-mono flex-shrink-0">{inv.model}</span>}
        <span className="text-xs text-gray-300 truncate min-w-0">
          {inv.inputPreview || '—'}
        </span>
        <span className="ml-auto flex items-center gap-2 flex-shrink-0 text-[10px] text-gray-500 font-mono">
          {showUser && inv.userEmail && <span className="text-gray-400">{inv.userEmail}</span>}
          {inv.apiKeyPrefix && (
            <span className="flex items-center gap-0.5" title={t('invocations.apiKey')}>
              <KeyRound size={10} />{inv.apiKeyPrefix}…
            </span>
          )}
          {inv.toolCalls?.length ? (
            <span className="flex items-center gap-0.5"><Wrench size={10} />{inv.toolCalls.length}</span>
          ) : null}
          {inv.durationMs != null && <span>{(inv.durationMs / 1000).toFixed(1)}s</span>}
          <span>{when}</span>
        </span>
      </button>

      {open && (
        <div className="px-4 pb-3 pl-10 space-y-2 text-[11px]">
          {(inv.inputTokens != null || inv.outputTokens != null) && (
            <p className="text-gray-500 font-mono">
              ↑ {inv.inputTokens ?? '?'} tok · ↓ {inv.outputTokens ?? '?'} tok
            </p>
          )}
          {inv.inputPreview && (
            <div>
              <div className="text-gray-500 mb-0.5">{t('invocations.input')}</div>
              <pre className="bg-black/40 rounded p-2 overflow-x-auto max-h-48 overflow-y-auto text-gray-300 font-mono whitespace-pre-wrap break-words">{inv.inputPreview}</pre>
            </div>
          )}
          {inv.outputPreview && (
            <div>
              <div className="text-gray-500 mb-0.5">{t('invocations.output')}</div>
              <pre className="bg-black/40 rounded p-2 overflow-x-auto max-h-48 overflow-y-auto text-gray-300 font-mono whitespace-pre-wrap break-words">{inv.outputPreview}</pre>
            </div>
          )}
          {inv.error && (
            <div>
              <div className="text-red-400 mb-0.5">{t('invocations.error')}</div>
              <pre className="bg-red-950/30 border border-red-900/40 rounded p-2 overflow-x-auto text-red-300 font-mono whitespace-pre-wrap break-words">{inv.error}</pre>
            </div>
          )}
          {inv.toolCalls?.map((call, i) => (
            <div key={i} className="rounded-lg bg-gray-900/60 border border-gray-700/50 px-2.5 py-1.5">
              <div className="flex items-center gap-2">
                {call.ok !== false
                  ? <Check size={11} className="text-emerald-400 flex-shrink-0" />
                  : <X size={11} className="text-red-400 flex-shrink-0" />}
                <span className="font-mono text-gray-200 truncate">{call.name}</span>
                {call.durationMs != null && (
                  <span className="ml-auto text-[10px] text-gray-500 font-mono flex-shrink-0">{call.durationMs}ms</span>
                )}
              </div>
              {call.input !== undefined && (
                <pre className="mt-1 bg-black/40 rounded p-1.5 overflow-x-auto max-h-32 overflow-y-auto text-gray-400 font-mono whitespace-pre-wrap break-words">{fmtVal(call.input)}</pre>
              )}
              {call.output !== undefined && (
                <pre className="mt-1 bg-black/40 rounded p-1.5 overflow-x-auto max-h-32 overflow-y-auto text-gray-300 font-mono whitespace-pre-wrap break-words">{fmtVal(call.output)}</pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function fmtVal(val: any): string {
  if (val == null) return '';
  if (typeof val === 'string') return val;
  try { return JSON.stringify(val, null, 2); }
  catch { return String(val); }
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
