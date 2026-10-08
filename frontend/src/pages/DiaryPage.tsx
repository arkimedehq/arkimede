// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BookOpen, CalendarDays, Check, ChevronDown, ChevronRight, Loader2, Pencil, Pin, PinOff, Search, Trash2, UserRound, X,
} from 'lucide-react';
import { diaryApi, type DiaryEpisode, type DiaryFact, type DiaryNote, type PlanStatus } from '../api/diary';

/**
 * Settings → Diary: what Recordare (the episodic memory) remembers about the user —
 * timeline, the nightly diary, who they are (facts and notes), plans and what awaits
 * their confirmation — with their own edits: correct or forget a memory, pin or delete
 * a note, confirm or reject what was only inferred. Read through the backend proxy:
 * always the logged-in user's own memory.
 */
type Tab = 'timeline' | 'digests' | 'profile' | 'plans' | 'pending';
const TABS: Tab[] = ['timeline', 'digests', 'profile', 'plans', 'pending'];

const STATUS_COLOR: Record<PlanStatus, string> = {
  open: 'text-blue-300 border-blue-800', confirmed: 'text-green-300 border-green-800', cancelled: 'text-gray-400 border-gray-700',
  rescheduled: 'text-amber-300 border-amber-800', unresolved: 'text-orange-300 border-orange-800',
};

function errorText(e: any): string {
  return e?.response?.data?.message ?? e?.message ?? 'error';
}

export function DiarySection({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation('diary');
  const [tab, setTab] = useState<Tab>('timeline');
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-gray-800 flex items-center justify-center text-gray-300"><BookOpen size={18} /></div>
        <div className="flex-1">
          <h2 className="text-lg font-semibold text-white">{t('title')}</h2>
          <p className="text-sm text-gray-500">{t('subtitle')}</p>
        </div>
      </div>
      {!enabled ? (
        <p className="text-sm text-gray-400 bg-gray-900 border border-gray-800 rounded-xl p-5">{t('off')}</p>
      ) : (
        <>
          <div className="flex gap-1 border-b border-gray-800 overflow-x-auto">
            {TABS.map((id) => (
              <button key={id} onClick={() => setTab(id)}
                className={`px-3 py-2 text-sm whitespace-nowrap border-b-2 -mb-px transition-colors
                  ${tab === id ? 'border-blue-500 text-white' : 'border-transparent text-gray-400 hover:text-gray-200'}`}>
                {t(`tabs.${id}`)}
              </button>
            ))}
          </div>
          {tab === 'timeline' && <Timeline />}
          {tab === 'digests' && <Digests />}
          {tab === 'profile' && <Profile />}
          {tab === 'plans' && <Plans />}
          {tab === 'pending' && <Pending />}
        </>
      )}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="text-sm text-gray-500 py-6 text-center">{text}</p>;
}

function Loading() {
  return <div className="flex justify-center py-8 text-gray-500"><Loader2 size={18} className="animate-spin" /></div>;
}

function Failed({ error }: { error: unknown }) {
  const { t } = useTranslation('diary');
  return <p className="text-sm text-red-400 py-4">{t('error')}: {errorText(error)}</p>;
}

function when(e: DiaryEpisode): string {
  if (!e.occurredAt) return '—';
  return e.occurredUntil && e.occurredUntil !== e.occurredAt ? `${e.occurredAt} → ${e.occurredUntil}` : e.occurredAt;
}

// ── Timeline ────────────────────────────────────────────────────────────────────

function Timeline() {
  const { t } = useTranslation('diary');
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const list = useInfiniteQuery({
    queryKey: ['diary', 'episodes', search],
    queryFn: ({ pageParam }) => diaryApi.episodes({ q: search || undefined, cursor: pageParam ?? undefined, limit: 30 }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <div className="space-y-3">
      <form onSubmit={(e) => { e.preventDefault(); setSearch(q.trim()); }} className="flex gap-2">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
          <input className="input-field w-full pl-8" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('search')} />
        </div>
        <button className="px-3 py-1.5 rounded-lg bg-gray-800 text-sm text-gray-200 hover:bg-gray-700" type="submit">{t('find')}</button>
      </form>
      {list.isLoading ? <Loading /> : list.error ? <Failed error={list.error} /> : items.length === 0 ? <Empty text={t('empty.timeline')} /> : (
        <ul className="space-y-2">{items.map((e) => <EpisodeRow key={e.id} episode={e} />)}</ul>
      )}
      {list.hasNextPage && (
        <button onClick={() => list.fetchNextPage()} disabled={list.isFetchingNextPage}
          className="w-full py-2 text-sm text-gray-400 hover:text-gray-200">{list.isFetchingNextPage ? '…' : t('more')}</button>
      )}
    </div>
  );
}

function EpisodeRow({ episode: e }: { episode: DiaryEpisode }) {
  const { t } = useTranslation('diary');
  const [open, setOpen] = useState(false);
  return (
    <li className="bg-gray-900 border border-gray-800 rounded-xl">
      <button onClick={() => setOpen(!open)} className="w-full text-left px-4 py-3 flex gap-3 items-start">
        {open ? <ChevronDown size={14} className="mt-1 text-gray-500" /> : <ChevronRight size={14} className="mt-1 text-gray-500" />}
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
            <span className="font-mono">{when(e)}</span>
            <span>{t(`kind.${e.kind}`)}</span>
            {e.planStatus && <span className={`px-1.5 rounded border ${STATUS_COLOR[e.planStatus]}`}>{t(`status.${e.planStatus}`)}</span>}
            {e.inferred && <span className="text-amber-400">{t('inferred')}</span>}
            {e.corrected && <span>{t('corrected')}</span>}
          </div>
          <p className="text-sm text-gray-200 mt-1">{e.content}</p>
          {e.people.length > 0 && <p className="text-xs text-gray-500 mt-1">{e.people.join(', ')}</p>}
        </div>
      </button>
      {open && <EpisodeDetail id={e.id} />}
    </li>
  );
}

function EpisodeDetail({ id }: { id: string }) {
  const { t } = useTranslation('diary');
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ['diary', 'episode', id], queryFn: () => diaryApi.episode(id) });
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState('');
  const [date, setDate] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['diary'] });
  const correct = useMutation({
    mutationFn: () => diaryApi.correct(id, { ...(content.trim() ? { content: content.trim() } : {}), ...(date ? { occurredAt: date } : {}) }),
    onSuccess: () => { setEditing(false); refresh(); },
  });
  const forget = useMutation({ mutationFn: () => diaryApi.forget(id), onSuccess: refresh });
  if (detail.isLoading) return <Loading />;
  if (detail.error) return <div className="px-4 pb-3"><Failed error={detail.error} /></div>;
  const d = detail.data!;
  return (
    <div className="px-4 pb-4 pt-1 border-t border-gray-800 space-y-3 text-sm">
      {d.place && <p className="text-gray-400">{t('place')}: {d.place}</p>}
      {d.opinion && <p className="text-gray-400">{t('opinion')}: {d.opinion}</p>}
      {d.evidence.length > 0 && (
        <div>
          <p className="text-xs uppercase tracking-wide text-gray-500 mb-1">{t('evidence')}</p>
          <ul className="space-y-1">
            {d.evidence.map((ev, i) => (
              <li key={i} className="text-gray-300">
                {ev.otherClient
                  ? <span className="text-gray-500 italic">{t('otherClient')}</span>
                  : <><span className="text-gray-500">{new Date(ev.sentAt).toLocaleString()} · {ev.author ?? t(`role.${ev.role}`, ev.role)}:</span> “{ev.text}”</>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {d.history.length > 0 && (
        <div>
          <p className="text-xs uppercase tracking-wide text-gray-500 mb-1">{t('history')}</p>
          <ul className="space-y-1">{d.history.map((h) => <li key={h.id} className="text-gray-500 line-through">{h.content}</li>)}</ul>
        </div>
      )}
      {d.confirmedBy && <p className="text-gray-400">{t('outcome')}: {d.confirmedBy.content}</p>}
      {editing ? (
        <div className="space-y-2">
          <textarea className="input-field w-full" rows={2} value={content} onChange={(e) => setContent(e.target.value)} placeholder={d.content} />
          <div className="flex flex-wrap items-center gap-2">
            <CalendarDays size={14} className="text-gray-500" />
            <input type="date" className="input-field" value={date} onChange={(e) => setDate(e.target.value)} />
            <button onClick={() => correct.mutate()} disabled={correct.isPending || (!content.trim() && !date)}
              className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs disabled:opacity-50">{t('save')}</button>
            <button onClick={() => setEditing(false)} className="px-3 py-1.5 rounded-lg text-gray-400 text-xs">{t('cancel')}</button>
          </div>
          {correct.error && <Failed error={correct.error} />}
        </div>
      ) : (
        <div className="flex gap-2">
          <button onClick={() => { setContent(''); setDate(''); setEditing(true); }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-700 text-xs text-gray-300 hover:bg-gray-800">
            <Pencil size={12} />{t('correct')}
          </button>
          <button onClick={() => { if (window.confirm(t('forgetConfirm'))) forget.mutate(); }} disabled={forget.isPending}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-700 text-xs text-red-400 hover:bg-gray-800">
            <Trash2 size={12} />{t('forget')}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Diary (digests) ─────────────────────────────────────────────────────────────

function Digests() {
  const { t } = useTranslation('diary');
  const q = useQuery({ queryKey: ['diary', 'digests'], queryFn: diaryApi.digests });
  if (q.isLoading) return <Loading />;
  if (q.error) return <Failed error={q.error} />;
  if (!q.data?.length) return <Empty text={t('empty.digests')} />;
  return (
    <ul className="space-y-3">
      {q.data.map((d) => (
        <li key={d.id} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <p className="text-xs text-gray-500 mb-1">
            <span className="font-mono">{d.level === 'month' ? d.periodStart.slice(0, 7) : d.periodStart}</span> · {t(`level.${d.level}`)}
          </p>
          <p className="text-sm text-gray-200 whitespace-pre-line">{d.content}</p>
        </li>
      ))}
    </ul>
  );
}

// ── Who you are: facts and notes ────────────────────────────────────────────────

function Profile() {
  const { t } = useTranslation('diary');
  const qc = useQueryClient();
  const facts = useQuery({ queryKey: ['diary', 'facts'], queryFn: () => diaryApi.facts() });
  const notes = useQuery({ queryKey: ['diary', 'notes'], queryFn: () => diaryApi.notes() });
  const refresh = () => qc.invalidateQueries({ queryKey: ['diary'] });
  const remove = useMutation({ mutationFn: (v: { what: 'notes' | 'facts'; id: string }) => diaryApi.remove(v.what, v.id), onSuccess: refresh });
  const pin = useMutation({ mutationFn: (n: DiaryNote) => diaryApi.pin(n.id, !n.pinned), onSuccess: refresh });
  return (
    <div className="space-y-6">
      <section>
        <h3 className="text-sm font-semibold text-gray-200 mb-2">{t('facts')}</h3>
        {facts.isLoading ? <Loading /> : facts.error ? <Failed error={facts.error} /> : !facts.data?.length ? <Empty text={t('empty.facts')} /> : (
          <ul className="divide-y divide-gray-800 bg-gray-900 border border-gray-800 rounded-xl">
            {facts.data.map((f) => <FactRow key={f.id} fact={f} onDelete={() => { if (window.confirm(t('deleteConfirm'))) remove.mutate({ what: 'facts', id: f.id }); }} />)}
          </ul>
        )}
      </section>
      <section>
        <h3 className="text-sm font-semibold text-gray-200 mb-2">{t('notes')}</h3>
        {notes.isLoading ? <Loading /> : notes.error ? <Failed error={notes.error} /> : !notes.data?.length ? <Empty text={t('empty.notes')} /> : (
          <ul className="divide-y divide-gray-800 bg-gray-900 border border-gray-800 rounded-xl">
            {notes.data.map((n) => (
              <li key={n.id} className="px-4 py-2.5 flex items-start gap-3">
                <div className="flex-1">
                  <p className="text-sm text-gray-200">{n.content}</p>
                  <p className="text-xs text-gray-500">{t(`category.${n.category}`, n.category)}{n.inferred ? ` · ${t('inferred')}` : ''}</p>
                </div>
                <button title={n.pinned ? t('unpin') : t('pin')} onClick={() => pin.mutate(n)}
                  className={n.pinned ? 'text-blue-400' : 'text-gray-500 hover:text-gray-300'}>
                  {n.pinned ? <Pin size={14} /> : <PinOff size={14} />}
                </button>
                <button title={t('delete')} onClick={() => { if (window.confirm(t('deleteConfirm'))) remove.mutate({ what: 'notes', id: n.id }); }}
                  className="text-gray-500 hover:text-red-400"><Trash2 size={14} /></button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function FactRow({ fact: f, onDelete }: { fact: DiaryFact; onDelete: () => void }) {
  const { t } = useTranslation('diary');
  const [open, setOpen] = useState(false);
  const label = f.key.replace(/_/g, ' ');
  return (
    <li className="px-4 py-2.5">
      <div className="flex items-start gap-3">
        <button onClick={() => setOpen(!open)} className="text-gray-500 mt-0.5">{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
        <div className="flex-1">
          <p className="text-sm text-gray-200">
            {f.about && <span className="inline-flex items-center gap-1 text-gray-400 mr-1"><UserRound size={12} />{f.about} ·</span>}
            <span className="text-gray-400">{label}:</span> {f.value ?? t('unknown')}
          </p>
          {f.validFrom && <p className="text-xs text-gray-500">{t('since')} {f.validFrom}{f.inferred ? ` · ${t('inferred')}` : ''}</p>}
        </div>
        <button title={t('delete')} onClick={onDelete} className="text-gray-500 hover:text-red-400"><Trash2 size={14} /></button>
      </div>
      {open && f.history.length > 1 && (
        <ul className="mt-2 ml-7 space-y-0.5">
          {f.history.map((h) => (
            <li key={h.id} className="text-xs text-gray-500">{h.from ?? '?'} → {h.to ?? t('now')}: {h.value ?? t('unknown')}</li>
          ))}
        </ul>
      )}
    </li>
  );
}

// ── Plans ───────────────────────────────────────────────────────────────────────

function Plans() {
  const { t } = useTranslation('diary');
  const q = useQuery({ queryKey: ['diary', 'plans'], queryFn: diaryApi.plans });
  if (q.isLoading) return <Loading />;
  if (q.error) return <Failed error={q.error} />;
  if (!q.data?.length) return <Empty text={t('empty.plans')} />;
  return <ul className="space-y-2">{q.data.map((e) => <EpisodeRow key={e.id} episode={e} />)}</ul>;
}

// ── Awaiting confirmation ───────────────────────────────────────────────────────

function Pending() {
  const { t } = useTranslation('diary');
  const qc = useQueryClient();
  const facts = useQuery({ queryKey: ['diary', 'facts', 'pending'], queryFn: () => diaryApi.facts(true) });
  const notes = useQuery({ queryKey: ['diary', 'notes', 'pending'], queryFn: () => diaryApi.notes(true) });
  const decide = useMutation({
    mutationFn: (v: { what: 'notes' | 'facts'; id: string; decision: 'confirm' | 'reject' }) => diaryApi.decide(v.what, v.id, v.decision),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['diary'] }),
  });
  if (facts.isLoading || notes.isLoading) return <Loading />;
  if (facts.error || notes.error) return <Failed error={facts.error ?? notes.error} />;
  const items = [
    ...(facts.data ?? []).filter((f) => f.pending).map((f) => ({ what: 'facts' as const, id: f.id, text: `${f.about ? `${f.about} · ` : ''}${f.key.replace(/_/g, ' ')}: ${f.value ?? t('unknown')}` })),
    ...(notes.data ?? []).filter((n) => n.pending).map((n) => ({ what: 'notes' as const, id: n.id, text: n.content })),
  ];
  if (!items.length) return <Empty text={t('empty.pending')} />;
  return (
    <div className="space-y-2">
      <p className="text-xs text-gray-500">{t('pendingHint')}</p>
      <ul className="divide-y divide-gray-800 bg-gray-900 border border-gray-800 rounded-xl">
        {items.map((i) => (
          <li key={i.id} className="px-4 py-2.5 flex items-center gap-3">
            <p className="flex-1 text-sm text-gray-200">{i.text}</p>
            <button title={t('confirm')} onClick={() => decide.mutate({ what: i.what, id: i.id, decision: 'confirm' })}
              className="p-1.5 rounded-lg text-green-400 hover:bg-gray-800"><Check size={14} /></button>
            <button title={t('reject')} onClick={() => decide.mutate({ what: i.what, id: i.id, decision: 'reject' })}
              className="p-1.5 rounded-lg text-red-400 hover:bg-gray-800"><X size={14} /></button>
          </li>
        ))}
      </ul>
    </div>
  );
}
