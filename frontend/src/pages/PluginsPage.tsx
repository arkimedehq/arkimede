// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Settings → Plugins (specs/PLUGINS.md, specs/EXTENSION_AUDIENCE.md): every user installs their own copy (from the
 * registry or a signed ZIP) and manages it — settings, people, events, enable, disable, uninstall. The admin sees every
 * copy, installs one for a user, approves what touches the network, the backend or resources (with a scope and an
 * agent for a shared plugin) and keeps the keys trusted for signatures.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, Check, ChevronLeft, Download, KeyRound, Loader2, Power, PowerOff, Puzzle, RefreshCw, ShieldCheck, Trash2, Upload, X,
} from 'lucide-react';
import {
  pluginsApi, type PluginAudience, type PluginDetail, type PluginPermissions, type PluginScope, type PluginView, type TrustLevel,
} from '../api/plugins';
import { teamsApi } from '../api/teams';
import { agentsApi } from '../api/agents';
import { adminUsersApi } from '../api/adminUsers';
import { appConfigApi } from '../api/appConfig';
import { useStore } from '../store/useStore';

const card = 'bg-gray-800/50 border border-gray-700/50 rounded-xl p-5';
const input = 'w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500';
const button = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors disabled:opacity-50';
const primary = `${button} bg-blue-600 hover:bg-blue-500 text-white`;
const secondary = `${button} bg-gray-700 hover:bg-gray-600 text-gray-100`;
const danger = `${button} bg-red-600/80 hover:bg-red-600 text-white`;

const errorOf = (err: any, fallback: string) => {
  const m = err?.response?.data?.message;
  return Array.isArray(m) ? m.join(', ') : (m ?? fallback);
};

function StatusBadge({ status }: { status: PluginView['status'] }) {
  const { t } = useTranslation('settings');
  const color = {
    active: 'bg-green-500/15 text-green-400', pending_approval: 'bg-amber-500/15 text-amber-400',
    disabled: 'bg-gray-500/15 text-gray-400', error: 'bg-red-500/15 text-red-400',
  }[status];
  return <span className={`text-xs px-2 py-0.5 rounded-full ${color}`}>{t(`plugins.status.${status}`)}</span>;
}

function TrustBadge({ trust }: { trust: TrustLevel }) {
  const { t } = useTranslation('settings');
  const color = trust === 'official' ? 'text-blue-400' : trust === 'verified' ? 'text-green-400' : trust === 'community' ? 'text-gray-300' : 'text-amber-400';
  return <span className={`inline-flex items-center gap-1 text-xs ${color}`}><ShieldCheck size={12} />{t(`plugins.trust.${trust}`)}</span>;
}

function AudienceBadge({ audience }: { audience: PluginAudience | undefined }) {
  const { t } = useTranslation('settings');
  const a = audience ?? 'shared';
  return <span className={`text-xs px-2 py-0.5 rounded-full ${a === 'personal' ? 'bg-purple-500/15 text-purple-300' : 'bg-gray-500/15 text-gray-300'}`}>{t(`plugins.audience.${a}`)}</span>;
}

/** The current user and, for an admin, every user (owners, "install for", people). */
function usePeople() {
  const me = useStore((s) => s.user);
  const isAdmin = me?.role === 'admin';
  const users = useQuery({ queryKey: ['admin-users-all'], queryFn: adminUsersApi.listAll, enabled: isAdmin });
  const list = isAdmin ? (users.data ?? []).map((u) => ({ id: u.id, name: u.name })) : me ? [{ id: me.id, name: me.name ?? me.email }] : [];
  return { me, isAdmin, users: list, name: (id: string | null) => list.find((u) => u.id === id)?.name ?? id };
}

export function PluginsSection() {
  const { t } = useTranslation('settings');
  const [selected, setSelected] = useState<string | null>(null);
  const [forUser, setForUser] = useState<string | null>(null);
  const { isAdmin, me, users, name } = usePeople();
  const { data: plugins, isLoading } = useQuery({ queryKey: ['plugin-installs'], queryFn: pluginsApi.list });

  if (selected) return <PluginDetailView id={selected} onBack={() => setSelected(null)} />;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-gray-100 flex items-center gap-2"><Puzzle size={18} />{t('plugins.title')}</h2>
        <p className="text-sm text-gray-400 mt-1">{t('plugins.intro')}</p>
      </div>
      {isAdmin && (
        <label className="block text-xs text-gray-400">{t('plugins.installFor')}
          <select className={`${input} mt-1`} value={forUser ?? ''} onChange={(e) => setForUser(e.target.value || null)}>
            <option value="">{t('plugins.installForMe')}</option>
            {users.filter((u) => u.id !== me?.id).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </label>
      )}
      <InstallCard forUser={forUser} isAdmin={isAdmin} onInstalled={(id) => setSelected(id)} />
      <div className={card}>
        <h3 className="text-sm font-semibold text-gray-100 mb-3">{t('plugins.installed')}</h3>
        {isLoading ? <Loader2 className="animate-spin text-gray-500" size={16} /> : !plugins?.length ? (
          <p className="text-sm text-gray-500">{t('plugins.none')}</p>
        ) : (
          <ul className="divide-y divide-gray-700/50">
            {plugins.map((p) => (
              <li key={p.id}>
                <button onClick={() => setSelected(p.id)} className="w-full text-left py-3 flex items-start gap-3 hover:bg-gray-800/40 rounded-lg px-2">
                  <Puzzle size={16} className="text-gray-400 mt-0.5 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-gray-100">{p.label}</span>
                      <span className="text-xs text-gray-500">{p.name} {p.version}</span>
                      <StatusBadge status={p.status} />
                      <AudienceBadge audience={p.audience} />
                      <TrustBadge trust={p.trust} />
                    </div>
                    <p className="text-xs text-gray-400 mt-0.5 truncate">{p.description}</p>
                    {isAdmin && p.ownerId !== me?.id && <p className="text-xs text-gray-500 mt-0.5">{t('plugins.ownedBy', { name: name(p.ownerId) })}</p>}
                    {p.statusDetail && <p className="text-xs text-amber-400 mt-0.5">{p.statusDetail}</p>}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <RegistryCard forUser={forUser} onInstalled={(id) => setSelected(id)} />
      {isAdmin && <TrustCard />}
    </div>
  );
}

function InstallCard({ forUser, isAdmin, onInstalled }: { forUser: string | null; isAdmin: boolean; onInstalled: (id: string) => void }) {
  const { t } = useTranslation('settings');
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [signature, setSignature] = useState('');
  const [error, setError] = useState<string | null>(null);
  const upload = useMutation({
    mutationFn: () => pluginsApi.upload(file!, signature, forUser),
    onSuccess: (d) => {
      setError(null);
      setFile(null);
      setSignature('');
      qc.invalidateQueries({ queryKey: ['plugin-installs'] });
      onInstalled(d.plugin.id);
    },
    onError: (err) => setError(errorOf(err, t('plugins.installError'))),
  });
  return (
    <div className={card}>
      <h3 className="text-sm font-semibold text-gray-100 mb-1 flex items-center gap-2"><Upload size={15} />{t('plugins.upload')}</h3>
      <p className="text-xs text-gray-400 mb-3">{t(isAdmin ? 'plugins.uploadHint' : 'plugins.uploadHintUser')}</p>
      <div className="space-y-2">
        <input type="file" accept=".zip,application/zip" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-sm text-gray-300" />
        <input className={input} placeholder={t('plugins.signaturePlaceholder')} value={signature} onChange={(e) => setSignature(e.target.value)} />
        <button className={primary} disabled={!file || upload.isPending} onClick={() => upload.mutate()}>
          {upload.isPending ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}{t('plugins.install')}
        </button>
        {error && <p className="text-xs text-red-400 flex items-center gap-1.5"><AlertTriangle size={13} />{error}</p>}
      </div>
    </div>
  );
}

function RegistryCard({ forUser, onInstalled }: { forUser: string | null; onInstalled: (id: string) => void }) {
  const { t } = useTranslation('settings');
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const registry = useQuery({ queryKey: ['plugin-registry'], queryFn: () => pluginsApi.registry(), enabled: open, retry: false });
  const install = useMutation({
    mutationFn: (name: string) => pluginsApi.installFromRegistry(name, forUser),
    onSuccess: (d: any) => {
      setError(null);
      qc.invalidateQueries({ queryKey: ['plugin-installs'] });
      onInstalled(d.plugin.id);
    },
    onError: (err) => setError(errorOf(err, t('plugins.installError'))),
  });
  return (
    <div className={card}>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-100 flex items-center gap-2"><Download size={15} />{t('plugins.registry')}</h3>
        <button className={secondary} onClick={() => (open ? registry.refetch() : setOpen(true))}>
          <RefreshCw size={14} />{open ? t('plugins.refresh') : t('plugins.browse')}
        </button>
      </div>
      {open && (
        <div className="mt-3">
          {registry.isLoading ? <Loader2 className="animate-spin text-gray-500" size={16} /> : registry.error ? (
            <p className="text-xs text-red-400">{errorOf(registry.error, t('plugins.registryError'))}</p>
          ) : !registry.data?.length ? <p className="text-sm text-gray-500">{t('plugins.registryEmpty')}</p> : (
            <ul className="divide-y divide-gray-700/50">
              {registry.data.map((p) => (
                <li key={p.name} className="py-2 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-gray-100 flex items-center gap-2 flex-wrap">{p.label ?? p.name} <span className="text-xs text-gray-500">{p.version}</span><AudienceBadge audience={p.audience} /></div>
                    {p.description && <div className="text-xs text-gray-400 truncate">{p.description}</div>}
                  </div>
                  <button className={secondary} disabled={install.isPending} onClick={() => install.mutate(p.name)}>{t('plugins.install')}</button>
                </li>
              ))}
            </ul>
          )}
          {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
        </div>
      )}
    </div>
  );
}

function TrustCard() {
  const { t } = useTranslation('settings');
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['plugin-trust'], queryFn: pluginsApi.trust });
  const [form, setForm] = useState({ keyId: '', level: 'verified' as 'verified' | 'community', publicKey: '' });
  const [error, setError] = useState<string | null>(null);
  const refresh = (d: any) => { setError(null); qc.setQueryData(['plugin-trust'], d); };
  const unsigned = useMutation({ mutationFn: (on: boolean) => pluginsApi.setAllowUnsigned(on), onSuccess: refresh, onError: (e) => setError(errorOf(e, t('plugins.saveError'))) });
  const add = useMutation({
    mutationFn: () => pluginsApi.addKey(form),
    onSuccess: (d) => { refresh(d); setForm({ keyId: '', level: 'verified', publicKey: '' }); },
    onError: (e) => setError(errorOf(e, t('plugins.saveError'))),
  });
  const remove = useMutation({ mutationFn: (id: string) => pluginsApi.removeKey(id), onSuccess: refresh });
  const allow = data?.allowUnsigned ?? false;
  return (
    <div className={card}>
      <h3 className="text-sm font-semibold text-gray-100 flex items-center gap-2"><KeyRound size={15} />{t('plugins.trustTitle')}</h3>
      <p className="text-xs text-gray-400 mt-1">{t('plugins.trustHint')}</p>
      <label className="mt-3 flex items-center justify-between gap-3">
        <span className="text-sm text-gray-200">{t('plugins.allowUnsigned')}</span>
        <button
          role="switch" aria-checked={allow} disabled={unsigned.isPending} onClick={() => unsigned.mutate(!allow)}
          className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${allow ? 'bg-amber-600' : 'bg-gray-600'}`}
        >
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${allow ? 'translate-x-6' : 'translate-x-1'}`} />
        </button>
      </label>
      {allow && <p className="text-xs text-amber-400 mt-1 flex items-center gap-1.5"><AlertTriangle size={12} />{t('plugins.allowUnsignedWarning')}</p>}
      <ul className="mt-3 space-y-1">
        {(data?.keys ?? []).map((k) => (
          <li key={k.keyId} className="flex items-center gap-2 text-xs text-gray-300">
            <ShieldCheck size={12} /><span className="font-mono">{k.keyId}</span>
            <span className="text-gray-500">{t(`plugins.trust.${k.level}`)}</span>
            {k.official ? <span className="text-gray-500">({t('plugins.fromEnvironment')})</span> : (
              <button className="ml-auto text-gray-500 hover:text-red-400" onClick={() => k.id && remove.mutate(k.id)} title={t('plugins.removeKey')}><Trash2 size={12} /></button>
            )}
          </li>
        ))}
      </ul>
      <div className="mt-3 grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2">
        <input className={input} placeholder={t('plugins.keyId')} value={form.keyId} onChange={(e) => setForm({ ...form, keyId: e.target.value })} />
        <select className={input} value={form.level} onChange={(e) => setForm({ ...form, level: e.target.value as 'verified' | 'community' })}>
          <option value="verified">{t('plugins.trust.verified')}</option>
          <option value="community">{t('plugins.trust.community')}</option>
        </select>
        <textarea className={`${input} sm:col-span-2 font-mono`} rows={2} placeholder={t('plugins.publicKey')} value={form.publicKey} onChange={(e) => setForm({ ...form, publicKey: e.target.value })} />
        <button className={secondary} disabled={!form.keyId || !form.publicKey || add.isPending} onClick={() => add.mutate()}>{t('plugins.addKey')}</button>
      </div>
      {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
    </div>
  );
}

function PermissionList({ permissions }: { permissions: PluginPermissions }) {
  const { t } = useTranslation('settings');
  const rows: Array<[string, string[]]> = [
    ['services', permissions.services], ['subscribes', permissions.subscribes], ['network', permissions.network],
    ['daemons', permissions.daemons], ['routes', permissions.routes], ['pages', permissions.pages],
  ];
  return (
    <dl className="grid grid-cols-1 sm:grid-cols-[10rem_1fr] gap-x-3 gap-y-1 text-xs">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-gray-500">{t(`plugins.perm.${k}`)}</dt>
          <dd className="text-gray-200 break-words">{v.length ? v.join(', ') : '—'}</dd>
        </div>
      ))}
      <dt className="text-gray-500">{t('plugins.perm.storage')}</dt>
      <dd className="text-gray-200">{permissions.storageKb ? `${permissions.storageKb} KB` : '—'}</dd>
    </dl>
  );
}

/**
 * Scope and agent: the scope (team, organization) is the admin's and only for a shared plugin — a personal one is always
 * its owner's alone; the agent answers `agent.ask` (of a personal plugin: one of its owner's agents).
 */
function AccessForm({ detail, onSave, saveLabel, pending, isAdmin }: {
  detail: PluginDetail; onSave: (p: { scope?: PluginScope; teamId?: string | null; agentId: string | null }) => void; saveLabel: string; pending: boolean; isAdmin: boolean;
}) {
  const { t } = useTranslation('settings');
  const [scope, setScope] = useState<PluginScope>(detail.plugin.scope);
  const [teamId, setTeamId] = useState<string | null>(detail.plugin.teamId);
  const [agentId, setAgentId] = useState<string | null>(detail.plugin.agentId);
  const shareable = isAdmin && detail.plugin.audience !== 'personal';
  const teams = useQuery({ queryKey: ['teams-admin'], queryFn: teamsApi.list, enabled: shareable });
  const agents = useQuery({ queryKey: ['agents'], queryFn: agentsApi.list });
  const services: string[] = detail.manifest?.services ?? [];
  const askUsed = services.includes('agent.ask');
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 items-end">
      {shareable ? (
        <label className="text-xs text-gray-400">{t('plugins.scope')}
          <select className={`${input} mt-1`} value={scope} onChange={(e) => setScope(e.target.value as PluginScope)}>
            {(['org', 'team', 'personal'] as PluginScope[]).map((s) => <option key={s} value={s}>{t(`plugins.scopes.${s}`)}</option>)}
          </select>
        </label>
      ) : (
        <p className="text-xs text-gray-400 sm:col-span-3">{t(detail.plugin.audience === 'personal' ? 'plugins.personalOnly' : 'plugins.scopeByAdmin')}</p>
      )}
      {shareable && scope === 'team' && (
        <label className="text-xs text-gray-400">{t('plugins.team')}
          <select className={`${input} mt-1`} value={teamId ?? ''} onChange={(e) => setTeamId(e.target.value || null)}>
            <option value="">—</option>
            {(teams.data ?? []).map((tm) => <option key={tm.id} value={tm.id}>{tm.name}</option>)}
          </select>
        </label>
      )}
      {askUsed && (
        <label className="text-xs text-gray-400">{t('plugins.agent')}
          <select className={`${input} mt-1`} value={agentId ?? ''} onChange={(e) => setAgentId(e.target.value || null)}>
            <option value="">{t('plugins.defaultAgent')}</option>
            {(agents.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
      )}
      <button className={primary} disabled={pending || (shareable && scope === 'team' && !teamId)}
        onClick={() => onSave(shareable ? { scope, teamId: scope === 'team' ? teamId : null, agentId } : { agentId })}>
        {pending ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}{saveLabel}
      </button>
    </div>
  );
}

function PluginDetailView({ id, onBack }: { id: string; onBack: () => void }) {
  const { t } = useTranslation('settings');
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const { isAdmin, me, name } = usePeople();
  const { data: detail, isLoading } = useQuery({ queryKey: ['plugin-install', id], queryFn: () => pluginsApi.get(id) });
  const refresh = () => {
    setError(null);
    qc.invalidateQueries({ queryKey: ['plugin-install', id] });
    qc.invalidateQueries({ queryKey: ['plugin-installs'] });
    qc.invalidateQueries({ queryKey: ['plugin-pages'] });
  };
  const fail = (e: unknown) => setError(errorOf(e, t('plugins.saveError')));
  const approve = useMutation({ mutationFn: (p: any) => pluginsApi.approve(id, p), onSuccess: refresh, onError: fail });
  const access = useMutation({ mutationFn: (p: any) => pluginsApi.setAccess(id, p), onSuccess: refresh, onError: fail });
  const reject = useMutation({ mutationFn: () => pluginsApi.reject(id), onSuccess: () => { refresh(); }, onError: fail });
  const toggle = useMutation({ mutationFn: (on: boolean) => (on ? pluginsApi.enable(id) : pluginsApi.disable(id)), onSuccess: refresh, onError: fail });
  const uninstall = useMutation({ mutationFn: () => pluginsApi.uninstall(id), onSuccess: () => { refresh(); onBack(); }, onError: fail });

  if (isLoading || !detail) return <Loader2 className="animate-spin text-gray-500" size={18} />;
  const p = detail.plugin;
  return (
    <div className="space-y-5">
      <button onClick={onBack} className="text-sm text-gray-400 hover:text-gray-200 inline-flex items-center gap-1"><ChevronLeft size={14} />{t('plugins.back')}</button>
      <div className={card}>
        <div className="flex items-start gap-3">
          <Puzzle size={20} className="text-gray-400 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-base font-semibold text-gray-100">{p.label}</h2>
              <span className="text-xs text-gray-500">{p.name} {p.version}</span>
              <StatusBadge status={p.status} />
              <AudienceBadge audience={p.audience} />
              <TrustBadge trust={p.trust} />
            </div>
            <p className="text-sm text-gray-400 mt-1">{p.description}</p>
            {p.ownerId !== me?.id && <p className="text-xs text-gray-500 mt-1">{t('plugins.ownedBy', { name: name(p.ownerId) })}</p>}
            {p.statusDetail && <p className="text-xs text-amber-400 mt-1">{p.statusDetail}</p>}
            <p className="text-[11px] text-gray-600 mt-1 font-mono break-all">sha256 {p.sha256}</p>
          </div>
        </div>
        {error && <p className="text-xs text-red-400 mt-3 flex items-center gap-1.5"><AlertTriangle size={13} />{error}</p>}
      </div>

      {p.pending && (
        <div className={`${card} border-amber-500/40`}>
          <h3 className="text-sm font-semibold text-amber-300">{t('plugins.review')}</h3>
          {detail.newPermissions.length > 0 && detail.newPermissions[0] !== '(first approval)' && (
            <p className="text-xs text-amber-400 mt-1">{t('plugins.asksMore')}: {detail.newPermissions.join(', ')}</p>
          )}
          <div className="mt-3"><PermissionList permissions={detail.permissions} /></div>
          {p.trust === 'unsigned' && <p className="text-xs text-amber-400 mt-3 flex items-center gap-1.5"><AlertTriangle size={12} />{t('plugins.unsignedWarning')}</p>}
          {isAdmin ? (
            <>
              <div className="mt-4"><AccessForm isAdmin detail={detail} pending={approve.isPending} saveLabel={t('plugins.approve')} onSave={(a) => approve.mutate(a)} /></div>
              <button className={`${secondary} mt-3`} disabled={reject.isPending} onClick={() => reject.mutate()}><X size={14} />{t('plugins.reject')}</button>
            </>
          ) : <p className="text-xs text-amber-300 mt-3">{t('plugins.waitingAdmin')}</p>}
        </div>
      )}

      {!p.pending && p.grants && (
        <div className={card}>
          <h3 className="text-sm font-semibold text-gray-100 mb-3">{t('plugins.access')}</h3>
          <AccessForm key={`${p.scope}-${p.teamId}-${p.agentId}`} isAdmin={isAdmin} detail={detail} pending={access.isPending} saveLabel={t('plugins.save')} onSave={(a) => access.mutate(a)} />
          <h4 className="text-xs font-semibold text-gray-400 mt-4 mb-2">{t('plugins.granted')}</h4>
          <PermissionList permissions={p.grants} />
        </div>
      )}

      <SettingsCard id={id} detail={detail} onSaved={refresh} />

      {!p.pending && (
        <div className={card}>
          <h3 className="text-sm font-semibold text-gray-100 mb-2">{t('plugins.contents')}</h3>
          <ul className="text-xs text-gray-300 space-y-1">
            {detail.contents.skills.map((s) => <li key={s.id}>{t('plugins.skill')}: {s.name} <span className="text-gray-500">({s.status})</span></li>)}
            {detail.contents.mcp.map((m) => <li key={m.id}>MCP: {m.name}</li>)}
            {detail.contents.flows.map((f) => <li key={f.id}>{t('plugins.flow')}: {f.name} <span className="text-gray-500">({f.enabled ? t('plugins.on') : t('plugins.off')})</span></li>)}
            {!detail.contents.skills.length && !detail.contents.mcp.length && !detail.contents.flows.length && <li className="text-gray-500">—</li>}
          </ul>
        </div>
      )}

      <UpdateCard id={id} onUpdated={refresh} />

      {!p.pending && <PeopleCard id={id} detail={detail} onSaved={refresh} />}
      {!p.pending && <EventsCard id={id} />}

      <div className={`${card} flex flex-wrap gap-2`}>
        {p.status === 'active' && <button className={secondary} disabled={toggle.isPending} onClick={() => toggle.mutate(false)}><PowerOff size={14} />{t('plugins.disable')}</button>}
        {(p.status === 'disabled' || p.status === 'error') && !p.pending && <button className={secondary} disabled={toggle.isPending} onClick={() => toggle.mutate(true)}><Power size={14} />{t('plugins.enable')}</button>}
        <button className={danger} disabled={uninstall.isPending} onClick={() => { if (window.confirm(t('plugins.uninstallConfirm', { name: p.label }))) uninstall.mutate(); }}>
          <Trash2 size={14} />{t('plugins.uninstall')}
        </button>
      </div>
    </div>
  );
}

/** Updates (or reinstalls) this copy from a package of the same plugin: the backend keeps its settings and people. */
function UpdateCard({ id, onUpdated }: { id: string; onUpdated: () => void }) {
  const { t } = useTranslation('settings');
  const [file, setFile] = useState<File | null>(null);
  const [signature, setSignature] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const update = useMutation({
    mutationFn: () => pluginsApi.update(id, file!, signature),
    onSuccess: (d) => {
      setError(null);
      setFile(null);
      setSignature('');
      setDone(t('plugins.updateDone', { version: d.plugin.version }));
      onUpdated();
    },
    onError: (err) => { setDone(null); setError(errorOf(err, t('plugins.installError'))); },
  });
  return (
    <div className={card}>
      <h3 className="text-sm font-semibold text-gray-100 mb-1 flex items-center gap-2"><Upload size={15} />{t('plugins.update')}</h3>
      <p className="text-xs text-gray-400 mb-3">{t('plugins.updateHint')}</p>
      <div className="space-y-2">
        <input key={done ?? ''} type="file" accept=".zip,application/zip" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-sm text-gray-300" />
        <input className={input} placeholder={t('plugins.signaturePlaceholder')} value={signature} onChange={(e) => setSignature(e.target.value)} />
        <button className={primary} disabled={!file || update.isPending} onClick={() => update.mutate()}>
          {update.isPending ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}{t('plugins.updateButton')}
        </button>
        {done && <p className="text-xs text-emerald-400">{done}</p>}
        {error && <p className="text-xs text-red-400 flex items-center gap-1.5"><AlertTriangle size={13} />{error}</p>}
      </div>
    </div>
  );
}

function SettingsCard({ id, detail, onSaved }: { id: string; detail: PluginDetail; onSaved: () => void }) {
  const { t } = useTranslation('settings');
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => pluginsApi.setSettings(id, values),
    onSuccess: () => { setValues({}); setError(null); onSaved(); },
    onError: (e) => setError(errorOf(e, t('plugins.saveError'))),
  });
  if (!detail.settings.length) return null;
  return (
    <div className={card}>
      <h3 className="text-sm font-semibold text-gray-100 mb-3">{t('plugins.settings')}</h3>
      <div className="space-y-3">
        {detail.settings.map((s) => (
          <label key={s.key} className="block text-xs text-gray-400">
            <span className="font-mono text-gray-300">{s.key}</span>{s.required && <span className="text-red-400"> *</span>}
            {s.description && <span className="ml-2">{s.description}</span>}
            <input
              className={`${input} mt-1`}
              type={s.secret ? 'password' : 'text'}
              autoComplete="off"
              placeholder={s.secret ? (s.set ? t('plugins.secretSet') : t('plugins.secretUnset')) : ''}
              value={values[s.key] ?? (s.secret ? '' : (s.value ?? ''))}
              onChange={(e) => setValues({ ...values, [s.key]: e.target.value })}
            />
          </label>
        ))}
      </div>
      <button className={`${primary} mt-3`} disabled={!Object.keys(values).length || save.isPending} onClick={() => save.mutate()}>{t('plugins.save')}</button>
      {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
    </div>
  );
}

const EMPTY_PERSON = { externalId: '', userId: '', haPerson: '', authorized: false };

function PeopleCard({ id, detail, onSaved }: { id: string; detail: PluginDetail; onSaved: () => void }) {
  const { t } = useTranslation('settings');
  const { users, name, isAdmin } = usePeople();
  const [form, setForm] = useState(EMPTY_PERSON);
  const [error, setError] = useState<string | null>(null);
  // The people the plugin knows (its people script): picked from a list that also takes an id typed by hand.
  const known = useQuery({ queryKey: ['plugin-known-people', id], queryFn: () => pluginsApi.knownPeople(id), staleTime: 60_000 });
  const qc = useQueryClient();
  const reload = useMutation({ mutationFn: () => pluginsApi.knownPeople(id, true), onSuccess: (d) => qc.setQueryData(['plugin-known-people', id], d) });
  // Home Assistant is the admin's integration: only an admin links one of its persons.
  const ha = useQuery({ queryKey: ['home-assistant-config'], queryFn: appConfigApi.getHomeAssistantConfig, enabled: isAdmin });
  const persons = ha.data?.status?.persons ?? [];
  const personName = (entityId: string) => persons.find((p) => p.entityId === entityId)?.name ?? entityId;
  const knownName = (ext: string) => known.data?.people.find((p) => p.id === ext)?.name ?? null;
  const save = useMutation({
    mutationFn: (p: { externalId: string; userId?: string | null; authorized?: boolean; displayName?: string | null; haPerson?: string | null }) => pluginsApi.setIdentity(id, p),
    onSuccess: () => { setForm(EMPTY_PERSON); setError(null); onSaved(); },
    onError: (e) => setError(errorOf(e, t('plugins.saveError'))),
  });
  const remove = useMutation({ mutationFn: (identityId: string) => pluginsApi.removeIdentity(id, identityId), onSuccess: onSaved });
  const ext = form.externalId.trim();
  const listId = `plugin-people-${id}`;
  return (
    <div className={card}>
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold text-gray-100">{t('plugins.people')}</h3>
        {known.data?.available && (
          <button className="text-gray-500 hover:text-gray-200" title={t('plugins.knownPeopleReload')} disabled={reload.isPending} onClick={() => reload.mutate()}>
            <RefreshCw size={13} className={reload.isPending ? 'animate-spin' : ''} />
          </button>
        )}
      </div>
      <p className="text-xs text-gray-400 mt-1 mb-3">{t('plugins.peopleHint')}</p>
      <ul className="space-y-1 mb-3">
        {detail.identities.map((i) => (
          <li key={i.id} className="flex items-center gap-2 text-xs text-gray-300 min-w-0">
            <span className="font-mono truncate">{i.externalId}</span>
            {(i.displayName ?? knownName(i.externalId)) && <span className="text-gray-400 truncate">({i.displayName ?? knownName(i.externalId)})</span>}
            <span className="text-gray-500 truncate">
              → {i.userId ? name(i.userId) : t('plugins.guest')}{!i.userId && i.authorized ? ` (${t('plugins.authorized')})` : ''}
              {i.haPerson ? ` · ${personName(i.haPerson)}` : ''}
            </span>
            <button className="ml-auto text-gray-500 hover:text-red-400 flex-shrink-0" onClick={() => remove.mutate(i.id)}><Trash2 size={12} /></button>
          </li>
        ))}
      </ul>
      <div className={`grid grid-cols-1 gap-2 items-center ${isAdmin ? 'sm:grid-cols-[1fr_1fr_1fr_auto_auto]' : 'sm:grid-cols-[1fr_1fr_auto_auto]'}`}>
        <input className={input} list={listId} value={form.externalId} onChange={(e) => setForm({ ...form, externalId: e.target.value })}
          placeholder={known.data?.available ? t('plugins.knownPeoplePlaceholder', { count: known.data.people.length }) : t('plugins.externalId')} />
        <datalist id={listId}>
          {(known.data?.people ?? []).map((p) => <option key={p.id} value={p.id}>{p.name ?? p.id}</option>)}
        </datalist>
        <select className={input} value={form.userId} onChange={(e) => setForm({ ...form, userId: e.target.value })}>
          <option value="">{t('plugins.guest')}</option>
          {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        {isAdmin && (
          <select className={input} value={form.haPerson} title={t('plugins.haPersonHint')} onChange={(e) => setForm({ ...form, haPerson: e.target.value })}>
            <option value="">{t('plugins.haPersonNone')}</option>
            {persons.map((p) => <option key={p.entityId} value={p.entityId}>{p.name}</option>)}
          </select>
        )}
        <label className="text-xs text-gray-300 flex items-center gap-1.5">
          <input type="checkbox" disabled={!!form.userId} checked={form.authorized} onChange={(e) => setForm({ ...form, authorized: e.target.checked })} />{t('plugins.authorized')}
        </label>
        <button className={secondary} disabled={!ext || save.isPending}
          onClick={() => save.mutate({
            externalId: ext, userId: form.userId || null, authorized: !form.userId && form.authorized,
            ...(knownName(ext) ? { displayName: knownName(ext) } : {}),
            ...(isAdmin ? { haPerson: form.haPerson || null } : {}),
          })}>
          {t('plugins.link')}
        </button>
      </div>
      {isAdmin && <p className="text-[11px] text-gray-500 mt-2">{t('plugins.haPersonHint')}</p>}
      {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
    </div>
  );
}

function EventsCard({ id }: { id: string }) {
  const { t } = useTranslation('settings');
  const { data } = useQuery({ queryKey: ['plugin-install-events', id], queryFn: () => pluginsApi.events(id), refetchInterval: 30_000 });
  return (
    <div className={card}>
      <h3 className="text-sm font-semibold text-gray-100 mb-2">{t('plugins.events')}</h3>
      {!data?.length ? <p className="text-xs text-gray-500">{t('plugins.noEvents')}</p> : (
        <ul className="text-xs space-y-1 max-h-72 overflow-y-auto">
          {data.map((e) => (
            <li key={e.id} className="flex gap-2 text-gray-300">
              <span className="text-gray-500 whitespace-nowrap">{new Date(e.createdAt).toLocaleString()}</span>
              <span className="font-mono">{e.type}</span>
              <span className={e.outcome === 'accepted' ? 'text-green-400' : e.outcome === 'duplicate' ? 'text-gray-400' : 'text-amber-400'}>{t(`plugins.outcome.${e.outcome}`)}</span>
              {e.detail && <span className="text-gray-500 truncate">{e.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
