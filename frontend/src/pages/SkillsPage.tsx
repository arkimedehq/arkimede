/**
 * @file SkillsPage.tsx
 *
 * Skills section of the settings.
 * Exports `SkillsSection` (used by SettingsPage).
 *
 * Tabs:
 *   1. "My skills"      — ZIP upload, list of personal/shared skills created by the user
 *   2. "Public skills"  — browse others' shared+approved skills, assign to a project
 *   3. "Review"         — (admin) pending shared skills, approve/reject
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Upload, Trash2, RefreshCw, CheckCircle, XCircle, Loader2,
  ChevronDown, ChevronRight, Code2, Globe, Clock, AlertCircle,
  Package, Sparkles, Shield, X, FileCode, FileText,
  Settings2, Eye, EyeOff, RotateCcw, Share2, Search, FolderOpen, Download,
  Activity, Play, Square, RotateCw, Cpu, Zap, WifiOff, Power,
  Terminal, Paperclip, Timer, Copy, Check, BookOpen, Database, Users, Wand2,
  Network, ArrowLeft,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { skillsApi, type Skill, type SkillStatus, type SkillScope, type SkillScript, type RegistrySkill, type RegistryIndex, type ExecuteScriptResult, type CompiledScript } from '../api/skills';
import { ScopeSelector } from '../components/ScopeSelector';
import { daemonsApi, type SkillDaemon, type DaemonStatus } from '../api/daemons';
import { projectsApi } from '../api/projects';
import { dataSourcesApi, engineFamily, type DataSource } from '../api/dataSources';
import { vectorDbApi, type VectorCollection } from '../api/vectorDb';
import { useStore } from '../store/useStore';
import type { Project } from '../store/useStore';

// ── Helpers ───────────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: SkillStatus }) {
  const { t } = useTranslation('skills');
  const cfg: Record<SkillStatus, { label: string; className: string; icon: React.ReactNode }> = {
    pending:    { label: t('status.pending'),    className: 'bg-gray-700 text-gray-300 border-gray-600',                icon: <Clock size={11} /> },
    installing: { label: t('status.installing'), className: 'bg-blue-900/60 text-blue-300 border-blue-700/60',           icon: <Loader2 size={11} className="animate-spin" /> },
    ready:      { label: t('status.ready'),       className: 'bg-emerald-900/60 text-emerald-300 border-emerald-700/60', icon: <CheckCircle size={11} /> },
    error:      { label: t('status.error'),       className: 'bg-red-900/60 text-red-300 border-red-700/60',             icon: <AlertCircle size={11} /> },
  };
  const { label, className, icon } = cfg[status];
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-xs font-medium ${className}`}>
      {icon}{label}
    </span>
  );
}

/**
 * Visibility control for a skill: scope choice (personal/team/org) +
 * team picker, with an "Apply" button that appears only if something changes.
 * team = direct publication by the owner to the members; org = submission to admin review.
 */
function ScopeControl({ current, pending, isAdmin, onApply }: {
  current: Skill;
  pending: boolean;
  isAdmin: boolean;
  onApply: (scope: SkillScope, teamId: string | null) => void;
}) {
  const { t } = useTranslation('skills');
  const [scope, setScope]   = useState<SkillScope>(current.scope);
  const [teamId, setTeamId] = useState<string | null>(current.teamId);

  const dirty = scope !== current.scope || (scope === 'team' && teamId !== current.teamId);
  const notReady = current.status !== 'ready' && scope !== 'personal';
  const teamMissing = scope === 'team' && !teamId;

  return (
    <div className="w-full border border-gray-800 rounded-lg p-3">
      <p className="text-xs font-medium text-gray-400 mb-2">{t('scope.visibility')}</p>
      <ScopeSelector
        scope={scope === 'org' || scope === 'team' ? scope : 'personal'}
        teamId={teamId}
        onScope={setScope}
        onTeam={setTeamId}
        allowOrg={isAdmin || current.scope === 'org'}
      />
      {dirty && (
        <button
          onClick={() => onApply(scope, scope === 'team' ? teamId : null)}
          disabled={pending || notReady || teamMissing}
          title={notReady ? t('scope.notReadyTitle') : undefined}
          className="mt-2 flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500
            text-white text-xs rounded-lg transition-colors disabled:opacity-40"
        >
          {pending ? <Loader2 size={12} className="animate-spin" /> : <Share2 size={12} />}
          {scope === 'org' ? t('scope.sendReview') : scope === 'team' ? t('scope.publishTeam') : t('scope.makePersonal')}
        </button>
      )}
    </div>
  );
}

function ScopeBadge({ scope }: { scope: SkillScope }) {
  const { t } = useTranslation('skills');
  if (scope === 'org') return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-indigo-700/50 bg-indigo-900/40 text-indigo-300 text-xs">
      <Globe size={10} /> Org
    </span>
  );
  if (scope === 'team') return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-amber-700/50 bg-amber-900/40 text-amber-300 text-xs">
      <Users size={10} /> Team
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-gray-700 bg-gray-800 text-gray-400 text-xs">
      <Shield size={10} /> {t('scopeBadge.personal')}
    </span>
  );
}

function LangBadge({ lang }: { lang: 'python' | 'javascript' | 'node' }) {
  if (lang === 'python') return (
    <span className="px-1.5 py-0.5 rounded text-xs font-mono bg-yellow-900/40 text-yellow-300 border border-yellow-800/50">py</span>
  );
  if (lang === 'node') return (
    <span className="px-1.5 py-0.5 rounded text-xs font-mono bg-green-900/40 text-green-300 border border-green-800/50">node</span>
  );
  return (
    <span className="px-1.5 py-0.5 rounded text-xs font-mono bg-amber-900/40 text-amber-300 border border-amber-800/50">js</span>
  );
}

// ── Skill detail drawer ────────────────────────────────────────────────────

/**
 * Read-only transparency: the external domains a skill declared (SKILL.md runtime.network).
 * These are added to the egress allowlist when the skill is enabled. Shown to everyone so
 * an admin/user can see exactly what a skill wants to reach before enabling/approving it.
 */
function InternetDomainsSection({ skill }: { skill: Skill }) {
  const { t } = useTranslation('skills');
  const domains = skill.networkDomains ?? [];
  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
        <Globe size={13} /> {t('internet.title')}
      </p>
      {domains.length === 0 ? (
        <p className="text-[11px] text-gray-500">{t('internet.none')}</p>
      ) : (
        <>
          <p className="text-[11px] text-gray-500">{t('internet.hint')}</p>
          <div className="flex flex-wrap gap-1.5">
            {domains.map((d) => (
              <span
                key={d}
                className="px-2 py-0.5 rounded-full bg-blue-500/15 border border-blue-500/30 text-blue-600 dark:text-blue-300 text-[11px] font-mono"
              >
                {d}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Reserved-network grants for a skill (admin, Phase 3). Lists the operator-provisioned
 * networks (SKILL_NETWORK_CATALOG); each checkbox grants/revokes one for this skill.
 * Renders nothing if the operator provisioned no reserved networks.
 */
function NetworksSection({ skill }: { skill: Skill }) {
  const { t } = useTranslation('skills');
  const qc = useQueryClient();

  const { data: catalog } = useQuery({
    queryKey:  ['skill-network-catalog'],
    queryFn:   skillsApi.getNetworkCatalog,
    staleTime: 5 * 60_000,
  });

  const mutation = useMutation({
    mutationFn: (ids: string[]) => skillsApi.setNetworks(skill.id, ids),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['skills'] });
      qc.invalidateQueries({ queryKey: ['skill', skill.id] });
    },
  });

  if (!catalog || catalog.length === 0) return null;

  const granted = new Set(skill.grantedNetworks ?? []);
  const toggle = (id: string) => {
    const next = new Set(granted);
    next.has(id) ? next.delete(id) : next.add(id);
    mutation.mutate([...next]);
  };

  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
        <Network size={13} /> {t('networks.title')}
      </p>
      <p className="text-[11px] text-gray-500">{t('networks.hint')}</p>
      <div className="space-y-1.5">
        {catalog.map((n) => (
          <label
            key={n.id}
            className="flex items-start gap-2.5 p-2 rounded-lg border border-gray-800 hover:border-gray-700 cursor-pointer transition-colors"
          >
            <input
              type="checkbox"
              checked={granted.has(n.id)}
              disabled={mutation.isPending}
              onChange={() => toggle(n.id)}
              className="mt-0.5 accent-indigo-500"
            />
            <span className="min-w-0">
              <span className="text-xs text-gray-200 font-medium">{n.label}</span>
              {n.kind === 'lan' && (
                <span className="ml-1.5 px-1.5 py-0.5 rounded bg-amber-500/15 border border-amber-500/30 text-amber-600 dark:text-amber-300 text-[9px] font-semibold uppercase tracking-wide">
                  {t('networks.lanBadge')}
                </span>
              )}
              {n.description && (
                <span className="block text-[11px] text-gray-500">{n.description}</span>
              )}
              <span className="block text-[10px] text-gray-600 font-mono truncate">{n.dockerNetwork}</span>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

function SkillDrawer({
  skill,
  onClose,
  isOwn,
}: {
  skill: Skill;
  onClose: () => void;
  isOwn: boolean;
}) {
  const { t } = useTranslation('skills');
  const qc = useQueryClient();
  const isAdmin = useStore((s) => s.user?.role === 'admin');
  const [showLog, setShowLog]    = useState(false);
  const [confirmDel, setConfDel] = useState(false);
  const [copied,    setCopied]   = useState(false);
  const updateZipRef = useRef<HTMLInputElement>(null);

  // Automatic poll when status = installing
  const { data: fresh } = useQuery({
    queryKey:  ['skill', skill.id],
    queryFn:   () => skillsApi.getById(skill.id),
    refetchInterval: (query) => {
      const s = query.state.data?.status ?? skill.status;
      return s === 'installing' || s === 'pending' ? 3000 : false;
    },
    initialData: skill,
    staleTime: 0,
  });

  const current = fresh ?? skill;

  const [reinstallOk, setReinstallOk] = useState(false);

  const reinstallMutation = useMutation({
    mutationFn: () => skillsApi.reinstall(skill.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['skills'] });
      qc.invalidateQueries({ queryKey: ['skill', skill.id] });
      setReinstallOk(true);
      setTimeout(() => setReinstallOk(false), 3000);
    },
  });

  const updateZipMutation = useMutation({
    mutationFn: (file: File) => skillsApi.updateFromZip(skill.id, file),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['skills'] });
      qc.invalidateQueries({ queryKey: ['skill', skill.id] });
    },
  });

  const syncMutation = useMutation({
    mutationFn: () => skillsApi.syncFromSource(skill.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['skills'] });
      qc.invalidateQueries({ queryKey: ['skill', skill.id] });
    },
  });

  const scopeMutation = useMutation({
    mutationFn: (vars: { scope: SkillScope; teamId?: string | null }) =>
      skillsApi.update(skill.id, { scope: vars.scope, teamId: vars.teamId ?? null }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['skills'] });
      qc.invalidateQueries({ queryKey: ['skill', skill.id] });
    },
  });

  const loadOnFirstMutation = useMutation({
    mutationFn: (loadOnFirst: boolean) => skillsApi.update(skill.id, { loadOnFirst }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['skills'] });
      qc.invalidateQueries({ queryKey: ['skill', skill.id] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => skillsApi.remove(skill.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['skills'] });
      onClose();
    },
  });

  // ── S3: compile descriptive skill → typed (AI proposes, owner confirms) ──
  const [proposal, setProposal]     = useState<CompiledScript[] | null>(null);
  const [compileErr, setCompileErr] = useState<string | null>(null);

  const proposeMutation = useMutation({
    mutationFn: () => skillsApi.proposeCompilation(skill.id),
    onSuccess: (data) => { setProposal(data.scripts); setCompileErr(null); },
    onError: (e: any) => setCompileErr(e?.response?.data?.message ?? e.message),
  });

  const compileMutation = useMutation({
    mutationFn: (scripts: CompiledScript[]) => skillsApi.compile(skill.id, scripts),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['skills'] });
      qc.invalidateQueries({ queryKey: ['skill', skill.id] });
      setProposal(null);
    },
    onError: (e: any) => setCompileErr(e?.response?.data?.message ?? e.message),
  });

  return (
    <div>
      {/* Panel — inline, replaces the list (Flows-style) */}
      <div>
        {/* Header with back button */}
        <div className="mb-5 pb-4 border-b border-gray-800">
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white flex items-center gap-1 text-sm mb-3"
          >
            <ArrowLeft size={16} /> {t('title')}
          </button>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Package size={16} className="text-indigo-400 flex-shrink-0" />
              <h2 className="text-base font-semibold text-gray-100 truncate">{current.name}</h2>
              <span className="text-xs text-gray-500 font-mono">v{current.version}</span>
            </div>
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <StatusBadge status={current.status} />
              <ScopeBadge scope={current.scope} />
              {current.scope === 'org' && !current.isApproved && (
                <span className="px-2 py-0.5 rounded-md border border-amber-700/50 bg-amber-900/30 text-amber-300 text-xs">
                  Awaiting review
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="space-y-5">
          {/* Description */}
          {current.description && (
            <p className="text-sm text-gray-400 leading-relaxed">{current.description}</p>
          )}

          {/* Skill ID — useful for the inter-skill bus */}
          <div className="flex items-center gap-2 px-3 py-2 bg-gray-800/60 rounded-lg border border-gray-700/40">
            <div className="flex-1 min-w-0">
              <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">{t('detail.skillId')}</p>
              <p className="text-xs font-mono text-gray-300 truncate select-all" title={current.id}>
                {current.id}
              </p>
            </div>
            <button
              onClick={() => {
                navigator.clipboard.writeText(current.id);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
              title={t('detail.copyId')}
              className="flex-shrink-0 p-1.5 rounded-md transition-colors
                text-gray-500 hover:text-indigo-400 hover:bg-indigo-900/30"
            >
              {copied
                ? <Check size={13} className="text-emerald-400" />
                : <Copy size={13} />}
            </button>
          </div>

          {/* Meta */}
          <div className="grid grid-cols-2 gap-2 text-xs">
            {current.author && (
              <div className="px-3 py-2 bg-gray-800 rounded-lg">
                <span className="text-gray-500">{t('detail.author')}</span>
                <p className="text-gray-200 mt-0.5 font-medium">{current.author}</p>
              </div>
            )}
            {current.license && (
              <div className="px-3 py-2 bg-gray-800 rounded-lg">
                <span className="text-gray-500">{t('detail.license')}</span>
                <p className="text-gray-200 mt-0.5 font-medium">{current.license}</p>
              </div>
            )}
          </div>

          {/* Dependencies */}
          {(current.pythonDeps.length > 0 || current.jsDeps.length > 0) && (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">{t('detail.deps')}</p>
              {current.pythonDeps.length > 0 && (
                <div>
                  <p className="text-xs text-gray-500 mb-1">Python</p>
                  <div className="flex flex-wrap gap-1.5">
                    {current.pythonDeps.map((d) => (
                      <span key={d} className="px-2 py-0.5 rounded font-mono text-xs bg-yellow-900/20 border border-yellow-800/40 text-yellow-300">{d}</span>
                    ))}
                  </div>
                </div>
              )}
              {current.jsDeps.length > 0 && (
                <div>
                  <p className="text-xs text-gray-500 mb-1">JavaScript</p>
                  <div className="flex flex-wrap gap-1.5">
                    {current.jsDeps.map((d) => (
                      <span key={d} className="px-2 py-0.5 rounded font-mono text-xs bg-amber-900/20 border border-amber-800/40 text-amber-300">{d}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Script */}
          {current.scripts.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                Script ({current.scripts.length})
              </p>
              <div className="space-y-2">
                {current.scripts.map((s) => (
                  <ScriptRow
                    key={s.id}
                    script={s}
                    skillId={current.id}
                    skillStatus={current.status}
                    isOwn={isOwn}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Runtime state — auto-execution of mode:info script (if present) */}
          {current.scripts.some((s) => s.mode === 'info') && (
            <InfoScriptPanel skill={current} />
          )}

          {/* Documentation — README.md / SKILL.md (lazy loading) */}
          <DocsSection skillId={current.id} packagePath={current.packagePath} />

          {/* Variables configuration (only for the owner of a skill with configSpec) */}
          {isOwn && current.configSpec && current.configSpec.length > 0 && (
            <ConfigSection skillId={current.id} />
          )}

          {/* Requested external domains (egress) — read-only transparency for everyone. */}
          <InternetDomainsSection skill={current} />

          {/* Reserved networks — admin only (Phase 3): grant provisioned LAN/VPN/subnets. */}
          {isAdmin && <NetworksSection skill={current} />}

          {/* Project assignment — owner only.
              A non-owner cannot modify the assignments of someone else's skill:
              adding it to a project would change the global visibility for everyone. */}
          {isOwn && current.status === 'ready' && (
            <ProjectAssignSection skillId={current.id} />
          )}

          {/* Installation log */}
          {current.installLog && (
            <div className="space-y-2">
              <button
                onClick={() => setShowLog((p) => !p)}
                className="flex items-center gap-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wider hover:text-gray-300 transition-colors"
              >
                {showLog ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                Installation log
              </button>
              {showLog && (
                <pre className="text-xs font-mono text-gray-400 bg-gray-800 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-all max-h-64 overflow-y-auto">
                  {current.installLog}
                </pre>
              )}
            </div>
          )}
        </div>

        {/* Footer actions (owner only) */}
        {isOwn && (
          <div className="px-5 py-4 border-t border-gray-800 space-y-3">
            {/* Enable/disable row */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Power size={13} className={current.enabled !== false ? 'text-indigo-400' : 'text-gray-600'} />
                <span className="text-xs text-gray-400">
                  {current.enabled !== false ? t('toggle.enabled') : t('toggle.disabled')}
                </span>
                <span className="text-[10px] text-gray-600">
                  {current.enabled !== false
                    ? t('toggle.enabledHintActive')
                    : t('toggle.enabledHintExcluded')}
                </span>
              </div>
              <SkillToggle skill={current} />
            </div>

            {/* loadOnFirst row: load in chat vs only via agent */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-400">
                  {current.loadOnFirst !== false ? t('toggle.inChat') : t('toggle.viaAgentOnly')}
                </span>
                <span className="text-[10px] text-gray-600">
                  {current.loadOnFirst !== false
                    ? t('toggle.inChatHint')
                    : t('toggle.viaAgentHint')}
                </span>
              </div>
              <label className="relative inline-flex items-center cursor-pointer" title={t('toggle.loadOnFirstTitle')}>
                <input
                  type="checkbox"
                  className="sr-only peer"
                  checked={current.loadOnFirst !== false}
                  disabled={loadOnFirstMutation.isPending}
                  onChange={(e) => loadOnFirstMutation.mutate(e.target.checked)}
                />
                <div className="w-9 h-5 bg-gray-700 rounded-full peer-checked:bg-indigo-600 transition-colors" />
                <div className="absolute left-0.5 top-0.5 w-4 h-4 bg-white rounded-full transition-transform peer-checked:translate-x-4" />
              </label>
            </div>

            {/* Update from ZIP / Sync from marketplace */}
            <div className="flex items-center gap-2">
              {/* hidden file input for ZIP upload */}
              <input
                ref={updateZipRef}
                type="file"
                accept=".zip,application/zip"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) updateZipMutation.mutate(file);
                  e.target.value = '';
                }}
              />
              <button
                onClick={() => updateZipRef.current?.click()}
                disabled={updateZipMutation.isPending || current.status === 'installing'}
                title={t('actions.updateZipTitle')}
                className="flex items-center gap-1.5 px-3 py-1.5 border border-gray-700 hover:border-gray-600 text-gray-300 hover:text-white text-xs rounded-lg transition-colors disabled:opacity-50"
              >
                {updateZipMutation.isPending
                  ? <Loader2 size={12} className="animate-spin" />
                  : <Upload size={12} />}
                {t('actions.updateZip')}
              </button>

              {current.sourceSkillId && (
                <button
                  onClick={() => syncMutation.mutate()}
                  disabled={syncMutation.isPending || current.status === 'installing'}
                  title={t('actions.syncTitle')}
                  className="flex items-center gap-1.5 px-3 py-1.5 border border-indigo-800/60 hover:border-indigo-600
                    text-indigo-400 hover:text-indigo-300 text-xs rounded-lg transition-colors disabled:opacity-50"
                >
                  {syncMutation.isPending
                    ? <Loader2 size={12} className="animate-spin" />
                    : <RotateCw size={12} />}
                  {t('actions.sync')}
                </button>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {confirmDel ? (
                <>
                  <span className="text-xs text-red-400 flex-1 min-w-[120px]">{t('actions.confirmDelete')}</span>
                  <button
                    onClick={() => deleteMutation.mutate()}
                    disabled={deleteMutation.isPending}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600 hover:bg-red-500 text-white text-xs rounded-lg transition-colors disabled:opacity-50"
                  >
                    {deleteMutation.isPending ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                    {t('actions.delete')}
                  </button>
                  <button
                    onClick={() => setConfDel(false)}
                    className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200 rounded-lg transition-colors"
                  >
                    {t('common:actions.cancel')}
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => reinstallMutation.mutate()}
                    disabled={reinstallMutation.isPending || current.status === 'installing'}
                    title={t('actions.reinstallTitle')}
                    className="flex items-center gap-1.5 px-3 py-1.5 border border-gray-700 hover:border-gray-600 text-gray-300 hover:text-white text-xs rounded-lg transition-colors disabled:opacity-50"
                  >
                    {reinstallMutation.isPending
                      ? <Loader2 size={12} className="animate-spin" />
                      : reinstallOk
                        ? <CheckCircle size={12} className="text-emerald-400" />
                        : <RefreshCw size={12} />}
                    {reinstallOk ? <span className="text-emerald-400">{t('actions.reinstalled')}</span> : t('actions.reinstall')}
                  </button>

                  {/* S3: descriptive skills only → compile to typed tool (AI proposes) */}
                  {current.kind === 'descriptive' && (
                    <button
                      onClick={() => proposeMutation.mutate()}
                      disabled={proposeMutation.isPending || current.status === 'installing'}
                      title={t('compile.buttonTitle')}
                      className="flex items-center gap-1.5 px-3 py-1.5 border border-purple-700/60 hover:border-purple-500 text-purple-300 hover:text-purple-200 text-xs rounded-lg transition-colors disabled:opacity-50"
                    >
                      {proposeMutation.isPending ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
                      {t('compile.button')}
                    </button>
                  )}
                  {/* Suggestion badge: ≥5 successful sandbox runs (threshold mirrored from the backend). */}
                  {current.kind === 'descriptive' && (current.sandboxRuns ?? 0) >= 5 && (
                    <span
                      title={t('compile.suggestHint')}
                      className="flex items-center gap-1 px-2 py-1 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-300 text-[11px]"
                    >
                      <Wand2 size={11} />
                      {t('compile.suggestBadge', { count: current.sandboxRuns })}
                    </span>
                  )}

                  {/* Visibility: personal / team (direct publication) / org (admin review) */}
                  <ScopeControl
                    current={current}
                    pending={scopeMutation.isPending}
                    isAdmin={isAdmin}
                    onApply={(scope, teamId) => scopeMutation.mutate({ scope, teamId })}
                  />

                  <button
                    onClick={() => setConfDel(true)}
                    className="ml-auto flex items-center gap-1.5 px-3 py-1.5 text-red-400 hover:text-red-300 text-xs rounded-lg transition-colors border border-red-900/40 hover:border-red-800"
                  >
                    <Trash2 size={12} /> {t('actions.delete')}
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {proposal && (
        <CompileReviewModal
          initial={proposal}
          pending={compileMutation.isPending}
          error={compileErr}
          onCancel={() => { setProposal(null); setCompileErr(null); }}
          onConfirm={(scripts) => compileMutation.mutate(scripts)}
        />
      )}
    </div>
  );
}

/**
 * S3 — review modal for the compilation proposal (AI → typed tools).
 * Shows for each script: filename (ro), description (editable), input_schema
 * (editable JSON). On confirm, validates the JSON and sends the manifest.
 */
function CompileReviewModal({
  initial, pending, error, onCancel, onConfirm,
}: {
  initial: CompiledScript[];
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (scripts: CompiledScript[]) => void;
}) {
  const { t } = useTranslation('skills');
  const [rows, setRows] = useState(() => initial.map((s) => ({
    filename:     s.filename,
    language:     s.language,
    description:  s.description,
    llm_callable: s.llm_callable !== false,
    schemaText:   JSON.stringify(s.input_schema ?? { type: 'object', properties: {} }, null, 2),
    code:         s.code ?? '',
  })));
  const [localErr, setLocalErr] = useState<string | null>(null);

  const update = (i: number, patch: Partial<typeof rows[number]>) =>
    setRows((r) => r.map((row, j) => (j === i ? { ...row, ...patch } : row)));

  const confirm = () => {
    const out: CompiledScript[] = [];
    for (const r of rows) {
      let schema: Record<string, unknown>;
      try { schema = JSON.parse(r.schemaText); }
      catch { setLocalErr(t('compile.invalidJson', { file: r.filename })); return; }
      out.push({
        filename: r.filename, language: r.language, description: r.description,
        input_schema: schema, llm_callable: r.llm_callable,
        ...(r.code.trim() ? { code: r.code } : {}),
      });
    }
    setLocalErr(null);
    onConfirm(out);
  };

  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center p-4 bg-black/60" onClick={onCancel}>
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-2xl max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-5 py-4 border-b border-gray-800">
          <Wand2 size={16} className="text-purple-400" />
          <h3 className="text-sm font-semibold text-white">{t('compile.reviewTitle')}</h3>
          <button onClick={onCancel} className="ml-auto text-gray-500 hover:text-white"><X size={16} /></button>
        </div>

        <div className="px-5 py-3 text-xs text-gray-500 border-b border-gray-800">{t('compile.reviewSubtitle')}</div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {rows.map((r, i) => (
            <div key={r.filename} className="border border-gray-800 rounded-lg p-3 space-y-2">
              <div className="flex items-center gap-2">
                <FileCode size={13} className="text-gray-400" />
                <span className="text-xs font-mono text-gray-200">{r.filename}</span>
                <span className="text-[10px] uppercase tracking-wide text-gray-500 border border-gray-700 rounded px-1.5 py-0.5">{r.language}</span>
                <label className="ml-auto flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer">
                  <input type="checkbox" checked={r.llm_callable} onChange={(e) => update(i, { llm_callable: e.target.checked })} className="accent-blue-500 w-3.5 h-3.5" />
                  {t('compile.llmCallable')}
                </label>
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-gray-400 mb-1">{t('compile.descLabel')}</label>
                <textarea value={r.description} onChange={(e) => update(i, { description: e.target.value })} rows={2}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-gray-200" />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-gray-400 mb-1">{t('compile.schemaLabel')}</label>
                <textarea value={r.schemaText} onChange={(e) => update(i, { schemaText: e.target.value })} rows={6}
                  spellCheck={false}
                  className="w-full bg-gray-950 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-gray-200 font-mono" />
              </div>
              {r.code !== '' && (
                <div>
                  <label className="block text-[11px] font-semibold text-gray-400 mb-1">{t('compile.codeLabel')}</label>
                  <textarea value={r.code} onChange={(e) => update(i, { code: e.target.value })} rows={10}
                    spellCheck={false}
                    className="w-full bg-gray-950 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-emerald-200 font-mono" />
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="flex items-center gap-3 px-5 py-4 border-t border-gray-800">
          <button onClick={confirm} disabled={pending}
            className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium px-4 py-2 rounded-lg">
            {pending ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
            {t('compile.confirm')}
          </button>
          <button onClick={onCancel} className="text-sm text-gray-400 hover:text-white px-3 py-2">{t('compile.cancel')}</button>
          {(localErr || error) && <span className="text-xs text-red-400 ml-auto">{localErr || error}</span>}
        </div>
      </div>
    </div>
  );
}

// ── Helpers for the execution form ────────────────────────────────────────

/**
 * Returns true if the input schema field is a file to upload.
 * Canonical signal: `format: 'file-ref'`. Fallbacks: the name ends in _path/_file,
 * or the description mentions a file/upload (EN + legacy IT terms, language-agnostic).
 */
function isFileField(name: string, prop: Record<string, unknown>): boolean {
  if (prop.format === 'file-ref') return true;
  if (name.endsWith('_path') || name.endsWith('_file')) return true;
  const desc = ((prop.description as string) ?? '').toLowerCase();
  return desc.includes('absolute path') || desc.includes('path assoluto')
    || desc.includes('upload') || desc.includes('file-ref')
    || desc.includes('file path') || desc.includes('csv file') || desc.includes('file csv');
}

/**
 * Timeout options for manual script execution.
 */
const TIMEOUT_OPTIONS = [
  { label: '30s',  value: 30_000  },
  { label: '1 min', value: 60_000  },
  { label: '2 min', value: 120_000 },
  { label: '5 min', value: 300_000 },
  { label: '10 min',value: 600_000 },
];

// ── ScriptRow: script row with optional execution form ───────────────────

function ScriptRow({
  script,
  skillId,
  skillStatus,
  isOwn,
}: {
  script:      SkillScript;
  skillId:     string;
  skillStatus: SkillStatus;
  isOwn:       boolean;
}) {
  const { t } = useTranslation('skills');
  const qc = useQueryClient();

  const [open,        setOpen]        = useState(false);
  const [execOpen,    setExecOpen]    = useState(false);
  const [values,      setValues]      = useState<Record<string, string>>({});
  const [fileMap,     setFileMap]     = useState<Record<string, File>>({});
  const [timeoutMs,   setTimeoutMs]   = useState(120_000);
  const [result,      setResult]      = useState<ExecuteScriptResult | null>(null);
  const [executing,   setExecuting]   = useState(false);
  const [execError,   setExecError]   = useState<string | null>(null);
  const [showSchema,  setShowSchema]  = useState(false);
  const [showResult,  setShowResult]  = useState(true);
  const [noteEdit,    setNoteEdit]    = useState(false);
  const [noteDraft,   setNoteDraft]   = useState(script.contextNote ?? '');

  // Bidirectional mutation: true ↔ false
  const llmToggleMut = useMutation({
    mutationFn: (next: boolean) => skillsApi.setScriptLlmCallable(skillId, script.id, next),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['skill', skillId] });
      qc.invalidateQueries({ queryKey: ['skills'] });
    },
  });

  const contextNoteMut = useMutation({
    mutationFn: (note: string | null) => skillsApi.setScriptContextNote(skillId, script.id, note),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['skill', skillId] });
      qc.invalidateQueries({ queryKey: ['skills'] });
      setNoteEdit(false);
    },
  });

  // Input schema properties (null if absent or empty)
  const schema     = script.inputSchema as Record<string, unknown> | null;
  const properties = schema?.properties as Record<string, Record<string, unknown>> | undefined;
  const required   = (schema?.required as string[]) ?? [];
  const hasSchema  = properties && Object.keys(properties).length > 0;

  // Can execute: owner only, skill ready, task script (not daemon)
  const canExecute = isOwn && skillStatus === 'ready' && script.mode !== 'daemon';

  const handleFileChange = (fieldname: string, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileMap((prev) => ({ ...prev, [fieldname]: file }));
  };

  const handleExecute = async () => {
    setExecuting(true);
    setExecError(null);
    setResult(null);
    setShowResult(true);

    try {
      // Build the input from the text values
      const input: Record<string, unknown> = {};
      if (hasSchema) {
        for (const [name, prop] of Object.entries(properties!)) {
          const raw = values[name];
          if (!raw?.trim()) continue; // leave non-required fields empty
          // Parse JSON for array/object
          const type = prop.type as string;
          if (type === 'array' || type === 'object') {
            try   { input[name] = JSON.parse(raw); }
            catch { input[name] = raw; } // fallback: raw string
          } else if (type === 'number' || type === 'integer') {
            input[name] = Number(raw);
          } else {
            input[name] = raw;
          }
        }
      } else {
        // Schema absent: raw JSON textarea
        const raw = values['__raw__'];
        if (raw?.trim()) {
          try   { Object.assign(input, JSON.parse(raw)); }
          catch { /* ignore */ }
        }
      }

      const res = await skillsApi.executeScript(
        skillId,
        script.filename,
        input,
        Object.keys(fileMap).length ? fileMap : undefined,
        timeoutMs,
      );
      setResult(res);
    } catch (e: any) {
      const msg = e?.response?.data?.message ?? e?.message ?? t('script.execError');
      setExecError(msg);
    } finally {
      setExecuting(false);
    }
  };

  return (
    <div className="border border-gray-700/60 rounded-lg overflow-hidden">
      {/* ── Row header ── */}
      <div className="flex items-center gap-2 px-3 py-2.5 bg-gray-800/50">
        <button
          onClick={() => setOpen((p) => !p)}
          className="flex items-center gap-2 flex-1 min-w-0 hover:text-gray-100 transition-colors text-left"
        >
          <FileCode size={13} className="text-gray-400 flex-shrink-0" />
          <span className="text-xs font-mono text-gray-200 flex-1 truncate">{script.filename}</span>
          <LangBadge lang={script.language} />
          {open ? <ChevronDown size={13} className="text-gray-500" /> : <ChevronRight size={13} className="text-gray-500" />}
        </button>

        {/* ── LLM callable toggle (owner) / badge (non-owner) ─────────────── */}
        {isOwn && skillStatus === 'ready' ? (
          /* Owner: bidirectional toggle */
          <button
            onClick={(e) => { e.stopPropagation(); llmToggleMut.mutate(!script.llmCallable); }}
            disabled={llmToggleMut.isPending}
            title={script.llmCallable
              ? t('script.llmVisible')
              : t('script.llmHidden')}
            className={`flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded border
              transition-colors disabled:opacity-50 flex-shrink-0
              ${script.llmCallable
                ? 'border-emerald-800/50 bg-emerald-900/20 text-emerald-500 hover:border-orange-700/50 hover:bg-orange-900/20 hover:text-orange-400'
                : 'border-gray-700 bg-gray-800 text-gray-500 hover:border-indigo-700/50 hover:bg-indigo-900/20 hover:text-indigo-400'
              }`}
          >
            {llmToggleMut.isPending
              ? <Loader2 size={9} className="animate-spin" />
              : script.llmCallable ? <Eye size={9} /> : <EyeOff size={9} />}
            {script.llmCallable ? 'LLM' : 'bus-only'}
          </button>
        ) : (
          /* Non owner: static badge only if hidden */
          !script.llmCallable && (
            <span className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded border
              border-gray-700 bg-gray-800 text-gray-500 flex-shrink-0">
              <EyeOff size={9} /> bus-only
            </span>
          )
        )}

        {/* Execute button (owner only + ready + task) */}
        {canExecute && (
          <button
            onClick={(e) => { e.stopPropagation(); setExecOpen((p) => !p); }}
            title={t('script.runManual')}
            className={`flex items-center gap-1 px-2 py-1 text-xs rounded-md border transition-colors flex-shrink-0
              ${execOpen
                ? 'bg-indigo-900/60 border-indigo-700/60 text-indigo-300'
                : 'border-gray-700 text-gray-500 hover:border-indigo-700/60 hover:text-indigo-400'
              }`}
          >
            <Terminal size={11} />
            {t('script.run')}
          </button>
        )}
      </div>

      {/* ── Script detail (opened by clicking the header) ── */}
      {open && (
        <div className="px-3 py-2.5 bg-gray-800/20 border-t border-gray-700/40 space-y-2">
          <p className="text-xs text-gray-400">{script.description}</p>

          {/* ── LLM context note ── */}
          {isOwn && script.llmCallable && (
            <div className="border border-amber-800/30 rounded-md bg-amber-950/10 p-2 space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] font-semibold text-amber-400/80 uppercase tracking-wide">
                  {t('script.llmContext')}
                </span>
                {!noteEdit && (
                  <button
                    onClick={() => { setNoteDraft(script.contextNote ?? ''); setNoteEdit(true); }}
                    className="text-[10px] text-gray-500 hover:text-amber-400 transition-colors"
                  >
                    {script.contextNote ? t('script.editNote') : t('script.addNote')}
                  </button>
                )}
              </div>

              {noteEdit ? (
                <div className="space-y-1.5">
                  <textarea
                    rows={4}
                    value={noteDraft}
                    onChange={(e) => setNoteDraft(e.target.value)}
                    placeholder={t('script.notePlaceholder')}
                    className="w-full text-xs font-mono bg-gray-900 border border-gray-700 rounded p-2 text-gray-200 placeholder-gray-600 resize-none focus:outline-none focus:border-amber-700/60"
                  />
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => contextNoteMut.mutate(noteDraft.trim() || null)}
                      disabled={contextNoteMut.isPending}
                      className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-amber-700/50 bg-amber-900/20 text-amber-300 hover:bg-amber-900/40 disabled:opacity-50 transition-colors"
                    >
                      {contextNoteMut.isPending ? <Loader2 size={10} className="animate-spin" /> : null}
                      {t('common:actions.save')}
                    </button>
                    {script.contextNote && (
                      <button
                        onClick={() => contextNoteMut.mutate(null)}
                        disabled={contextNoteMut.isPending}
                        className="text-[10px] text-gray-600 hover:text-red-400 transition-colors"
                      >
                        {t('script.removeNote')}
                      </button>
                    )}
                    <button
                      onClick={() => setNoteEdit(false)}
                      className="text-[10px] text-gray-600 hover:text-gray-400 transition-colors ml-auto"
                    >
                      {t('common:actions.cancel')}
                    </button>
                  </div>
                </div>
              ) : script.contextNote ? (
                <p className="text-xs text-amber-200/70 whitespace-pre-wrap">{script.contextNote}</p>
              ) : script.lastInfoOutput ? (
                <div className="space-y-1">
                  <p className="text-[10px] text-gray-500 italic">
                    {t('script.noManualNote')}
                  </p>
                  <pre className="text-[10px] text-gray-400 bg-gray-900 rounded p-1.5 overflow-x-auto max-h-24 whitespace-pre-wrap">
                    {script.lastInfoOutput.length > 400
                      ? script.lastInfoOutput.slice(0, 400) + '…'
                      : script.lastInfoOutput}
                  </pre>
                </div>
              ) : (
                <p className="text-[11px] text-gray-600 italic">
                  {t('script.noNote')}
                </p>
              )}
            </div>
          )}

          {script.inputSchema && (
            <div>
              <button
                onClick={() => setShowSchema((p) => !p)}
                className="flex items-center gap-1 text-xs text-gray-600 hover:text-gray-400 transition-colors"
              >
                {showSchema ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                Input schema
              </button>
              {showSchema && (
                <pre className="mt-1 text-xs font-mono text-gray-400 bg-gray-900 rounded p-2 overflow-x-auto">
                  {JSON.stringify(script.inputSchema, null, 2)}
                </pre>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Manual execution panel ── */}
      {execOpen && canExecute && (
        <div className="border-t border-indigo-700/50 bg-indigo-900/20 px-3 py-3 space-y-3">
          <p className="text-xs font-semibold text-indigo-300 flex items-center gap-1.5">
            <Terminal size={12} /> {t('script.manualExec')}
          </p>

          {/* Dynamic form from the input schema fields */}
          {hasSchema ? (
            <div className="space-y-2.5">
              {Object.entries(properties!).map(([name, prop]) => {
                const type        = prop.type as string;
                const desc        = prop.description as string | undefined;
                const isReq       = required.includes(name);
                const isFile      = isFileField(name, prop);
                const selectedFile = fileMap[name];

                return (
                  <div key={name} className="space-y-1">
                    <label className="flex items-center gap-1 text-xs font-mono text-gray-300">
                      {name}
                      {isReq && <span className="text-red-400">*</span>}
                      {isFile && <Paperclip size={10} className="text-gray-500" />}
                      <span className="text-gray-600 font-sans font-normal ml-1">
                        ({type === 'array' ? 'array JSON' : type === 'object' ? 'object JSON' : isFile ? 'file' : type})
                      </span>
                    </label>
                    {desc && (
                      <p className="text-[11px] text-gray-500 leading-relaxed line-clamp-2">{desc}</p>
                    )}

                    {/* File upload */}
                    {isFile ? (
                      <div className="flex items-center gap-2">
                        <label className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border cursor-pointer transition-colors
                          ${selectedFile
                            ? 'border-emerald-700/60 bg-emerald-900/20 text-emerald-300'
                            : 'border-gray-700 text-gray-400 hover:border-indigo-700/60 hover:text-indigo-400'
                          }`}>
                          <Paperclip size={11} />
                          {selectedFile ? selectedFile.name : t('script.chooseFile')}
                          <input
                            type="file"
                            className="hidden"
                            onChange={(e) => handleFileChange(name, e)}
                          />
                        </label>
                        {selectedFile && (
                          <button
                            onClick={() => setFileMap((p) => { const n = { ...p }; delete n[name]; return n; })}
                            className="text-gray-600 hover:text-red-400 transition-colors"
                          >
                            <XCircle size={13} />
                          </button>
                        )}
                      </div>
                    ) : type === 'array' || type === 'object' ? (
                      /* JSON textarea */
                      <textarea
                        rows={3}
                        value={values[name] ?? ''}
                        onChange={(e) => setValues((p) => ({ ...p, [name]: e.target.value }))}
                        placeholder={type === 'array' ? '[...]' : '{...}'}
                        className="w-full px-2.5 py-1.5 bg-gray-900 border border-gray-700 rounded-lg
                          text-xs font-mono text-gray-200 placeholder-gray-700
                          focus:outline-none focus:border-indigo-500 transition-colors resize-y"
                      />
                    ) : type === 'number' || type === 'integer' ? (
                      /* Number */
                      <input
                        type="number"
                        value={values[name] ?? ''}
                        onChange={(e) => setValues((p) => ({ ...p, [name]: e.target.value }))}
                        className="w-full px-2.5 py-1.5 bg-gray-900 border border-gray-700 rounded-lg
                          text-xs font-mono text-gray-200
                          focus:outline-none focus:border-indigo-500 transition-colors"
                      />
                    ) : (
                      /* Text */
                      <input
                        type="text"
                        value={values[name] ?? ''}
                        onChange={(e) => setValues((p) => ({ ...p, [name]: e.target.value }))}
                        placeholder={`${name}…`}
                        className="w-full px-2.5 py-1.5 bg-gray-900 border border-gray-700 rounded-lg
                          text-xs font-mono text-gray-200 placeholder-gray-700
                          focus:outline-none focus:border-indigo-500 transition-colors"
                      />
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            /* No schema: generic JSON textarea */
            <div className="space-y-1">
              <label className="text-xs text-gray-500">Input (JSON)</label>
              <textarea
                rows={4}
                value={values['__raw__'] ?? ''}
                onChange={(e) => setValues({ '__raw__': e.target.value })}
                placeholder='{"key": "value"}'
                className="w-full px-2.5 py-1.5 bg-gray-900 border border-gray-700 rounded-lg
                  text-xs font-mono text-gray-200 placeholder-gray-700
                  focus:outline-none focus:border-indigo-500 transition-colors resize-y"
              />
            </div>
          )}

          {/* Timeout selector */}
          <div className="flex items-center gap-2">
            <Timer size={12} className="text-gray-500 flex-shrink-0" />
            <label className="text-xs text-gray-500">Timeout:</label>
            <div className="flex items-center gap-1">
              {TIMEOUT_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setTimeoutMs(opt.value)}
                  className={`px-2 py-0.5 text-xs rounded-md border transition-colors
                    ${timeoutMs === opt.value
                      ? 'border-indigo-600 bg-indigo-900/50 text-indigo-300'
                      : 'border-gray-700 text-gray-500 hover:border-gray-600'
                    }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Run button */}
          <div className="flex items-center gap-3">
            <button
              onClick={handleExecute}
              disabled={executing}
              className="flex items-center gap-1.5 px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500
                disabled:opacity-50 text-white text-xs rounded-lg transition-colors"
            >
              {executing
                ? <><Loader2 size={12} className="animate-spin" /> {t('script.running')}</>
                : <><Play size={12} /> {t('script.run')}</>
              }
            </button>
            {result && (
              <button
                onClick={() => setResult(null)}
                className="text-xs text-gray-600 hover:text-gray-400 transition-colors"
              >
                {t('script.clear')}
              </button>
            )}
          </div>

          {/* API call error */}
          {execError && (
            <div className="flex items-start gap-2 px-3 py-2 bg-red-950/40 border border-red-800/40 rounded-lg">
              <XCircle size={13} className="text-red-400 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-red-300">{execError}</p>
            </div>
          )}

          {/* Result */}
          {result && showResult && (
            <div className="space-y-2">
              {/* Success/error banner */}
              <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-medium
                ${result.success
                  ? 'bg-emerald-950/40 border-emerald-800/40 text-emerald-300'
                  : 'bg-red-950/40 border-red-800/40 text-red-300'
                }`}>
                {result.success
                  ? <CheckCircle size={13} />
                  : <XCircle size={13} />
                }
                {result.success ? t('script.completed') : t('script.errorExit', { code: result.exit_code })}
                <span className="ml-auto text-gray-500 font-normal">{result.duration_ms}ms</span>
              </div>

              {/* Structured JSON output */}
              {result.output != null && (
                <div className="space-y-1">
                  <p className="text-[11px] text-gray-600 uppercase tracking-wider">Output</p>
                  <pre className="text-xs font-mono text-gray-300 bg-gray-900 rounded-lg p-2.5
                    overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap break-all">
                    {JSON.stringify(result.output, null, 2)}
                  </pre>
                </div>
              )}

              {/* Raw stdout (if not JSON or output is null but raw is non-empty) */}
              {!result.output && result.raw && (
                <div className="space-y-1">
                  <p className="text-[11px] text-gray-600 uppercase tracking-wider">Stdout (raw)</p>
                  <pre className="text-xs font-mono text-gray-400 bg-gray-900 rounded-lg p-2.5
                    overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap break-all">
                    {result.raw}
                  </pre>
                </div>
              )}

              {/* Stderr (errors/warnings) */}
              {result.stderr && (
                <div className="space-y-1">
                  <p className="text-[11px] text-amber-600 uppercase tracking-wider">Stderr</p>
                  <pre className="text-xs font-mono text-amber-300/70 bg-amber-950/20 border border-amber-800/30
                    rounded-lg p-2.5 overflow-x-auto max-h-32 overflow-y-auto whitespace-pre-wrap break-all">
                    {result.stderr}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Skill variables configuration section ────────────────────────────────────

function ConfigSection({ skillId }: { skillId: string }) {
  const { t } = useTranslation('skills');
  const qc = useQueryClient();
  const [editKey,    setEditKey]    = useState<string | null>(null);
  const [editValue,  setEditValue]  = useState('');
  const [showSecret, setShowSecret] = useState<Record<string, boolean>>({});
  const [msg, setMsg] = useState<{ key: string; ok: boolean; text: string } | null>(null);
  const [expandedDesc, setExpandedDesc] = useState<Set<string>>(new Set());

  const { data, isLoading } = useQuery({
    queryKey: ['skill-config', skillId],
    queryFn:  () => skillsApi.getConfig(skillId),
    staleTime: 30_000,
  });

  const { data: dataSources = [] } = useQuery<DataSource[]>({
    queryKey: ['datasources'],
    queryFn:  () => dataSourcesApi.list(),
    staleTime: 60_000,
  });

  const { data: vectorCollections = [] } = useQuery<VectorCollection[]>({
    queryKey: ['vector-collections'],
    queryFn:  () => vectorDbApi.listCollections(),
    staleTime: 60_000,
  });

  const saveMutation = useMutation({
    mutationFn: ({ key, value }: { key: string; value: string }) =>
      skillsApi.setConfigVar(skillId, key, value),
    onSuccess: (_, { key }) => {
      qc.invalidateQueries({ queryKey: ['skill-config', skillId] });
      setMsg({ key, ok: true, text: t('config.saved') });
      setEditKey(null);
      setTimeout(() => setMsg(null), 2500);
    },
    onError: (e: any, { key }) => {
      setMsg({ key, ok: false, text: e?.response?.data?.message ?? t('config.error') });
    },
  });

  const resetMutation = useMutation({
    mutationFn: (key: string) => skillsApi.resetConfigVar(skillId, key),
    onSuccess: (_, key) => {
      qc.invalidateQueries({ queryKey: ['skill-config', skillId] });
      setMsg({ key, ok: true, text: t('config.resetDone') });
      setTimeout(() => setMsg(null), 2500);
    },
    onError: (e: any, key) => {
      setMsg({ key, ok: false, text: e?.response?.data?.message ?? t('config.error') });
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-gray-500 text-xs py-2">
        <Loader2 size={12} className="animate-spin" /> {t('config.loading')}
      </div>
    );
  }

  if (!data || data.vars.length === 0) return null;

  const startEdit = (key: string, current: string | null, defaultVal?: string) => {
    setEditKey(key);
    // Pre-fill with the current unmasked value, or the resolved default
    setEditValue(current && current !== '••••' ? current : (data.vars.find(v => v.key === key)?.resolved ?? defaultVal ?? ''));
  };

  return (
    <div className="space-y-3">
      {/* Header with system variables hint */}
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
          {t('config.title')}
        </p>
        <details className="relative group">
          <summary className="text-xs text-gray-600 hover:text-gray-400 cursor-pointer select-none list-none">
            {t('config.systemVars')}
          </summary>
          <div className="absolute right-0 top-5 z-10 w-64 bg-gray-800 border border-gray-700 rounded-lg p-2 shadow-xl">
            <p className="text-xs text-gray-500 mb-1.5">{t('config.systemVarsHintPre')} <code className="text-gray-400">${'{UPLOAD_DIR}'}</code>{t('config.systemVarsHintPost')}</p>
            {Object.entries(data.systemVars).map(([k, v]) => (
              <div key={k} className="flex items-center gap-1 text-xs font-mono py-0.5">
                <span className="text-indigo-400">{k}</span>
                <span className="text-gray-600">=</span>
                <span className="text-gray-300 truncate">{v || t('config.empty')}</span>
              </div>
            ))}
          </div>
        </details>
      </div>

      {/* Variables list */}
      <div className="space-y-2">
        {data.vars.map((v) => {
          const isEditing = editKey === v.key;
          const feedbackThis = msg?.key === v.key ? msg : null;
          const isVisible = showSecret[v.key];

          return (
            <div key={v.key} className="border border-gray-700/60 rounded-lg overflow-hidden">
              {/* Row header */}
              <div className="flex items-start gap-2 px-3 py-2 bg-gray-800/40">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-mono font-medium text-gray-200">{v.key}</span>
                    {v.required && (
                      <span className="px-1 py-0.5 text-[10px] bg-red-900/40 border border-red-800/50 text-red-300 rounded">
                        required
                      </span>
                    )}
                    {v.secret && (
                      <span className="px-1 py-0.5 text-[10px] bg-amber-900/40 border border-amber-800/50 text-amber-300 rounded">
                        secret
                      </span>
                    )}
                    {v.isOverridden && (
                      <span className="px-1 py-0.5 text-[10px] bg-indigo-900/40 border border-indigo-800/50 text-indigo-300 rounded">
                        custom
                      </span>
                    )}
                  </div>
                  {(() => {
                    const desc     = v.description ?? '';
                    const isLong   = desc.length > 200;
                    const isOpen   = expandedDesc.has(v.key);
                    const visible  = isLong && !isOpen ? desc.slice(0, 200).trimEnd() + '…' : desc;
                    return (
                      <div className="mt-0.5">
                        <p className="text-xs text-gray-500 whitespace-pre-wrap">{visible}</p>
                        {isLong && (
                          <button
                            onClick={() => setExpandedDesc(prev => {
                              const next = new Set(prev);
                              isOpen ? next.delete(v.key) : next.add(v.key);
                              return next;
                            })}
                            className="text-[10px] text-indigo-400 hover:text-indigo-300 mt-0.5 transition-colors"
                          >
                            {isOpen ? t('config.showLess') : t('config.showMore')}
                          </button>
                        )}
                      </div>
                    );
                  })()}
                  {v.default && !v.isOverridden && (
                    <p className="text-xs text-gray-600 font-mono mt-0.5">
                      default: <span className="text-gray-400">{v.default}</span>
                    </p>
                  )}
                  {v.isOverridden && !v.secret && v.resolved && (
                    <p className="text-xs text-gray-600 font-mono mt-0.5">
                      →&nbsp;<span className="text-emerald-400">
                        {v.type === 'datasource'
                          ? (dataSources.find((ds) => ds.id === v.resolved)?.name ?? v.resolved)
                          : v.type === 'collection'
                          ? (vectorCollections.find((c) => c.name === v.resolved)?.name ?? v.resolved)
                          : v.resolved}
                      </span>
                    </p>
                  )}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 flex-shrink-0 mt-0.5">
                  {v.isOverridden && (
                    <button
                      onClick={() => resetMutation.mutate(v.key)}
                      disabled={resetMutation.isPending}
                      title={t('config.resetTitle')}
                      className="p-1 text-gray-600 hover:text-amber-400 rounded transition-colors disabled:opacity-50"
                    >
                      <RotateCcw size={11} />
                    </button>
                  )}
                  <button
                    onClick={() => isEditing ? setEditKey(null) : startEdit(v.key, v.value, v.default)}
                    className="p-1 text-gray-600 hover:text-gray-300 rounded transition-colors"
                  >
                    {isEditing ? <XCircle size={13} /> : <Settings2 size={13} />}
                  </button>
                </div>
              </div>

              {/* Edit form */}
              {isEditing && (
                <div className="px-3 py-2.5 bg-gray-800/20 border-t border-gray-700/40 space-y-2">
                  <div className="relative">
                    {v.type === 'json' ? (
                      /* JSON: multi-line textarea with mono font */
                      <textarea
                        rows={14}
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        placeholder={v.default || '{ }'}
                        spellCheck={false}
                        className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg
                          text-xs text-gray-100 placeholder-gray-600 font-mono leading-relaxed
                          focus:outline-none focus:border-indigo-500 transition-colors resize-y"
                      />
                    ) : v.type === 'datasource' ? (
                      /* Datasource: dropdown with the configured connections */
                      <div className="flex items-center gap-2">
                        <Database size={13} className="text-gray-500 flex-shrink-0" />
                        <select
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          className="flex-1 px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg
                            text-sm text-gray-100 focus:outline-none focus:border-indigo-500 transition-colors"
                        >
                          <option value="">{t('config.selectDatasource')}</option>
                          {dataSources
                            .filter((ds) => !v.family || engineFamily(ds.engine) === v.family)
                            .map((ds) => (
                            <option key={ds.id} value={ds.id}>
                              {ds.name}{ds.description ? ` — ${ds.description}` : ''}
                            </option>
                          ))}
                        </select>
                      </div>
                    ) : v.type === 'collection' ? (
                      /* Collection: dropdown with the configured vector collections */
                      <div className="flex items-center gap-2">
                        <Cpu size={13} className="text-gray-500 flex-shrink-0" />
                        <select
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          className="flex-1 px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg
                            text-sm text-gray-100 focus:outline-none focus:border-indigo-500 transition-colors"
                        >
                          <option value="">{t('config.selectCollection')}</option>
                          {vectorCollections.map((c) => (
                            <option key={c.id} value={c.name}>
                              {c.name}{c.isDefault ? ' ★' : ''}{c.description ? ` — ${c.description}` : ''}
                            </option>
                          ))}
                        </select>
                      </div>
                    ) : (
                      /* Normal text: single-line input */
                      <>
                        <input
                          type={v.secret && !showSecret[v.key] ? 'password' : 'text'}
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          placeholder={v.default ? t('config.defaultPlaceholder', { default: v.default }) : t('config.valuePlaceholder')}
                          className="w-full px-3 py-1.5 pr-8 bg-gray-800 border border-gray-700 rounded-lg
                            text-sm text-gray-100 placeholder-gray-600 font-mono
                            focus:outline-none focus:border-indigo-500 transition-colors"
                        />
                        {v.secret && (
                          <button
                            type="button"
                            onClick={() => setShowSecret((p) => ({ ...p, [v.key]: !p[v.key] }))}
                            className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
                          >
                            {isVisible ? <EyeOff size={13} /> : <Eye size={13} />}
                          </button>
                        )}
                      </>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => saveMutation.mutate({ key: v.key, value: editValue })}
                      disabled={saveMutation.isPending}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500
                        disabled:opacity-50 text-white text-xs rounded-lg transition-colors"
                    >
                      {saveMutation.isPending ? <Loader2 size={11} className="animate-spin" /> : <CheckCircle size={11} />}
                      {t('common:actions.save')}
                    </button>
                    {feedbackThis && (
                      <span className={`text-xs flex items-center gap-1 ${feedbackThis.ok ? 'text-emerald-400' : 'text-red-400'}`}>
                        {feedbackThis.ok ? <CheckCircle size={11} /> : <XCircle size={11} />}
                        {feedbackThis.text}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Skill status panel (script mode: info) ──────────────────────────────────

/**
 * Renders the JSON output of a mode:info script in a readable form.
 *
 * Rendering logic:
 *  - Array of objects → list of mini-cards with key/value
 *  - Scalar          → simple "key: value" row
 *  - Technical fields (output_dir, traceback) → hidden
 */
function InfoScriptOutput({ output }: { output: unknown }) {
  if (output == null) return null;

  if (typeof output !== 'object' || Array.isArray(output)) {
    return (
      <pre className="text-xs font-mono text-gray-300 bg-gray-900/60 rounded-lg p-2.5 overflow-x-auto">
        {JSON.stringify(output, null, 2)}
      </pre>
    );
  }

  const data = output as Record<string, unknown>;
  // Technical fields to hide in the UI (but still present in the raw JSON)
  const HIDDEN_KEYS = new Set(['output_dir', 'traceback']);

  return (
    <div className="space-y-3">
      {Object.entries(data)
        .filter(([key]) => !HIDDEN_KEYS.has(key))
        .map(([key, value]) => {
          if (Array.isArray(value)) {
            // Array → list of mini-cards
            return (
              <div key={key}>
                <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1.5 flex items-center gap-1">
                  <Database size={9} />
                  {key}
                  <span className="text-gray-700">({value.length})</span>
                </p>
                {value.length === 0 ? (
                  <p className="text-xs text-gray-600 italic px-1">
                    No items — run a training first.
                  </p>
                ) : (
                  <div className="space-y-1.5">
                    {value.map((item, i) => (
                      <div
                        key={i}
                        className="px-3 py-2 bg-gray-800/60 rounded-lg border border-gray-700/40"
                      >
                        {typeof item === 'object' && item !== null ? (
                          <div className="flex flex-wrap gap-x-4 gap-y-0.5">
                            {Object.entries(item as Record<string, unknown>).map(([k, v]) => (
                              <div key={k} className="flex items-baseline gap-1">
                                <span className="text-[10px] text-gray-500 flex-shrink-0">{k}</span>
                                <span className="text-xs text-gray-200 font-mono">{String(v ?? '—')}</span>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <span className="text-xs text-gray-200 font-mono">{String(item)}</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          }

          // Scalar → key/value row
          if (typeof value === 'object') return null;
          return (
            <div key={key} className="flex items-center gap-2 text-xs">
              <span className="text-gray-500 flex-shrink-0">{key}</span>
              <span className="text-gray-300 font-mono">{String(value ?? '—')}</span>
            </div>
          );
        })}
    </div>
  );
}

/**
 * "Status" panel — automatically runs the skill's first mode:info script
 * when the drawer opens and shows the result in a readable form.
 *
 * - Auto-runs on mount (only if skill.status === 'ready')
 * - "Refresh" button to re-run on-demand
 * - Hidden if the skill has no mode:info script
 */
function InfoScriptPanel({ skill }: { skill: Skill }) {
  const { t } = useTranslation('skills');
  const infoScript = skill.scripts.find((s) => s.mode === 'info');
  const [result,  setResult]  = useState<ExecuteScriptResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  const run = async () => {
    if (!infoScript || skill.status !== 'ready') return;
    setLoading(true);
    setError(null);
    try {
      const res = await skillsApi.executeScript(skill.id, infoScript.filename, {});
      setResult(res);
    } catch (e: any) {
      setError(e?.response?.data?.message ?? e?.message ?? t('script.execError'));
    } finally {
      setLoading(false);
    }
  };

  // Auto-run on mount if the skill is ready
  useEffect(() => {
    if (skill.status === 'ready') run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skill.id]);

  if (!infoScript) return null;

  return (
    <div className="space-y-2">
      {/* Header */}
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
          <Activity size={12} /> {t('info.status')}
        </p>
        <button
          onClick={run}
          disabled={loading || skill.status !== 'ready'}
          title={t('info.refreshTitle')}
          className="flex items-center gap-1 text-xs text-gray-600 hover:text-gray-300
            transition-colors disabled:opacity-40"
        >
          {loading ? <Loader2 size={11} className="animate-spin" /> : <RotateCw size={11} />}
          {t('info.refresh')}
        </button>
      </div>

      {/* Execution error */}
      {error && (
        <div className="flex items-start gap-2 px-3 py-2 bg-red-950/40 border border-red-800/40 rounded-lg">
          <XCircle size={12} className="text-red-400 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-red-300">{error}</p>
        </div>
      )}

      {/* Initial loading (first execution) */}
      {loading && !result && (
        <div className="flex items-center gap-2 text-gray-500 text-xs py-1">
          <Loader2 size={12} className="animate-spin" /> {t('info.reading')}
        </div>
      )}

      {/* Skill not ready */}
      {skill.status !== 'ready' && !result && (
        <p className="text-xs text-gray-600 italic">
          {t('info.availableWhenReady')}
        </p>
      )}

      {/* Output */}
      {result && (
        <>
          {result.success ? (
            <InfoScriptOutput output={result.output} />
          ) : (
            <div className="px-3 py-2 bg-red-950/30 border border-red-800/30 rounded-lg">
              <p className="text-xs text-red-300">
                {(result.output as any)?.error ?? result.stderr ?? t('info.unknownError')}
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Custom components for react-markdown ──────────────────────────────────────

/**
 * Map of custom components for react-markdown.
 * Uses explicit Tailwind classes instead of @tailwindcss/typography
 * for precise control over font-size, colors and spacing.
 */
const MD: React.ComponentProps<typeof ReactMarkdown>['components'] = {
  // Headings — sizes scaled for the compact drawer
  h1: ({ children }) => (
    <h1 className="text-sm font-bold text-gray-100 mt-4 mb-2 pb-1 border-b border-gray-700/50 first:mt-0">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="text-xs font-semibold text-gray-200 mt-3 mb-1.5">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-[11px] font-semibold text-gray-300 mt-2.5 mb-1">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="text-[11px] font-medium text-gray-400 mt-2 mb-0.5">{children}</h4>
  ),

  // Paragraphs and text
  p: ({ children }) => (
    <p className="text-[11px] text-gray-400 leading-relaxed mb-2 last:mb-0">{children}</p>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold text-gray-200">{children}</strong>
  ),
  em: ({ children }) => (
    <em className="italic text-gray-300">{children}</em>
  ),

  // Link
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-indigo-400 hover:text-indigo-300 hover:underline transition-colors"
    >
      {children}
    </a>
  ),

  // Inline and block code
  // In react-markdown v9 the parent `pre` always wraps blocks — we use className
  // as a signal: fenced code blocks always receive className="language-xxx"
  code: ({ className, children }) => {
    const isBlock = Boolean(className);
    if (isBlock) {
      return (
        <code className="text-[10px] font-mono text-gray-300 leading-relaxed">
          {children}
        </code>
      );
    }
    return (
      <code className="px-1 py-0.5 rounded bg-gray-800 text-emerald-300 text-[10px] font-mono">
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="my-2 px-3 py-2.5 bg-gray-900 border border-gray-700/40 rounded-lg
      overflow-x-auto text-[10px] font-mono leading-relaxed">
      {children}
    </pre>
  ),

  // Lists
  ul: ({ children }) => (
    <ul className="my-1.5 pl-4 space-y-0.5 list-disc list-outside">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-1.5 pl-4 space-y-0.5 list-decimal list-outside">{children}</ol>
  ),
  li: ({ children }) => (
    <li className="text-[11px] text-gray-400 leading-relaxed">{children}</li>
  ),

  // Blockquote
  blockquote: ({ children }) => (
    <blockquote className="my-2 pl-3 border-l-2 border-indigo-500/50 text-gray-500 italic">
      {children}
    </blockquote>
  ),

  // Tables (GFM)
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto rounded-lg border border-gray-700/40">
      <table className="w-full text-[10px] border-collapse">{children}</table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="bg-gray-800/70">{children}</thead>
  ),
  tbody: ({ children }) => (
    <tbody className="divide-y divide-gray-700/30">{children}</tbody>
  ),
  tr: ({ children }) => <tr>{children}</tr>,
  th: ({ children }) => (
    <th className="px-2.5 py-1.5 text-left text-[10px] font-semibold text-gray-300">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="px-2.5 py-1.5 text-[10px] text-gray-400">{children}</td>
  ),

  // Separator
  hr: () => <hr className="my-3 border-gray-700/40" />,
};

// ── Documentation section (README / SKILL.md) ────────────────────────────────

/**
 * Collapsible section in the drawer that shows the content of README.md or SKILL.md.
 * The file is loaded on-demand on the first click (lazy loading).
 * Uses react-markdown + remark-gfm with custom components.
 */
function DocsSection({ skillId, packagePath }: { skillId: string; packagePath: string | null }) {
  const { t } = useTranslation('skills');
  const [open,    setOpen]    = useState(false);
  const [docs,    setDocs]    = useState<{ filename: string; content: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  if (!packagePath) return null;

  const toggle = async () => {
    // First open → load the file
    if (!open && !docs && !error) {
      setOpen(true);
      setLoading(true);
      try {
        const result = await skillsApi.getDocs(skillId);
        setDocs(result);
      } catch (e: any) {
        setError(e?.response?.data?.message ?? t('docs.error'));
      } finally {
        setLoading(false);
      }
    } else {
      setOpen((p) => !p);
    }
  };

  return (
    <div className="space-y-2">
      <button
        onClick={toggle}
        className="flex items-center gap-1.5 text-xs font-semibold text-gray-500 uppercase
          tracking-wider hover:text-gray-300 transition-colors w-full text-left"
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <BookOpen size={12} />
        {t('docs.title')}
        {docs && (
          <span className="ml-1 text-gray-700 font-normal normal-case tracking-normal">
            ({docs.filename})
          </span>
        )}
      </button>

      {open && (
        <div className="border border-gray-700/40 rounded-lg overflow-hidden">
          {loading && (
            <div className="flex items-center gap-2 text-gray-500 text-xs p-3">
              <Loader2 size={12} className="animate-spin" /> {t('docs.loading')}
            </div>
          )}

          {error && (
            <p className="text-xs text-gray-600 italic p-3">{error}</p>
          )}

          {docs && (
            <>
              {/* Header with filename */}
              <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-800/60 border-b border-gray-700/40">
                <FileText size={11} className="text-gray-500 flex-shrink-0" />
                <span className="text-[10px] text-gray-500 font-mono">{docs.filename}</span>
              </div>

              {/* Markdown content rendered with custom components */}
              <div className="px-4 py-3 max-h-[520px] overflow-y-auto">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD}>
                  {docs.content}
                </ReactMarkdown>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Project assignment section ─────────────────────────────────────────

/**
 * Shows the list of projects with an assign/unassign toggle.
 * - Inline search automatically enabled when projects are > 5.
 * - Scrollable list with max-h to hold an arbitrary number of projects.
 * - Shares the cache key ['skill-assignments', ...] with PublicSkillsTab:
 *   queries are not re-run if the data is already fresh.
 */
function ProjectAssignSection({ skillId }: { skillId: string }) {
  const { t } = useTranslation('skills');
  const qc = useQueryClient();
  const [search, setSearch] = useState('');

  const { data: projects = [] } = useQuery({
    queryKey: ['projects'],
    queryFn:  projectsApi.list,
    staleTime: 60_000,
  });

  // Same key used by PublicSkillsTab → uses shared cache
  const { data: assignmentsByProject = {}, isLoading } = useQuery({
    queryKey: ['skill-assignments', projects.map((p) => p.id).join(',')],
    queryFn: async () => {
      if (projects.length === 0) return {};
      const results = await Promise.all(
        projects.map((p) =>
          skillsApi.listByProject(p.id).then((skills) => ({
            projectId: p.id,
            skillIds:  skills.map((s) => s.id),
          })),
        ),
      );
      const map: Record<string, string[]> = {};
      for (const { projectId, skillIds } of results) {
        for (const sId of skillIds) {
          if (!map[sId]) map[sId] = [];
          map[sId].push(projectId);
        }
      }
      return map;
    },
    enabled: projects.length > 0,
    staleTime: 30_000,
  });

  const assignedProjectIds = assignmentsByProject[skillId] ?? [];

  const assignMutation = useMutation({
    mutationFn: (projectId: string) => skillsApi.assign(skillId, projectId),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['skill-assignments'] }),
  });

  const unassignMutation = useMutation({
    mutationFn: (projectId: string) => skillsApi.unassign(skillId, projectId),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['skill-assignments'] }),
  });

  const isMutating = assignMutation.isPending || unassignMutation.isPending;

  const filtered = search.trim()
    ? projects.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()))
    : projects;

  if (projects.length === 0) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <FolderOpen size={13} className="text-gray-500" />
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
          {t('project.title')}
        </p>
        {assignedProjectIds.length > 0 && (
          <span className="px-1.5 py-0.5 rounded-full bg-indigo-900/50 border border-indigo-800/50 text-indigo-300 text-[10px] font-medium">
            {t('project.assigned', { count: assignedProjectIds.length })}
          </span>
        )}
      </div>

      {/* Search — only if > 5 projects */}
      {projects.length > 5 && (
        <div className="relative">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('project.searchPlaceholder')}
            className="w-full pl-7 pr-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg
              text-xs text-gray-200 placeholder-gray-600
              focus:outline-none focus:border-indigo-500 transition-colors"
          />
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center gap-2 text-gray-500 text-xs py-1">
          <Loader2 size={12} className="animate-spin" /> {t('common:actions.loading')}
        </div>
      ) : (
        <div className="space-y-1.5 max-h-52 overflow-y-auto pr-0.5">
          {filtered.length === 0 ? (
            <p className="text-xs text-gray-600 italic">
              {search.trim() ? t('project.noneFound') : t('project.noneAvailable')}
            </p>
          ) : (
            filtered.map((p) => {
              const assigned = assignedProjectIds.includes(p.id);
              return (
                <div
                  key={p.id}
                  className="flex items-center justify-between px-2.5 py-2 rounded-lg
                    bg-gray-800/50 border border-gray-700/40 gap-2"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {p.color && (
                      <span
                        className="w-2 h-2 rounded-full flex-shrink-0"
                        style={{ backgroundColor: p.color }}
                      />
                    )}
                    <span className="text-xs text-gray-300 truncate">{p.name}</span>
                  </div>
                  <button
                    onClick={() =>
                      assigned
                        ? unassignMutation.mutate(p.id)
                        : assignMutation.mutate(p.id)
                    }
                    disabled={isMutating}
                    className={`text-xs px-2.5 py-1 rounded-md transition-colors disabled:opacity-50 flex-shrink-0
                      ${assigned
                        ? 'bg-emerald-900/40 border border-emerald-700/50 text-emerald-300 hover:bg-red-900/40 hover:border-red-700/50 hover:text-red-300'
                        : 'bg-gray-700 border border-gray-600 text-gray-300 hover:bg-indigo-900/40 hover:border-indigo-700/50 hover:text-indigo-300'
                      }`}
                  >
                    {isMutating
                      ? <Loader2 size={11} className="animate-spin" />
                      : assigned ? t('project.remove') : t('project.add')
                    }
                  </button>
                </div>
              );
            })
          )}
        </div>
      )}

      {assignedProjectIds.length > 0 && !search && (
        <p className="text-[10px] text-gray-600 leading-relaxed">
          {t('project.note')}
        </p>
      )}
    </div>
  );
}

// ── Skill enable toggle switch ─────────────────────────────────────────

/**
 * Compact toggle to enable/disable a skill.
 * stopPropagation prevents opening the drawer when clicking the switch.
 */
function SkillToggle({
  skill,
  onToggle,
}: {
  skill: Skill;
  onToggle?: () => void;
}) {
  const { t } = useTranslation('skills');
  const qc = useQueryClient();

  const toggleMutation = useMutation({
    mutationFn: (enabled: boolean) => skillsApi.setEnabled(skill.id, enabled),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['skills'] });
      qc.invalidateQueries({ queryKey: ['skill', skill.id] });
      onToggle?.();
    },
  });

  const isEnabled = skill.enabled !== false; // backward-compat: undefined → true

  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        toggleMutation.mutate(!isEnabled);
      }}
      disabled={toggleMutation.isPending}
      title={isEnabled ? t('toggleTitle.disable') : t('toggleTitle.enable')}
      className={`relative flex items-center w-9 h-5 rounded-full border transition-colors duration-200
        disabled:opacity-50 focus:outline-none flex-shrink-0
        ${isEnabled
          ? 'bg-indigo-600 border-indigo-500'
          : 'bg-gray-700 border-gray-600'
        }`}
    >
      {toggleMutation.isPending ? (
        <Loader2 size={10} className="absolute inset-0 m-auto animate-spin text-white" />
      ) : (
        <span
          className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform duration-200
            ${isEnabled ? 'translate-x-4' : 'translate-x-0.5'}`}
        />
      )}
    </button>
  );
}

// ── Skill card (used both in "My skills" and "Review") ─────────────────────

function SkillCard({
  skill,
  onClick,
  isOwn = false,
}: {
  skill: Skill;
  onClick: () => void;
  isOwn?: boolean;
}) {
  const { t } = useTranslation('skills');
  const isEnabled = skill.enabled !== false;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      className={`w-full text-left px-4 py-3.5 bg-gray-900 border rounded-xl cursor-pointer
        hover:border-gray-700 hover:bg-gray-900/70 transition-all group
        ${isEnabled ? 'border-gray-800' : 'border-gray-800/50 opacity-60'}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-sm font-medium transition-colors truncate
              ${isEnabled ? 'text-gray-100 group-hover:text-white' : 'text-gray-500'}`}>
              {skill.name}
            </span>
            <span className="text-xs text-gray-600 font-mono">v{skill.version}</span>
            {!isEnabled && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px]
                bg-gray-800 border border-gray-700 text-gray-500">
                <Power size={8} /> {t('cardDisabled')}
              </span>
            )}
          </div>
          {skill.description && (
            <p className="text-xs text-gray-500 mt-0.5 line-clamp-2 leading-relaxed">{skill.description}</p>
          )}
        </div>
        <div className="flex flex-col items-end gap-2 flex-shrink-0">
          <div className="flex items-center gap-2">
            {/* Enable/disable toggle (owner only) */}
            {isOwn && <SkillToggle skill={skill} />}
            <div className="flex flex-col items-end gap-1">
              <StatusBadge status={skill.status} />
              <ScopeBadge scope={skill.scope} />
            </div>
          </div>
        </div>
      </div>
      <div className="flex items-center gap-3 mt-2 text-xs text-gray-600">
        {skill.scripts.length > 0 && (
          <span className="flex items-center gap-1">
            <Code2 size={11} /> {t('marketplace.scripts', { count: skill.scripts.length })}
          </span>
        )}
        {skill.pythonDeps.length > 0 && (
          <span className="flex items-center gap-1">
            <FileText size={11} /> {t('shared.pyDeps', { count: skill.pythonDeps.length })}
          </span>
        )}
        {skill.jsDeps.length > 0 && (
          <span className="flex items-center gap-1">
            <FileText size={11} /> {t('shared.jsDeps', { count: skill.jsDeps.length })}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Tab 1: My skills ───────────────────────────────────────────────────────

function MySkillsTab({ userId, onOpen }: { userId: string; onOpen: (s: Skill) => void }) {
  const { t } = useTranslation('skills');
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploadErr, setUploadErr] = useState<string | null>(null);

  const { data: skills = [], isLoading } = useQuery({
    queryKey:  ['skills'],
    queryFn:   skillsApi.list,
    staleTime: 30_000,
  });

  // Only the current user's skills
  const mySkills = skills.filter((s) => s.ownerId === userId);

  const uploadMutation = useMutation({
    mutationFn: (file: File) => skillsApi.upload(file),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['skills'] });
      setUploadErr(null);
    },
    onError: (e: any) => {
      setUploadErr(e?.response?.data?.message ?? e?.message ?? t('upload.error'));
    },
  });

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.name.endsWith('.zip')) {
      setUploadErr(t('upload.onlyZip'));
      return;
    }
    setUploadErr(null);
    uploadMutation.mutate(file);
    // reset input so the same file can be re-uploaded
    e.target.value = '';
  };

  return (
    <div className="space-y-4">
      {/* Upload */}
      <div className="flex items-center gap-3">
        <input
          ref={fileRef}
          type="file"
          accept=".zip"
          className="hidden"
          onChange={handleFileChange}
        />
        <button
          onClick={() => fileRef.current?.click()}
          disabled={uploadMutation.isPending}
          className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500
            disabled:opacity-50 text-white text-sm rounded-lg transition-colors"
        >
          {uploadMutation.isPending
            ? <><Loader2 size={14} className="animate-spin" /> {t('upload.uploading')}</>
            : <><Upload size={14} /> {t('upload.button')}</>}
        </button>
        {uploadErr && (
          <span className="flex items-center gap-1.5 text-xs text-red-400">
            <XCircle size={13} /> {uploadErr}
          </span>
        )}
        {uploadMutation.isSuccess && (
          <span className="flex items-center gap-1.5 text-xs text-emerald-400">
            <CheckCircle size={13} /> {t('upload.uploaded')}
          </span>
        )}
      </div>

      {/* List */}
      {isLoading && (
        <div className="flex items-center gap-2 text-gray-500 text-sm py-4">
          <Loader2 size={14} className="animate-spin" /> {t('common:actions.loading')}
        </div>
      )}

      {!isLoading && mySkills.length === 0 && (
        <div className="text-center py-12 text-gray-600">
          <Package size={32} className="mx-auto mb-3 opacity-40" />
          <p className="text-sm">{t('empty')}</p>
        </div>
      )}

      {mySkills.length > 0 && (
        <div className="space-y-2">
          {mySkills.map((s) => (
            <SkillCard key={s.id} skill={s} isOwn={true} onClick={() => onOpen(s)} />
          ))}
        </div>
      )}

    </div>
  );
}

// ── Tab 2: Marketplace (GitHub registry) ────────────────────────────────────

/**
 * Card for a public registry skill.
 *
 * States:
 *   - "Install"     → not yet installed
 *   - "Installed"   → already present in the user's collection
 *   - Installing    → download + install in progress
 *
 * The body shows registry metadata; it does not open a drawer
 * (the skill is not yet installed locally, has no DB details).
 * The "Details" link opens the GitHub homepage if available.
 */
function MarketplaceCard({
  skill,
  isInstalled,
  onInstall,
  isInstalling,
}: {
  skill:        RegistrySkill;
  isInstalled:  boolean;
  onInstall:    () => void;
  isInstalling: boolean;
}) {
  const { t } = useTranslation('skills');
  const totalDeps = skill.dependencies.python.length + skill.dependencies.javascript.length;

  return (
    <div className="px-4 py-3.5 bg-gray-900 border border-gray-800 rounded-xl hover:border-gray-700 transition-colors">
      <div className="flex items-start gap-3">
        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-gray-100 truncate">{skill.name}</span>
            <span className="text-xs text-gray-600 font-mono">v{skill.version}</span>
            {isInstalled && (
              <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-md
                bg-emerald-900/40 border border-emerald-700/40 text-emerald-300 text-[10px]">
                <CheckCircle size={9} /> {t('marketplace.installed')}
              </span>
            )}
          </div>

          {skill.description && (
            <p className="text-xs text-gray-500 mt-0.5 line-clamp-2 leading-relaxed">
              {skill.description}
            </p>
          )}

          {/* Meta row */}
          <div className="flex items-center flex-wrap gap-2 mt-1.5">
            {skill.author && (
              <span className="text-xs text-gray-600">{t('marketplace.by', { author: skill.author })}</span>
            )}
            {skill.scriptCount > 0 && (
              <span className="flex items-center gap-1 text-xs text-gray-600">
                <Code2 size={10} /> {t('marketplace.scripts', { count: skill.scriptCount })}
              </span>
            )}
            {skill.languages.map((l) => (
              <LangBadge key={l} lang={l === 'node' ? 'javascript' : l} />
            ))}
            {totalDeps > 0 && (
              <span className="flex items-center gap-1 text-xs text-gray-600">
                <Package size={10} /> {t('marketplace.deps', { count: totalDeps })}
              </span>
            )}
            {skill.tags.map((tag) => (
              <span key={tag} className="px-1.5 py-0.5 rounded text-[10px]
                bg-gray-800 border border-gray-700/60 text-gray-500">
                {tag}
              </span>
            ))}
            {skill.homepage && (
              <a
                href={skill.homepage}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="text-[10px] text-indigo-500 hover:text-indigo-400 transition-colors"
              >
                GitHub ↗
              </a>
            )}
          </div>
        </div>

        {/* Action */}
        <div className="flex-shrink-0 pt-0.5">
          {isInstalled ? (
            <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs
              border border-gray-700 text-gray-500 cursor-default select-none">
              <CheckCircle size={12} /> {t('marketplace.installed')}
            </span>
          ) : (
            <button
              onClick={onInstall}
              disabled={isInstalling}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs
                bg-indigo-600 hover:bg-indigo-500 text-white transition-colors
                disabled:opacity-50 disabled:cursor-wait"
            >
              {isInstalling
                ? <><Loader2 size={12} className="animate-spin" /> {t('marketplace.installing')}</>
                : <><Download size={12} /> {t('marketplace.install')}</>
              }
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function PublicSkillsTab({ userId }: { userId: string }) {
  const { t } = useTranslation('skills');
  const qc = useQueryClient();
  const [search, setSearch]         = useState('');
  const [installing, setInstalling] = useState<Set<string>>(new Set());
  const [installErr, setInstallErr] = useState<Record<string, string>>({});

  // External registry (GitHub) — cached 5 min server-side
  const {
    data:    registry,
    isLoading,
    isError,
    refetch,
    isFetching,
  } = useQuery({
    queryKey:  ['skills-registry'],
    queryFn:   skillsApi.fetchRegistry,
    staleTime: 5 * 60 * 1000,
    retry:     1,
  });

  // Skills installed by the user (for the "Installed" badge)
  const { data: mySkills = [] } = useQuery({
    queryKey: ['skills'],
    queryFn:  skillsApi.list,
    staleTime: 30_000,
  });
  const mySkillNames = new Set(
    mySkills.filter((s) => s.ownerId === userId).map((s) => s.name),
  );

  const allSkills = registry?.skills ?? [];

  // Search filter (name + description + author + tag)
  const filtered = search.trim()
    ? allSkills.filter((s) => {
        const q = search.toLowerCase();
        return (
          s.name.toLowerCase().includes(q) ||
          s.description?.toLowerCase().includes(q) ||
          s.author?.toLowerCase().includes(q) ||
          s.tags?.some((tag) => tag.toLowerCase().includes(q))
        );
      })
    : allSkills;

  const handleInstall = async (skill: RegistrySkill) => {
    setInstalling((prev) => new Set(prev).add(skill.name));
    setInstallErr((prev) => { const next = { ...prev }; delete next[skill.name]; return next; });
    try {
      await skillsApi.installFromRegistry(skill.downloadUrl);
      qc.invalidateQueries({ queryKey: ['skills'] });
    } catch (e: any) {
      const msg = e?.response?.data?.message ?? t('marketplace.installFailed');
      setInstallErr((prev) => ({ ...prev, [skill.name]: msg }));
    } finally {
      setInstalling((prev) => { const next = new Set(prev); next.delete(skill.name); return next; });
    }
  };

  return (
    <div className="space-y-3">
      {/* Search + refresh */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('marketplace.searchPlaceholder')}
            className="w-full pl-8 pr-3 py-2 bg-gray-800 border border-gray-700 rounded-lg
              text-sm text-gray-200 placeholder-gray-500
              focus:outline-none focus:border-indigo-500 transition-colors"
          />
        </div>
        <button
          onClick={async () => {
            await skillsApi.refreshRegistry().catch(() => {/* ignore cache errors */});
            await qc.invalidateQueries({ queryKey: ['skills-registry'] });
            refetch();
          }}
          disabled={isFetching}
          title={t('marketplace.refreshTitle')}
          className="p-2 border border-gray-700 hover:border-gray-600 text-gray-400
            hover:text-gray-200 rounded-lg transition-colors disabled:opacity-40"
        >
          <RefreshCw size={14} className={isFetching ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Registry info */}
      {registry && (
        <p className="text-xs text-gray-600">
          {filtered.length === allSkills.length
            ? t('marketplace.countAll', { count: allSkills.length })
            : t('marketplace.countFiltered', { shown: filtered.length, total: allSkills.length })}
          {registry.updatedAt && (
            <span className="ml-2 text-gray-700">
              {t('marketplace.updatedAt', { date: new Date(registry.updatedAt).toLocaleDateString() })}
            </span>
          )}
        </p>
      )}

      {/* Loading */}
      {isLoading && (
        <div className="flex items-center gap-2 text-gray-500 text-sm py-6">
          <Loader2 size={14} className="animate-spin" /> {t('marketplace.connecting')}
        </div>
      )}

      {/* Registry error */}
      {isError && !isLoading && (
        <div className="px-4 py-5 bg-red-900/20 border border-red-800/40 rounded-xl text-center space-y-2">
          <AlertCircle size={24} className="mx-auto text-red-400 opacity-70" />
          <p className="text-sm text-red-300">{t('marketplace.unreachable')}</p>
          <p className="text-xs text-red-400/70">
            {t('marketplace.unreachableHintPre')} <code className="font-mono">SKILLS_REGISTRY_URL</code> {t('marketplace.unreachableHintPost')}
          </p>
          <button
            onClick={() => refetch()}
            className="text-xs text-indigo-400 hover:text-indigo-300 underline"
          >
            {t('common:actions.retry')}
          </button>
        </div>
      )}

      {/* Empty state */}
      {!isLoading && !isError && allSkills.length === 0 && (
        <div className="text-center py-12 text-gray-600">
          <Sparkles size={32} className="mx-auto mb-3 opacity-40" />
          <p className="text-sm">{t('marketplace.emptyTitle')}</p>
          <p className="text-xs mt-1 text-gray-700">
            {t('marketplace.emptyHint')}
          </p>
        </div>
      )}

      {/* No results */}
      {!isLoading && !isError && allSkills.length > 0 && filtered.length === 0 && (
        <p className="text-xs text-gray-600 italic text-center py-6">
          {t('marketplace.noMatch', { q: search })}
        </p>
      )}

      {/* List */}
      <div className="space-y-2">
        {filtered.map((s) => (
          <div key={s.name}>
            <MarketplaceCard
              skill={s}
              isInstalled={mySkillNames.has(s.name)}
              isInstalling={installing.has(s.name)}
              onInstall={() => handleInstall(s)}
            />
            {installErr[s.name] && (
              <p className="text-xs text-red-400 flex items-center gap-1 mt-1 px-1">
                <XCircle size={11} /> {installErr[s.name]}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Tab 3: Review (admin) ─────────────────────────────────────────────────────

function ReviewTab({ onOpen }: { onOpen: (s: Skill) => void }) {
  const { t } = useTranslation('skills');
  const qc = useQueryClient();
  const [rejectId, setRejectId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const { data: pending = [], isLoading } = useQuery({
    queryKey:  ['skills-pending-review'],
    queryFn:   skillsApi.pendingReview,
    staleTime: 15_000,
  });

  const approveMutation = useMutation({
    mutationFn: (id: string) => skillsApi.approve(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['skills-pending-review'] });
      qc.invalidateQueries({ queryKey: ['skills'] });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      skillsApi.reject(id, reason),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['skills-pending-review'] });
      qc.invalidateQueries({ queryKey: ['skills'] });
      setRejectId(null);
      setRejectReason('');
    },
  });

  return (
    <div className="space-y-3">
      {isLoading && (
        <div className="flex items-center gap-2 text-gray-500 text-sm py-4">
          <Loader2 size={14} className="animate-spin" /> {t('common:actions.loading')}
        </div>
      )}

      {!isLoading && pending.length === 0 && (
        <div className="text-center py-12 text-gray-600">
          <CheckCircle size={32} className="mx-auto mb-3 opacity-40" />
          <p className="text-sm">{t('review.noReview')}</p>
        </div>
      )}

      {pending.map((s) => (
        <div key={s.id} className="px-4 py-3.5 bg-gray-900 border border-gray-800 rounded-xl space-y-3">
          {/* Header */}
          <div className="flex items-start justify-between gap-3">
            <button
              onClick={() => onOpen(s)}
              className="flex-1 min-w-0 text-left group"
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-gray-100 group-hover:text-white truncate">{s.name}</span>
                <span className="text-xs text-gray-600 font-mono">v{s.version}</span>
              </div>
              {s.description && (
                <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{s.description}</p>
              )}
            </button>
            <span className="px-2 py-0.5 rounded-md border border-amber-700/50 bg-amber-900/30 text-amber-300 text-xs flex-shrink-0">
              {t('review.pending')}
            </span>
          </div>

          {/* Meta */}
          <div className="flex items-center gap-3 text-xs text-gray-600">
            {s.author && <span>by {s.author}</span>}
            {s.scripts.length > 0 && (
              <span className="flex items-center gap-1"><Code2 size={11} /> {s.scripts.length} script</span>
            )}
          </div>

          {/* Scripts preview */}
          {s.scripts.length > 0 && (
            <div className="space-y-1">
              {s.scripts.map((sc) => (
                <div key={sc.id} className="flex items-center gap-2 px-2 py-1.5 bg-gray-800/60 rounded-lg">
                  <LangBadge lang={sc.language} />
                  <span className="text-xs font-mono text-gray-300 truncate">{sc.filename}</span>
                </div>
              ))}
            </div>
          )}

          {/* Approve/reject actions */}
          {rejectId === s.id ? (
            <div className="space-y-2 pt-1">
              <input
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder={t('review.rejectPlaceholder')}
                className="w-full px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm
                  text-gray-100 placeholder-gray-600 focus:outline-none focus:border-red-500 transition-colors"
              />
              <div className="flex items-center gap-2">
                <button
                  onClick={() => rejectMutation.mutate({ id: s.id, reason: rejectReason })}
                  disabled={rejectMutation.isPending || !rejectReason.trim()}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600 hover:bg-red-500
                    disabled:opacity-50 text-white text-xs rounded-lg transition-colors"
                >
                  {rejectMutation.isPending ? <Loader2 size={12} className="animate-spin" /> : <XCircle size={12} />}
                  {t('review.reject')}
                </button>
                <button
                  onClick={() => { setRejectId(null); setRejectReason(''); }}
                  className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200 rounded-lg transition-colors"
                >
                  {t('common:actions.cancel')}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 pt-1">
              <button
                onClick={() => approveMutation.mutate(s.id)}
                disabled={approveMutation.isPending}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600
                  disabled:opacity-50 text-white text-xs rounded-lg transition-colors"
              >
                {approveMutation.isPending ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle size={12} />}
                {t('review.approve')}
              </button>
              <button
                onClick={() => setRejectId(s.id)}
                className="flex items-center gap-1.5 px-3 py-1.5 border border-red-900/50 hover:border-red-700
                  text-red-400 hover:text-red-300 text-xs rounded-lg transition-colors"
              >
                <XCircle size={12} /> {t('review.reject')}
              </button>
              <button
                onClick={() => onOpen(s)}
                className="ml-auto text-xs text-gray-500 hover:text-gray-300 transition-colors"
              >
                {t('review.details')}
              </button>
            </div>
          )}
        </div>
      ))}

    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── Tab 4: Daemon — background processes ───────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

// ── Daemon status badge ────────────────────────────────────────────────────────

function DaemonStatusBadge({ status }: { status: DaemonStatus }) {
  const { t } = useTranslation('skills');
  const cfg: Record<DaemonStatus, { label: string; className: string; icon: React.ReactNode }> = {
    starting: {
      label: t('daemon.statusStarting'),
      className: 'bg-blue-900/60 text-blue-300 border-blue-700/60',
      icon: <Loader2 size={11} className="animate-spin" />,
    },
    running: {
      label: t('daemon.statusRunning'),
      className: 'bg-emerald-900/60 text-emerald-300 border-emerald-700/60',
      icon: <span className="relative flex h-2 w-2"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" /><span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400" /></span>,
    },
    stopped: {
      label: t('daemon.statusStopped'),
      className: 'bg-gray-800 text-gray-400 border-gray-700',
      icon: <Square size={10} />,
    },
    error: {
      label: t('daemon.statusError'),
      className: 'bg-red-900/60 text-red-300 border-red-700/60',
      icon: <AlertCircle size={11} />,
    },
  };
  const { label, className, icon } = cfg[status];
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border text-xs font-medium ${className}`}>
      {icon}{label}
    </span>
  );
}

// ── Single daemon card ───────────────────────────────────────────────────────

function DaemonCard({ daemon }: { daemon: SkillDaemon }) {
  const { t } = useTranslation('skills');
  const qc = useQueryClient();
  const [confirmDel, setConfirmDel] = useState(false);

  const stopMut = useMutation({
    mutationFn: () => daemonsApi.stop(daemon.id),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['daemons'] }),
  });

  const restartMut = useMutation({
    mutationFn: () => daemonsApi.restart(daemon.id),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['daemons'] }),
  });

  const removeMut = useMutation({
    mutationFn: () => daemonsApi.remove(daemon.id),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['daemons'] }),
  });

  const isActive    = daemon.status === 'running' || daemon.status === 'starting';
  const canRemove   = daemon.status === 'stopped' || daemon.status === 'error';

  // Format uptime
  function uptime(startedAt: string | null): string {
    if (!startedAt) return '';
    const ms = Date.now() - new Date(startedAt).getTime();
    const s  = Math.floor(ms / 1000);
    if (s < 60)   return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  }

  return (
    <div className={`bg-gray-900 border rounded-xl p-4 space-y-3 transition-colors
      ${daemon.status === 'error'   ? 'border-red-800/50' :
        daemon.status === 'running' ? 'border-emerald-800/40' :
        'border-gray-800'}`}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-gray-100">
              {daemon.skill?.name ?? daemon.skillId.slice(0, 8)}
            </span>
            <DaemonStatusBadge status={daemon.status} />
          </div>
          <p className="text-xs text-gray-500 mt-0.5 font-mono truncate">
            {daemon.scriptFilename}
          </p>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 flex-shrink-0">
          {isActive ? (
            <button
              onClick={() => stopMut.mutate()}
              disabled={stopMut.isPending || restartMut.isPending}
              title={t('daemon.stopTitle')}
              className="p-1.5 text-gray-500 hover:text-red-400 rounded-lg transition-colors disabled:opacity-40"
            >
              {stopMut.isPending ? <Loader2 size={14} className="animate-spin" /> : <Square size={14} />}
            </button>
          ) : (
            <button
              onClick={() => restartMut.mutate()}
              disabled={restartMut.isPending}
              title={t('daemon.restartTitle')}
              className="p-1.5 text-gray-500 hover:text-blue-400 rounded-lg transition-colors disabled:opacity-40"
            >
              {restartMut.isPending ? <Loader2 size={14} className="animate-spin" /> : <RotateCw size={14} />}
            </button>
          )}

          {canRemove && !confirmDel && (
            <button
              onClick={() => setConfirmDel(true)}
              title={t('daemon.removeTitle')}
              className="p-1.5 text-gray-600 hover:text-red-400 rounded-lg transition-colors"
            >
              <Trash2 size={14} />
            </button>
          )}
          {confirmDel && (
            <div className="flex items-center gap-1">
              <button
                onClick={() => removeMut.mutate()}
                disabled={removeMut.isPending}
                className="px-2 py-0.5 text-xs bg-red-700 hover:bg-red-600 text-white rounded-md transition-colors"
              >
                {removeMut.isPending ? <Loader2 size={11} className="animate-spin inline" /> : t('daemon.delete')}
              </button>
              <button
                onClick={() => setConfirmDel(false)}
                className="px-2 py-0.5 text-xs text-gray-500 hover:text-gray-300 rounded-md transition-colors"
              >
                {t('daemon.no')}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Metadata */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
        {daemon.pid && (
          <span className="flex items-center gap-1">
            <Cpu size={11} /> PID {daemon.pid}
          </span>
        )}
        {daemon.status === 'running' && daemon.startedAt && (
          <span className="flex items-center gap-1 text-emerald-600">
            <Activity size={11} /> {uptime(daemon.startedAt)}
          </span>
        )}
        {daemon.lastEventAt && (
          <span className="flex items-center gap-1">
            <Zap size={11} /> {t('daemon.lastEvent')}{' '}
            {new Date(daemon.lastEventAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
          </span>
        )}
      </div>

      {/* Error */}
      {daemon.status === 'error' && daemon.lastError && (
        <div className="bg-red-950/40 border border-red-800/40 rounded-lg px-3 py-2">
          <p className="text-xs text-red-400 font-mono leading-relaxed">{daemon.lastError}</p>
        </div>
      )}
    </div>
  );
}

// ── New daemon start form ───────────────────────────────────────────────────

function StartDaemonForm({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('skills');
  const qc = useQueryClient();
  const [selectedSkillId, setSelectedSkillId] = useState('');
  const [selectedScript,  setSelectedScript]  = useState('');

  // Load only ready skills with at least one daemon script
  const { data: allSkills = [], isLoading } = useQuery({
    queryKey: ['skills'],
    queryFn:  skillsApi.list,
    staleTime: 30_000,
  });

  const skillsWithDaemons = allSkills.filter((s) =>
    s.status === 'ready' && s.scripts?.some((sc) => sc.mode === 'daemon'),
  );

  const selectedSkill    = skillsWithDaemons.find((s) => s.id === selectedSkillId);
  const daemonScripts    = selectedSkill?.scripts?.filter((sc) => sc.mode === 'daemon') ?? [];

  const startMut = useMutation({
    mutationFn: () => daemonsApi.start({ skillId: selectedSkillId, scriptFilename: selectedScript }),
    onSuccess:  () => {
      qc.invalidateQueries({ queryKey: ['daemons'] });
      onClose();
    },
  });

  return (
    <div className="bg-gray-900 border border-indigo-800/50 rounded-xl p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-100 flex items-center gap-2">
          <Play size={14} className="text-indigo-400" />
          {t('daemon.startTitle')}
        </h3>
        <button onClick={onClose} className="text-gray-600 hover:text-gray-300 transition-colors">
          <X size={15} />
        </button>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-gray-500 py-2">
          <Loader2 size={14} className="animate-spin" /> {t('daemon.loadingSkills')}
        </div>
      ) : skillsWithDaemons.length === 0 ? (
        <div className="text-sm text-gray-500 py-2">
          {t('daemon.noDaemonSkills')}{' '}
          <span className="text-gray-600">
            {t('daemon.noDaemonSkillsPre')} <code className="text-gray-500">mode: daemon</code> {t('daemon.noDaemonSkillsMid')} <code className="text-gray-500">SKILL.md</code>.
          </span>
        </div>
      ) : (
        <>
          {/* Skill selection */}
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1.5">Skill</label>
            <select
              value={selectedSkillId}
              onChange={(e) => { setSelectedSkillId(e.target.value); setSelectedScript(''); }}
              className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm
                text-gray-200 focus:outline-none focus:border-indigo-500 transition-colors"
            >
              <option value="">{t('daemon.selectSkill')}</option>
              {skillsWithDaemons.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>

          {/* Daemon script selection */}
          {selectedSkillId && (
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1.5">{t('daemon.daemonScript')}</label>
              {daemonScripts.length === 1 ? (
                // Auto-select if there is a single daemon script
                <div
                  className="px-3 py-2 bg-gray-800/60 border border-gray-700 rounded-lg text-sm text-gray-300 font-mono cursor-pointer"
                  onClick={() => setSelectedScript(daemonScripts[0].filename)}
                >
                  <span className={`mr-2 ${selectedScript ? 'text-indigo-400' : 'text-gray-600'}`}>
                    {selectedScript ? '✓' : '○'}
                  </span>
                  {daemonScripts[0].filename}
                  {!selectedScript && (
                    <button
                      onClick={() => setSelectedScript(daemonScripts[0].filename)}
                      className="ml-auto float-right text-xs text-indigo-400 hover:text-indigo-300"
                    >
                      {t('daemon.select')}
                    </button>
                  )}
                </div>
              ) : (
                <select
                  value={selectedScript}
                  onChange={(e) => setSelectedScript(e.target.value)}
                  className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm
                    text-gray-200 font-mono focus:outline-none focus:border-indigo-500 transition-colors"
                >
                  <option value="">{t('daemon.selectScript')}</option>
                  {daemonScripts.map((sc) => (
                    <option key={sc.id} value={sc.filename}>{sc.filename}</option>
                  ))}
                </select>
              )}
              {selectedScript && daemonScripts.find((s) => s.filename === selectedScript)?.description && (
                <p className="text-xs text-gray-500 mt-1.5 leading-relaxed">
                  {daemonScripts.find((s) => s.filename === selectedScript)?.description}
                </p>
              )}
            </div>
          )}

          {/* Error */}
          {startMut.isError && (
            <p className="text-xs text-red-400 flex items-center gap-1.5">
              <XCircle size={12} />
              {(startMut.error as any)?.response?.data?.message ?? t('daemon.startError')}
            </p>
          )}

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-sm text-gray-500 hover:text-gray-300 transition-colors"
            >
              {t('common:actions.cancel')}
            </button>
            <button
              onClick={() => startMut.mutate()}
              disabled={!selectedSkillId || !selectedScript || startMut.isPending}
              className="flex items-center gap-1.5 px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500
                disabled:opacity-50 text-white text-sm rounded-lg transition-colors"
            >
              {startMut.isPending
                ? <Loader2 size={13} className="animate-spin" />
                : <Play size={13} />}
              {t('daemon.start')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ── DaemonsTab ────────────────────────────────────────────────────────────────

function DaemonsTab() {
  const { t } = useTranslation('skills');
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);

  const { data: daemons = [], isLoading, isError } = useQuery({
    queryKey:    ['daemons'],
    queryFn:     daemonsApi.list,
    refetchInterval: 10_000,   // poll every 10s to refresh the status
    staleTime:   5_000,
  });

  const running = daemons.filter((d) => d.status === 'running');
  const stopped = daemons.filter((d) => d.status !== 'running');

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-gray-400 leading-relaxed">
            {t('daemon.intro')}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={() => qc.invalidateQueries({ queryKey: ['daemons'] })}
            className="p-1.5 text-gray-600 hover:text-gray-300 transition-colors"
            title={t('daemon.refreshListTitle')}
          >
            <RefreshCw size={14} />
          </button>
          <button
            onClick={() => setShowForm((v) => !v)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500
              text-white text-sm rounded-lg transition-colors"
          >
            <Play size={13} />
            {t('daemon.newDaemon')}
          </button>
        </div>
      </div>

      {/* Start form */}
      {showForm && <StartDaemonForm onClose={() => setShowForm(false)} />}

      {/* Loading */}
      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-gray-500 py-6 justify-center">
          <Loader2 size={16} className="animate-spin" /> {t('common:actions.loading')}
        </div>
      )}

      {/* Error */}
      {isError && (
        <div className="flex items-center gap-2 text-sm text-red-400 py-4">
          <WifiOff size={15} /> {t('daemon.loadError')}
        </div>
      )}

      {/* Empty list */}
      {!isLoading && !isError && daemons.length === 0 && !showForm && (
        <div className="text-center py-12 text-gray-600 space-y-2">
          <Activity size={28} className="mx-auto text-gray-700" />
          <p className="text-sm">{t('daemon.empty')}</p>
          <p className="text-xs text-gray-700">
            {t('daemon.emptyHint')}
          </p>
        </div>
      )}

      {/* Active daemons */}
      {running.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            {t('daemon.active', { count: running.length })}
          </p>
          {running.map((d) => <DaemonCard key={d.id} daemon={d} />)}
        </div>
      )}

      {/* Stopped / errored daemons */}
      {stopped.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
            {t('daemon.history', { count: stopped.length })}
          </p>
          {stopped.map((d) => <DaemonCard key={d.id} daemon={d} />)}
        </div>
      )}
    </div>
  );
}

// ── Active daemons badge (for tab bar) ────────────────────────────────────────

function DaemonRunningBadge() {
  const { data: daemons = [] } = useQuery({
    queryKey:        ['daemons'],
    queryFn:         daemonsApi.list,
    refetchInterval: 15_000,
    staleTime:       10_000,
  });
  const running = daemons.filter((d) => d.status === 'running').length;
  if (running === 0) return null;
  return (
    <span className="ml-0.5 inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px]
      bg-emerald-900/60 text-emerald-400 border border-emerald-800/60 rounded-full leading-none">
      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
      {running}
    </span>
  );
}

// ── "Shared" tab: shared+approved skills from other users ───────────────────

/**
 * Shows the shared+approved skills installed by other users.
 * Already accessible to the agent (via collectAccessibleSkills), here they are
 * made visible in the settings panel in read-only mode.
 *
 * Visibility rules (same as the agent):
 *   - No project assignment → global, always active
 *   - With assignments      → active only in the assigned projects
 */
function SharedSkillsTab({ userId, onOpen }: { userId: string; onOpen: (s: Skill) => void }) {
  const { t } = useTranslation('skills');

  const { data: allSkills = [], isLoading } = useQuery({
    queryKey:  ['skills'],
    queryFn:   skillsApi.list,
    staleTime: 30_000,
  });

  // Skills shared by other users (already filtered by findAll: shared+approved)
  const shared = allSkills.filter((s) => s.ownerId !== userId);

  return (
    <div className="space-y-4">
      {/* Contextual info */}
      <div className="px-4 py-3 bg-indigo-900/30 border border-indigo-700/50 rounded-xl text-xs text-indigo-300 leading-relaxed">
        <Globe size={12} className="inline mr-1.5 text-indigo-400" />
        {t('shared.info')}
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 text-gray-500 text-sm py-4">
          <Loader2 size={14} className="animate-spin" /> {t('common:actions.loading')}
        </div>
      )}

      {!isLoading && shared.length === 0 && (
        <div className="text-center py-12 text-gray-600">
          <Globe size={32} className="mx-auto mb-3 opacity-40" />
          <p className="text-sm">{t('shared.emptyTitle')}</p>
          <p className="text-xs mt-1 text-gray-700">
            {t('shared.emptyHint')}
          </p>
        </div>
      )}

      {shared.length > 0 && (
        <div className="space-y-2">
          {shared.map((s) => (
            <SharedSkillCard
              key={s.id}
              skill={s}
              onClick={() => onOpen(s)}
            />
          ))}
        </div>
      )}

    </div>
  );
}

/**
 * Read-only card for a shared skill.
 * Does not show the enable/disable toggle (that is the owner's control).
 * Shows a "Global" or "Contextual" badge based on the assignments.
 */
function SharedSkillCard({ skill, onClick }: { skill: Skill; onClick: () => void }) {
  const { t } = useTranslation('skills');
  // If the skill has project assignments → contextual, otherwise global
  // We don't have the assignments here (they would need loading), we use the script count as a proxy
  // and simply show the available info
  return (
    <button
      onClick={onClick}
      className="w-full text-left px-4 py-3.5 bg-gray-900 border border-gray-800
        hover:border-gray-700 hover:bg-gray-900/70 transition-all group rounded-xl"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-gray-100 group-hover:text-white truncate">
              {skill.name}
            </span>
            <span className="text-xs text-gray-600 font-mono">v{skill.version}</span>
            {skill.author && (
              <span className="text-xs text-gray-600">{t('marketplace.by', { author: skill.author })}</span>
            )}
          </div>
          {skill.description && (
            <p className="text-xs text-gray-500 mt-0.5 line-clamp-2 leading-relaxed">
              {skill.description}
            </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
          <StatusBadge status={skill.status} />
          {/* Visibility badge */}
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border
            border-indigo-800/40 bg-indigo-900/30 text-indigo-400 text-[10px]">
            <Globe size={9} /> {t('shared.badge')}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-3 mt-2 text-xs text-gray-600">
        {skill.scripts.length > 0 && (
          <span className="flex items-center gap-1">
            <Code2 size={11} /> {t('marketplace.scripts', { count: skill.scripts.length })}
          </span>
        )}
        {skill.pythonDeps.length > 0 && (
          <span className="flex items-center gap-1">
            <FileText size={11} /> {t('shared.pyDeps', { count: skill.pythonDeps.length })}
          </span>
        )}
      </div>
    </button>
  );
}

/** Counter badge for the "Shared" tab */
function SharedSkillsBadge({ userId }: { userId: string }) {
  const { data: skills = [] } = useQuery({
    queryKey:  ['skills'],
    queryFn:   skillsApi.list,
    staleTime: 30_000,
  });
  const count = skills.filter((s) => s.ownerId !== userId).length;
  if (count === 0) return null;
  return (
    <span className="ml-0.5 px-1.5 py-0.5 text-[10px] bg-indigo-900/60 text-indigo-300
      border border-indigo-800/60 rounded-full leading-none">
      {count}
    </span>
  );
}

// ── SkillsSection (main export) ────────────────────────────────────────

type Tab = 'mine' | 'shared' | 'public' | 'review' | 'daemons';

export function SkillsSection() {
  const { t } = useTranslation('skills');
  const user    = useStore((s) => s.user);
  const isAdmin = user?.role === 'admin';

  // `id` also serves as the i18n key: t(`tabs.${id}`)
  const tabs: { id: Tab; icon: React.ElementType; adminOnly?: boolean }[] = [
    { id: 'mine',    icon: Package },
    { id: 'shared',  icon: Globe },
    { id: 'public',  icon: Sparkles },
    { id: 'daemons', icon: Activity },
    { id: 'review',  icon: Shield, adminOnly: true },
  ];

  const visibleTabs = tabs.filter((tab) => !tab.adminOnly || isAdmin);
  const [activeTab, setActiveTab] = useState<Tab>('mine');
  // Selected skill is owned here (not per-tab) so the editor replaces the WHOLE
  // section — tab bar included — Flows-style, and "back" returns to the tabs.
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null);

  if (!user) return null;

  if (selectedSkill) {
    return (
      <SkillDrawer
        skill={selectedSkill}
        isOwn={selectedSkill.ownerId === user.id}
        onClose={() => setSelectedSkill(null)}
      />
    );
  }

  return (
    <div className="space-y-6">
      {/* Heading */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Sparkles size={18} className="text-indigo-400" />
          <h2 className="text-lg font-semibold text-gray-100">{t('title')}</h2>
        </div>
        <p className="text-sm text-gray-500">
          {t('subtitle')}
        </p>
      </div>

      {/* Tab bar — horizontally scrollable on mobile */}
      <div className="flex items-center gap-1 border-b border-gray-800 pb-0 overflow-x-auto">
        {visibleTabs.map(({ id, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap flex-shrink-0
              ${activeTab === id
                ? 'border-indigo-500 text-white'
                : 'border-transparent text-gray-500 hover:text-gray-300 hover:border-gray-600'}`}
          >
            <Icon size={14} />
            {t(`tabs.${id}`)}
            {id === 'shared'  && <SharedSkillsBadge userId={user.id} />}
            {id === 'review'  && isAdmin && <ReviewBadge />}
            {id === 'daemons' && <DaemonRunningBadge />}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div>
        {activeTab === 'mine'    && <MySkillsTab userId={user.id} onOpen={setSelectedSkill} />}
        {activeTab === 'shared'  && <SharedSkillsTab userId={user.id} onOpen={setSelectedSkill} />}
        {activeTab === 'public'  && <PublicSkillsTab userId={user.id} />}
        {activeTab === 'daemons' && <DaemonsTab />}
        {activeTab === 'review'  && isAdmin && <ReviewTab onOpen={setSelectedSkill} />}
      </div>
    </div>
  );
}

// Badge with pending review count
function ReviewBadge() {
  const { data: pending = [] } = useQuery({
    queryKey:      ['skills-pending-review'],
    queryFn:       skillsApi.pendingReview,
    staleTime:     30_000,
  });
  if (pending.length === 0) return null;
  return (
    <span className="ml-0.5 px-1.5 py-0.5 text-xs bg-amber-600 text-white rounded-full leading-none">
      {pending.length}
    </span>
  );
}
