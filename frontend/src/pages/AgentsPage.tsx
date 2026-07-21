import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Bot, Users2, Plus, Trash2, X, Loader2, ArrowLeft } from 'lucide-react';
import {
  agentsApi, agentTeamsApi, type Agent, type AgentTeam, type AgentScope,
  type TeamTopology, type MemberInput,
} from '../api/agents';
import { llmConfigsApi } from '../api/llmConfigs';
import { Field } from './UsersPage';

const SCOPES: AgentScope[] = ['personal', 'team', 'org'];

// ══════════════════════════════════════════════════════════════════════════════
//  Agents
// ══════════════════════════════════════════════════════════════════════════════
export function AgentsSection() {
  const { t } = useTranslation('agents');
  const qc = useQueryClient();
  const [edit, setEdit] = useState<Agent | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const query = useQuery({ queryKey: ['agents'], queryFn: agentsApi.list, staleTime: 10_000 });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['agents'] });

  // Editor replaces the list in-place (Flows-style) instead of a modal.
  if (createOpen || edit) {
    return (
      <AgentEditor
        agent={edit ?? undefined}
        onClose={() => { setCreateOpen(false); setEdit(null); }}
        onSaved={() => { setCreateOpen(false); setEdit(null); invalidate(); }}
      />
    );
  }

  const agents = query.data ?? [];
  return (
    <div>
      <Header icon={Bot} title={t('agents.title')} subtitle={t('agents.subtitle')}
        action={<button onClick={() => setCreateOpen(true)} className="btn-primary px-4 py-2 text-sm flex items-center gap-2"><Plus size={16} /> {t('agents.new')}</button>} />
      {query.isLoading ? <Loading /> : agents.length === 0 ? (
        <Empty>{t('agents.empty')}</Empty>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {agents.map((a) => (
            <button key={a.id} onClick={() => setEdit(a)}
              className="text-left w-full border border-gray-800 rounded-xl p-4 hover:border-gray-700 transition-colors">
              <div className="font-medium text-gray-100 truncate">{a.name}</div>
              <div className="text-xs text-gray-500 mt-0.5 truncate">{a.description || a.systemPrompt?.slice(0, 60) || '—'}</div>
              <div className="text-[11px] text-gray-600 mt-1">{t('agents.cardMeta', { scope: a.scope, mode: a.toolFilter?.mode ?? 'all' })}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function AgentEditor({ agent, onClose, onSaved }: { agent?: Agent; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation('agents');
  const [name, setName] = useState(agent?.name ?? '');
  const [description, setDescription] = useState(agent?.description ?? '');
  const [systemPrompt, setSystemPrompt] = useState(agent?.systemPrompt ?? '');
  const [llmConfigId, setLlmConfigId] = useState(agent?.llmConfigId ?? '');
  const [toolMode, setToolMode] = useState(agent?.toolFilter?.mode ?? 'all');
  const [toolNames, setToolNames] = useState((agent?.toolFilter?.names ?? []).join(', '));
  const [scope, setScope] = useState<AgentScope>(agent?.scope ?? 'personal');
  const [exposeAsTool, setExposeAsTool] = useState(agent?.exposeAsTool ?? false);
  const [err, setErr] = useState<string | null>(null);

  const llmConfigs = useQuery({ queryKey: ['llm-configs'], queryFn: llmConfigsApi.list, staleTime: 30_000 });

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        name, description, systemPrompt,
        llmConfigId: llmConfigId || null,
        toolFilter: { mode: toolMode, names: toolMode === 'names' ? toolNames.split(',').map((s) => s.trim()).filter(Boolean) : undefined },
        exposeAsTool,
        scope,
      };
      return agent ? agentsApi.update(agent.id, payload) : agentsApi.create(payload);
    },
    onSuccess: onSaved,
    onError: (e: any) => setErr(e?.response?.data?.message ?? t('errSave')),
  });

  const del = useMutation({
    mutationFn: () => agentsApi.remove(agent!.id),
    onSuccess: onSaved, // refresh list + back
    onError: (e: any) => setErr(e?.response?.data?.message ?? t('errDelete')),
  });

  return (
    <EditorShell backLabel={t('agents.title')} title={agent ? t('modal.editAgent') : t('modal.newAgent')} onBack={onClose}>
      {err && <ErrBar msg={err} onClose={() => setErr(null)} />}
      <Field label={t('modal.name')}><input className="input-field w-full" value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label={t('modal.description')}><input className="input-field w-full" value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      <Field label={t('modal.systemPrompt')}>
        <textarea className="input-field w-full font-mono text-xs" rows={4} value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} />
      </Field>
      <Field label={t('modal.model')}>
        <select className="input-field w-full" value={llmConfigId} onChange={(e) => setLlmConfigId(e.target.value)}>
          <option value="">{t('modal.modelDefault')}</option>
          {(llmConfigs.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </Field>
      <Field label={t('modal.tools')}>
        <select className="input-field w-full" value={toolMode} onChange={(e) => setToolMode(e.target.value as any)}>
          <option value="all">{t('modal.toolModeAll')}</option>
          <option value="names">{t('modal.toolModeNames')}</option>
          <option value="none">{t('modal.toolModeNone')}</option>
        </select>
      </Field>
      {toolMode === 'names' && (
        <Field label={t('modal.toolNames')}>
          <input className="input-field w-full font-mono text-xs" value={toolNames} onChange={(e) => setToolNames(e.target.value)} placeholder={t('modal.toolNamesPlaceholder')} />
        </Field>
      )}
      <Field label={t('modal.scope')}>
        <select className="input-field w-full" value={scope} onChange={(e) => setScope(e.target.value as AgentScope)}>
          {SCOPES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </Field>
      <Field label={t('modal.exposeAsTool')}>
        <label className="flex items-center gap-2 text-sm text-gray-300" title={t('modal.exposeAgentTitle')}>
          <input type="checkbox" checked={exposeAsTool} onChange={(e) => setExposeAsTool(e.target.checked)} />
          {t('modal.exposeAgentText')} <code className="text-[11px]">{t('modal.exposeAgentToolName')}</code>
        </label>
      </Field>
      <EditorFooter
        isEditing={!!agent}
        del={{ onDelete: () => del.mutate(), pending: del.isPending }}
        onClose={onClose}
        onConfirm={() => save.mutate()}
        pending={save.isPending}
        disabled={!name.trim()}
      />
    </EditorShell>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
//  Agent teams
// ══════════════════════════════════════════════════════════════════════════════
export function AgentTeamsSection() {
  const { t } = useTranslation('agents');
  const qc = useQueryClient();
  const [edit, setEdit] = useState<AgentTeam | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const query = useQuery({ queryKey: ['agent-teams'], queryFn: agentTeamsApi.list, staleTime: 10_000 });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['agent-teams'] });

  // Editor replaces the list in-place (Flows-style) instead of a modal.
  if (createOpen || edit) {
    return (
      <TeamEditor
        team={edit ?? undefined}
        onClose={() => { setCreateOpen(false); setEdit(null); }}
        onSaved={() => { setCreateOpen(false); setEdit(null); invalidate(); }}
      />
    );
  }

  const teams = query.data ?? [];
  return (
    <div>
      <Header icon={Users2} title={t('teams.title')} subtitle={t('teams.subtitle')}
        action={<button onClick={() => setCreateOpen(true)} className="btn-primary px-4 py-2 text-sm flex items-center gap-2"><Plus size={16} /> {t('teams.new')}</button>} />
      {query.isLoading ? <Loading /> : teams.length === 0 ? (
        <Empty>{t('teams.empty')}</Empty>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {teams.map((tm) => (
            <button key={tm.id} onClick={() => setEdit(tm)}
              className="text-left w-full border border-gray-800 rounded-xl p-4 hover:border-gray-700 transition-colors">
              <div className="font-medium text-gray-100 truncate">{tm.name}</div>
              <div className="text-xs text-gray-500 mt-0.5">{t('teams.cardMeta', { topology: tm.topology, scope: tm.scope })}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TeamEditor({ team, onClose, onSaved }: { team?: AgentTeam; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation('agents');
  const [name, setName] = useState(team?.name ?? '');
  const [description, setDescription] = useState(team?.description ?? '');
  const [topology, setTopology] = useState<TeamTopology>(team?.topology ?? 'supervisor');
  const [supervisorAgentId, setSupervisorAgentId] = useState(team?.supervisorAgentId ?? '');
  const [scope, setScope] = useState<AgentScope>(team?.scope ?? 'personal');
  const [exposeAsTool, setExposeAsTool] = useState(team?.exposeAsTool ?? false);
  const [members, setMembers] = useState<MemberInput[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const agents = useQuery({ queryKey: ['agents'], queryFn: agentsApi.list, staleTime: 30_000 });
  // Load members when editing (react-query v5: no onSuccess on useQuery → useEffect)
  const fullTeam = useQuery({
    queryKey: ['agent-team', team?.id],
    queryFn: () => agentTeamsApi.get(team!.id),
    enabled: !!team,
  });
  useEffect(() => {
    if (fullTeam.data?.members) setMembers(fullTeam.data.members.map((m) => ({ agentId: m.agentId, role: m.role })));
  }, [fullTeam.data]);

  const save = useMutation({
    mutationFn: async () => {
      const payload = { name, description, topology, supervisorAgentId: supervisorAgentId || null, exposeAsTool, scope };
      const saved = team ? await agentTeamsApi.update(team.id, payload) : await agentTeamsApi.create(payload);
      await agentTeamsApi.setMembers(saved.id, members.map((m, i) => ({ ...m, position: i })));
      return saved;
    },
    onSuccess: onSaved,
    onError: (e: any) => setErr(e?.response?.data?.message ?? t('errSave')),
  });

  const del = useMutation({
    mutationFn: () => agentTeamsApi.remove(team!.id),
    onSuccess: onSaved, // refresh list + back
    onError: (e: any) => setErr(e?.response?.data?.message ?? t('errDelete')),
  });

  return (
    <EditorShell backLabel={t('teams.title')} title={team ? t('modal.editTeam') : t('modal.newTeam')} onBack={onClose}>
      {err && <ErrBar msg={err} onClose={() => setErr(null)} />}
      <Field label={t('modal.name')}><input className="input-field w-full" value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label={t('modal.description')}><input className="input-field w-full" value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      <Field label={t('modal.topology')}>
        <select className="input-field w-full" value={topology} onChange={(e) => setTopology(e.target.value as TeamTopology)}>
          <option value="supervisor">{t('modal.topologySupervisor')}</option>
          <option value="sequential">{t('modal.topologySequential')}</option>
          <option value="parallel">{t('modal.topologyParallel')}</option>
        </select>
      </Field>
      {topology === 'supervisor' && (
        <Field label={t('modal.supervisorAgent')}>
          <select className="input-field w-full" value={supervisorAgentId} onChange={(e) => setSupervisorAgentId(e.target.value)}>
            <option value="">{t('modal.choose')}</option>
            {(agents.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>
      )}
      <Field label={t('modal.members')}>
        <div className="space-y-1.5">
          {members.map((m, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <span className="text-xs text-gray-600 w-5">{i + 1}.</span>
              <select className="input-field flex-1" value={m.agentId} onChange={(e) => setMembers((ms) => ms.map((x, j) => j === i ? { ...x, agentId: e.target.value } : x))}>
                <option value="">{t('modal.memberAgent')}</option>
                {(agents.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
              <input className="input-field w-28" placeholder={t('modal.rolePlaceholder')} value={m.role ?? ''} onChange={(e) => setMembers((ms) => ms.map((x, j) => j === i ? { ...x, role: e.target.value } : x))} />
              <button onClick={() => setMembers((ms) => ms.filter((_, j) => j !== i))} className="text-gray-600 hover:text-red-400"><X size={14} /></button>
            </div>
          ))}
          <button onClick={() => setMembers((ms) => [...ms, { agentId: '', role: '' }])} className="text-xs text-gray-500 hover:text-gray-300 flex items-center gap-1"><Plus size={12} /> {t('modal.addMember')}</button>
        </div>
      </Field>
      <Field label={t('modal.scope')}>
        <select className="input-field w-full" value={scope} onChange={(e) => setScope(e.target.value as AgentScope)}>
          {SCOPES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </Field>
      <Field label={t('modal.exposeAsTool')}>
        <label className="flex items-center gap-2 text-sm text-gray-300" title={t('modal.exposeTeamTitle')}>
          <input type="checkbox" checked={exposeAsTool} onChange={(e) => setExposeAsTool(e.target.checked)} />
          {t('modal.exposeTeamText')} <code className="text-[11px]">{t('modal.exposeTeamToolName')}</code>
        </label>
      </Field>
      <EditorFooter
        isEditing={!!team}
        del={{ onDelete: () => del.mutate(), pending: del.isPending }}
        onClose={onClose}
        onConfirm={() => save.mutate()}
        pending={save.isPending}
        disabled={!name.trim() || members.some((m) => !m.agentId)}
      />
    </EditorShell>
  );
}

// ── Shared primitives ───────────────────────────────────────────────────────────

/** Inline editor shell: back button + title, replaces the list (Flows-style). */
function EditorShell({ backLabel, title, onBack, children }: {
  backLabel: string; title: string; onBack: () => void; children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-3 mb-5">
        <button onClick={onBack} className="text-gray-400 hover:text-white flex items-center gap-1 text-sm flex-shrink-0">
          <ArrowLeft size={16} /> {backLabel}
        </button>
        <h3 className="text-base font-semibold text-white truncate">{title}</h3>
      </div>
      <div className="max-w-2xl">{children}</div>
    </div>
  );
}

/** Inline editor footer: optional delete (with inline confirm) + cancel + save. */
function EditorFooter({ isEditing, del, onClose, onConfirm, pending, disabled }: {
  isEditing: boolean;
  del?: { onDelete: () => void; pending: boolean };
  onClose: () => void;
  onConfirm: () => void;
  pending?: boolean;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <div className="flex items-center gap-2 mt-6 pt-4 border-t border-gray-800">
      {isEditing && del && (
        confirmDelete ? (
          <div className="flex items-center gap-2 flex-shrink-0">
            <span className="text-xs text-gray-400">{t('actions.deleteConfirm')}</span>
            <button onClick={del.onDelete} disabled={del.pending}
              className="px-2 py-1 text-xs bg-red-600 hover:bg-red-500 text-white rounded transition-colors">
              {del.pending ? <Loader2 size={12} className="animate-spin" /> : t('actions.delete')}
            </button>
            <button onClick={() => setConfirmDelete(false)} className="px-2 py-1 text-xs text-gray-400 hover:text-gray-200 rounded">
              {t('actions.no')}
            </button>
          </div>
        ) : (
          <button onClick={() => setConfirmDelete(true)} title={t('actions.delete')}
            className="flex items-center gap-1.5 px-2.5 py-2 text-sm text-gray-400 hover:text-red-400 rounded-lg transition-colors flex-shrink-0">
            <Trash2 size={15} /> {t('actions.delete')}
          </button>
        )
      )}
      <div className="flex-1" />
      <button onClick={onClose} className="px-4 py-2 text-sm rounded-lg text-gray-300 hover:bg-gray-800">{t('actions.cancel')}</button>
      <button onClick={onConfirm} disabled={pending || disabled} className="btn-primary px-4 py-2 text-sm disabled:opacity-50 flex items-center gap-2">
        {pending && <Loader2 className="animate-spin" size={14} />} {t('actions.save')}
      </button>
    </div>
  );
}

function Header({ icon: Icon, title, subtitle, action }: { icon: React.ElementType; title: string; subtitle: string; action: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between mb-5">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-gray-800 flex items-center justify-center text-gray-300"><Icon size={18} /></div>
        <div><h2 className="text-lg font-semibold text-white">{title}</h2><p className="text-sm text-gray-500">{subtitle}</p></div>
      </div>
      {action}
    </div>
  );
}
function ErrBar({ msg, onClose }: { msg: string; onClose: () => void }) {
  return <div className="flex items-center justify-between gap-3 bg-red-950/50 border border-red-900 text-red-300 text-sm rounded-lg px-3 py-2 mb-3"><span>{msg}</span><button onClick={onClose}><X size={14} /></button></div>;
}
function Loading() { return <div className="text-center py-10 text-gray-500"><Loader2 className="animate-spin inline" size={18} /></div>; }
function Empty({ children }: { children: React.ReactNode }) { return <div className="text-center py-10 text-gray-500 border border-dashed border-gray-800 rounded-xl">{children}</div>; }
