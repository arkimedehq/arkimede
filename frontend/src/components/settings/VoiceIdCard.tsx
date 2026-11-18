// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Settings → Voice & audio → Recognised voices (admin): who speaks to the satellites, from the voice. The voices of
 * the house's people (not Arkimede accounts: the voice account is one many people talk to), each optionally the same
 * person as a Home Assistant person and an Arkimede user; learned from what they say to a satellite; each voice's
 * samples with their scores (a suspect one removed alone); the latest recognitions with their scores, to see how sure
 * it is; and which actions by voice need a recognised voice (clearance).
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, AudioLines, ChevronDown, ChevronRight, Loader2, Mic, Plus, RotateCcw, ShieldCheck, Trash2, X } from 'lucide-react';
import { voiceIdApi, type VoiceClearancePolicy, type VoiceIdState, type VoiceProfileView } from '../../api/voiceId';
import { appConfigApi } from '../../api/appConfig';
import { adminUsersApi } from '../../api/adminUsers';

const input = 'bg-gray-900 border border-gray-700 rounded-lg px-2.5 py-1.5 text-sm text-gray-100 focus:outline-none focus:border-blue-500';

export default function VoiceIdCard() {
  const { t } = useTranslation('settings');
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const { data } = useQuery({ queryKey: ['voice-id'], queryFn: voiceIdApi.get, refetchInterval: 5_000 });
  const ha = useQuery({ queryKey: ['home-assistant-config'], queryFn: appConfigApi.getHomeAssistantConfig });
  const users = useQuery({ queryKey: ['admin-users-all'], queryFn: adminUsersApi.listAll });
  const refresh = (d?: VoiceIdState) => {
    setError(null);
    if (d) qc.setQueryData(['voice-id'], d);
    else qc.invalidateQueries({ queryKey: ['voice-id'] });
  };
  const fail = (e: any) => setError(e?.response?.data?.message ?? t('voiceId.error'));
  const toggle = useMutation({ mutationFn: (on: boolean) => voiceIdApi.setEnabled(on), onSuccess: refresh, onError: fail });
  const create = useMutation({ mutationFn: () => voiceIdApi.create({ name: newName.trim() }), onSuccess: () => { setNewName(''); refresh(); }, onError: fail });
  const enabled = data?.enabled ?? false;
  const satellites = ha.data?.status?.voicePoints ?? [];
  const persons = ha.data?.status?.persons ?? [];

  return (
    <div className="bg-gray-800/50 border border-gray-700/50 rounded-xl p-5 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <AudioLines size={20} className="text-indigo-400 mt-0.5 flex-shrink-0" />
          <div>
            <h3 className="text-sm font-semibold text-gray-100">{t('voiceId.title')}</h3>
            <p className="text-xs text-gray-400 mt-1 max-w-xl">{t('voiceId.hint')}</p>
          </div>
        </div>
        <button
          role="switch" aria-checked={enabled} disabled={toggle.isPending} onClick={() => toggle.mutate(!enabled)}
          className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${enabled ? 'bg-indigo-600' : 'bg-gray-600'} disabled:opacity-50`}
        >
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${enabled ? 'translate-x-6' : 'translate-x-1'}`} />
        </button>
      </div>
      <p className="text-xs text-gray-500">{t('voiceId.privacy')}</p>

      <div className="space-y-2">
        {(data?.voices ?? []).map((v) => (
          <VoiceRow key={v.id} voice={v} satellites={satellites.map((s) => s.entityId)} persons={persons}
            users={users.data ?? []} onChanged={() => refresh()} onError={fail} />
        ))}
        <div className="flex gap-2">
          <input className={`${input} flex-1`} placeholder={t('voiceId.newPlaceholder')} value={newName} maxLength={100}
            onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && newName.trim()) create.mutate(); }} />
          <button className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm bg-gray-700 hover:bg-gray-600 text-gray-100 disabled:opacity-50"
            disabled={!newName.trim() || create.isPending} onClick={() => create.mutate()}>
            <Plus size={14} />{t('voiceId.add')}
          </button>
        </div>
      </div>

      {!!data?.recognitions.length && (
        <div>
          <p className="text-xs font-semibold text-gray-400 mb-1">{t('voiceId.recent')}</p>
          <ul className="text-xs space-y-0.5 max-h-48 overflow-y-auto">
            {data.recognitions.map((r, i) => (
              <li key={i} className="flex gap-2 text-gray-300">
                <span className="text-gray-500 whitespace-nowrap">{new Date(r.at).toLocaleTimeString()}</span>
                <span className="truncate">{r.satellite ?? '—'}</span>
                <span className={r.name ? 'text-green-400' : 'text-gray-500'}>{r.name ?? t('voiceId.unknown')}</span>
                {r.score !== null && <span className="text-gray-500">{t('voiceId.score', { score: r.score.toFixed(2), next: (r.second ?? 0).toFixed(2) })}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {data?.clearance && (
        <ClearanceSection policy={data.clearance} recognition={enabled} voices={data.voices} onSaved={refresh} onError={fail} />
      )}
      {error && <p className="text-xs text-red-400 flex items-center gap-1.5"><AlertTriangle size={13} />{error}</p>}
    </div>
  );
}

const lines = (s: string) => s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);

/** Which actions by voice need a recognised voice: off by default; the threshold, who, and what is protected. */
function ClearanceSection({ policy, recognition, voices, onSaved, onError }: {
  policy: VoiceClearancePolicy; recognition: boolean; voices: VoiceProfileView[];
  onSaved: (d: VoiceIdState) => void; onError: (e: any) => void;
}) {
  const { t } = useTranslation('settings');
  const [draft, setDraft] = useState(policy);
  const [tools, setTools] = useState(policy.tools.join('\n'));
  const [entities, setEntities] = useState(policy.entities.join('\n'));
  useEffect(() => { setDraft(policy); setTools(policy.tools.join('\n')); setEntities(policy.entities.join('\n')); }, [JSON.stringify(policy)]);
  const save = useMutation({
    mutationFn: (p: Partial<VoiceClearancePolicy>) => voiceIdApi.setClearance(p),
    onSuccess: onSaved, onError,
  });
  const next = { ...draft, tools: lines(tools), entities: lines(entities) };
  const dirty = JSON.stringify(next) !== JSON.stringify(policy);
  const togglePerson = (id: string) => setDraft({ ...draft, people: draft.people.includes(id) ? draft.people.filter((p) => p !== id) : [...draft.people, id] });

  return (
    <div className="border-t border-gray-700/50 pt-4 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <ShieldCheck size={18} className="text-indigo-400 mt-0.5 flex-shrink-0" />
          <div>
            <h4 className="text-sm font-semibold text-gray-100">{t('voiceId.clearance.title')}</h4>
            <p className="text-xs text-gray-400 mt-1 max-w-xl">{t('voiceId.clearance.hint')}</p>
          </div>
        </div>
        <button
          role="switch" aria-checked={policy.enabled} disabled={save.isPending} onClick={() => save.mutate({ enabled: !policy.enabled })}
          className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${policy.enabled ? 'bg-indigo-600' : 'bg-gray-600'} disabled:opacity-50`}
        >
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${policy.enabled ? 'translate-x-6' : 'translate-x-1'}`} />
        </button>
      </div>
      {policy.enabled && !recognition && (
        <p className="text-xs text-amber-400 flex items-center gap-1.5"><AlertTriangle size={13} />{t('voiceId.clearance.recognitionOff')}</p>
      )}

      <label className="block text-xs text-gray-400">{t('voiceId.clearance.minScore')}
        <div className="flex items-center gap-2 mt-1">
          <input type="number" min={0} max={1} step={0.01} className={`${input} w-24`} value={draft.minScore}
            onChange={(e) => setDraft({ ...draft, minScore: Number(e.target.value) })} />
          <span className="text-gray-500">{t('voiceId.clearance.minScoreHint')}</span>
        </div>
      </label>

      <div className="text-xs text-gray-400">
        <p>{t('voiceId.clearance.people')}</p>
        <div className="flex flex-wrap gap-3 mt-1">
          {voices.map((v) => (
            <label key={v.id} className="inline-flex items-center gap-1.5 text-gray-300">
              <input type="checkbox" checked={draft.people.includes(v.id)} onChange={() => togglePerson(v.id)} />{v.name}
            </label>
          ))}
        </div>
        <p className="text-gray-500 mt-1">{draft.people.length ? t('voiceId.clearance.peopleSome') : t('voiceId.clearance.peopleAny')}</p>
      </div>

      <label className="flex items-center gap-2 text-xs text-gray-300">
        <input type="checkbox" checked={draft.sensitiveTargets} onChange={(e) => setDraft({ ...draft, sensitiveTargets: e.target.checked })} />
        {t('voiceId.clearance.sensitive')}
      </label>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="block text-xs text-gray-400">{t('voiceId.clearance.entities')}
          <textarea className={`${input} w-full mt-1 font-mono`} rows={4} value={entities} placeholder={'lock\ncover.garage*\nswitch.gate'}
            onChange={(e) => setEntities(e.target.value)} />
          <span className="text-gray-500">{t('voiceId.clearance.entitiesHint')}</span>
        </label>
        <label className="block text-xs text-gray-400">{t('voiceId.clearance.tools')}
          <textarea className={`${input} w-full mt-1 font-mono`} rows={4} value={tools} placeholder={'ha_notify\nskill_gmail_*\nmcp_*_send_*'}
            onChange={(e) => setTools(e.target.value)} />
          <span className="text-gray-500">{t('voiceId.clearance.toolsHint')}</span>
        </label>
      </div>

      <p className="text-xs text-gray-500">{t('voiceId.clearance.limits')}</p>
      <div className="flex justify-end">
        <button className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50"
          disabled={!dirty || save.isPending} onClick={() => save.mutate(next)}>
          {save.isPending && <Loader2 size={14} className="animate-spin" />}{t('voiceId.clearance.save')}
        </button>
      </div>
    </div>
  );
}

function VoiceRow({ voice, satellites, persons, users, onChanged, onError }: {
  voice: VoiceProfileView; satellites: string[]; persons: Array<{ entityId: string; name: string }>;
  users: Array<{ id: string; name: string }>; onChanged: () => void; onError: (e: any) => void;
}) {
  const { t } = useTranslation('settings');
  const [satellite, setSatellite] = useState(satellites[0] ?? '');
  const update = useMutation({ mutationFn: (p: Parameters<typeof voiceIdApi.update>[1]) => voiceIdApi.update(voice.id, p), onSuccess: onChanged, onError });
  const enroll = useMutation({ mutationFn: () => voiceIdApi.enroll(voice.id, satellite || satellites[0]), onSuccess: onChanged, onError });
  const cancel = useMutation({ mutationFn: () => voiceIdApi.cancelEnroll(voice.id), onSuccess: onChanged, onError });
  const clear = useMutation({ mutationFn: () => voiceIdApi.clearSamples(voice.id), onSuccess: onChanged, onError });
  const remove = useMutation({ mutationFn: () => voiceIdApi.remove(voice.id), onSuccess: onChanged, onError });
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-gray-700/60 rounded-lg p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-gray-100 mr-auto">{voice.name}</span>
        <button className="inline-flex items-center gap-0.5 text-xs text-gray-500 hover:text-gray-300 disabled:hover:text-gray-500"
          disabled={!voice.sampleCount} onClick={() => setOpen(!open)} title={t('voiceId.showSamples')}>
          {voice.sampleCount ? (open ? <ChevronDown size={12} /> : <ChevronRight size={12} />) : null}
          {t('voiceId.samples', { count: voice.sampleCount })}
        </button>
        <button className="text-gray-500 hover:text-gray-200" title={t('voiceId.clear')} disabled={!voice.sampleCount}
          onClick={() => { if (window.confirm(t('voiceId.clearConfirm', { name: voice.name }))) clear.mutate(); }}><RotateCcw size={14} /></button>
        <button className="text-gray-500 hover:text-red-400" title={t('voiceId.remove')}
          onClick={() => { if (window.confirm(t('voiceId.removeConfirm', { name: voice.name }))) remove.mutate(); }}><Trash2 size={14} /></button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <label className="text-xs text-gray-400">{t('voiceId.haPerson')}
          <select className={`${input} w-full mt-1`} value={voice.haPerson ?? ''} onChange={(e) => update.mutate({ haPerson: e.target.value || null })}>
            <option value="">—</option>
            {persons.map((p) => <option key={p.entityId} value={p.entityId}>{p.name}</option>)}
          </select>
        </label>
        <label className="text-xs text-gray-400">{t('voiceId.user')}
          <select className={`${input} w-full mt-1`} value={voice.userId ?? ''} onChange={(e) => update.mutate({ userId: e.target.value || null })}>
            <option value="">—</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </label>
      </div>
      {open && !!voice.sampleCount && <SampleList voice={voice} onChanged={onChanged} onError={onError} />}
      {voice.enrolling ? (
        <div className="flex items-center gap-2 text-xs text-indigo-300">
          <Mic size={13} className="animate-pulse" />
          <span>{t('voiceId.enrolling', { satellite: voice.enrolling.satellite, left: voice.enrolling.left })}</span>
          <button className="ml-auto text-gray-400 hover:text-gray-200" onClick={() => cancel.mutate()}><X size={13} /></button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <select className={`${input} flex-1`} value={satellite} onChange={(e) => setSatellite(e.target.value)} disabled={!satellites.length}>
            {!satellites.length && <option value="">{t('voiceId.noSatellites')}</option>}
            {satellites.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <button className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50"
            disabled={!satellites.length || enroll.isPending} onClick={() => enroll.mutate()}>
            {enroll.isPending ? <Loader2 size={14} className="animate-spin" /> : <Mic size={14} />}{t('voiceId.learn')}
          </button>
        </div>
      )}
    </div>
  );
}

/** A voice's samples, oldest first: how close each is to the voice's other samples and to the closest other voice. */
function SampleList({ voice, onChanged, onError }: { voice: VoiceProfileView; onChanged: () => void; onError: (e: any) => void }) {
  const { t } = useTranslation('settings');
  const qc = useQueryClient();
  const scores = useQuery({ queryKey: ['voice-id-samples', voice.id, voice.sampleCount], queryFn: () => voiceIdApi.samples(voice.id) });
  const drop = useMutation({
    mutationFn: (index: number) => voiceIdApi.removeSample(voice.id, index),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['voice-id-samples', voice.id] }); onChanged(); },
    onError,
  });
  if (scores.isLoading) return <Loader2 size={14} className="animate-spin text-gray-500" />;
  const list = scores.data ?? [];
  return (
    <div className="text-xs space-y-1">
      <p className="text-gray-500">{t('voiceId.samplesHint')}</p>
      <ul className="space-y-0.5">
        {list.map((s, i) => (
          <li key={i} className={`flex items-center gap-2 rounded px-1.5 py-0.5 ${s.suspect ? 'bg-amber-500/15 text-amber-300' : 'text-gray-300'}`}>
            <span className="text-gray-500 w-6">#{i + 1}</span>
            <span>{t('voiceId.sampleOwn', { score: s.own === null ? '—' : s.own.toFixed(2) })}</span>
            {s.other && <span className="text-gray-400">{t('voiceId.sampleOther', { name: s.other.name, score: s.other.score.toFixed(2) })}</span>}
            {s.suspect && <span className="inline-flex items-center gap-1"><AlertTriangle size={12} />{t('voiceId.sampleSuspect')}</span>}
            <button className="ml-auto text-gray-500 hover:text-red-400 disabled:opacity-50" title={t('voiceId.sampleRemove')} disabled={drop.isPending}
              onClick={() => { if (window.confirm(t('voiceId.sampleRemoveConfirm', { n: i + 1, name: voice.name }))) drop.mutate(i); }}>
              <Trash2 size={12} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
