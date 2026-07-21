import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { ScopeSelector, ScopeBadge, type ResourceScope } from '../components/ScopeSelector';
import {
  Bot, CheckCircle, XCircle, Loader2, Database, BrainCircuit,
  FolderOpen, Brain, Download, Trash2, Search, Wrench, Plug, UserCircle,
  Save, Eye, EyeOff, KeyRound, Cpu, Wifi, WifiOff, Boxes, Pencil, Plus,
  Star, Server, FileStack, X, Sparkles, Eraser, Zap, Filter, Package, ThumbsUp, BarChart3,
  Users, UsersRound, Workflow, Network, CalendarClock, Activity, ShieldAlert, Mic, Terminal, Check, DatabaseBackup,
} from 'lucide-react';
import type { LlmProvider, EmbeddingProvider, EmbeddingConfig, ToolLoadingConfig, ToolLoadingStrategy, ToolSchemaFormat, TranscriptionProvider, SandboxNetwork, SandboxExecMode } from '../api/appConfig';
import { filesApi, type FileRecord, type DocScope, type FileScope } from '../api/files';
import { profileApi } from '../api/profile';
import { appConfigApi } from '../api/appConfig';
import { userMemoryApi, type UserMemoryItem } from '../api/userMemory';
import { usageApi, type TokenGroup, type AdminUsageSummary } from '../api/usage';
import { llmConfigsApi, type LlmConfigDto } from '../api/llmConfigs';
import { vectorDbApi, type VectorCollection, type VectorDbProvider } from '../api/vectorDb';
import { teamsApi } from '../api/teams';
import { projectsApi } from '../api/projects';
import { useStore } from '../store/useStore';
import { ToolsSection } from './ToolsPage';
import { McpSection } from './McpServersPage';
import { DataSourcesSection } from './DataSourcesPage';
import { SkillsSection } from './SkillsPage';
import { FeedbackSection } from './FeedbackAdminPage';
import { UsersSection } from './UsersPage';
import { TeamsSection } from './TeamsPage';
import { FlowsSection } from './FlowsPage';
import { AgentsSection, AgentTeamsSection } from './AgentsPage';
import { AutomationsSection } from './AutomationsPage';
import { ActivitySection } from './ActivityPage';
import { AuditSection } from './AuditPage';
import { BackupSection } from './BackupPage';

// ── Settings sections ──────────────────────────────────────────────────────────
// `id` also acts as the i18n key: t(`settings:nav.${id}`)
const SECTIONS: { id: string; icon: React.ElementType; adminOnly?: boolean; disabled?: boolean }[] = [
  { id: 'profile',  icon: UserCircle },
  { id: 'memory',   icon: BrainCircuit },
  { id: 'ai',       icon: Bot },
  { id: 'tools',    icon: Wrench },
  { id: 'mcp',      icon: Plug },
  { id: 'skills',   icon: Sparkles },
  { id: 'flows',    icon: Workflow },
  { id: 'agents',   icon: Bot },
  { id: 'agentteams', icon: Network },
  { id: 'automations', icon: CalendarClock },
  { id: 'activity', icon: Activity },
  { id: 'files',    icon: FolderOpen },
  { id: 'database', icon: Database },
  { id: 'usage',    icon: BarChart3 },
  { id: 'vectordb', icon: Boxes, adminOnly: true },
  { id: 'feedback', icon: ThumbsUp, adminOnly: true },
  { id: 'users',    icon: Users, adminOnly: true },
  { id: 'teams',    icon: UsersRound, adminOnly: true },
  { id: 'audit',    icon: ShieldAlert, adminOnly: true },
  { id: 'backup',   icon: DatabaseBackup, adminOnly: true },
];

type SectionId = 'profile' | 'memory' | 'ai' | 'tools' | 'mcp' | 'skills' | 'flows' | 'agents' | 'agentteams' | 'automations' | 'activity' | 'files' | 'database' | 'usage' | 'vectordb' | 'feedback' | 'users' | 'teams' | 'audit' | 'backup';

// ── Main page ─────────────────────────────────────────────────────────────────
export default function SettingsPage() {
  const { t } = useTranslation('settings');
  const [activeSection, setActiveSection] = useState<SectionId>('profile');
  const user = useStore((s) => s.user);
  const isAdmin = user?.role === 'admin';

  // Filter the visible sections based on the role
  const visibleSections = SECTIONS.filter((s) => !s.adminOnly || isAdmin);

  return (
    <div className="flex flex-col md:flex-row h-full min-w-0 bg-gray-950">
      {/* Settings nav — horizontal scrollable bar on mobile, sidebar from md up */}
      <nav className="flex-shrink-0 md:w-52 border-b md:border-b-0 md:border-r border-gray-800
        px-2 md:px-3 py-2 md:py-6 overflow-x-auto">
        <p className="hidden md:block text-xs font-semibold text-gray-500 uppercase tracking-wider px-3 mb-3">{t('title')}</p>
        <ul className="flex md:flex-col gap-1 md:gap-0.5">
          {visibleSections.map(({ id, icon: Icon, disabled }) => (
            <li key={id} className="flex-shrink-0">
              <button
                disabled={disabled}
                onClick={() => setActiveSection(id as SectionId)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm whitespace-nowrap transition-colors
                  ${disabled ? 'text-gray-600 cursor-not-allowed' : ''}
                  ${!disabled && activeSection === id ? 'bg-gray-800 text-white' : ''}
                  ${!disabled && activeSection !== id ? 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/60' : ''}`}
              >
                <Icon size={15} className="flex-shrink-0" />
                {t(`nav.${id}`)}
                {disabled && <span className="ml-auto text-xs text-gray-600">{t('soon')}</span>}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      {/* Content — unified container. Flows uses the FULL width (canvas),
          the other sections stay centered at max-w-4xl. */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden min-w-0 min-h-0">
        <div className={activeSection === 'flows' ? 'h-full px-4 py-5' : 'max-w-4xl mx-auto px-4 sm:px-8 py-6 sm:py-8'}>
        {activeSection === 'profile'  && <ProfileSection />}
        {activeSection === 'memory'   && <MemorySection />}
        {activeSection === 'ai'       && <AiSection />}
        {activeSection === 'tools'    && <ToolsSection />}
        {activeSection === 'mcp'      && <McpSection />}
        {activeSection === 'skills'   && <SkillsSection />}
        {activeSection === 'flows'    && <FlowsSection />}
        {activeSection === 'agents'   && <AgentsSection />}
        {activeSection === 'agentteams' && <AgentTeamsSection />}
        {activeSection === 'automations' && <AutomationsSection />}
        {activeSection === 'activity' && <ActivitySection />}
        {activeSection === 'files'    && <FilesSection />}
        {activeSection === 'database' && <DataSourcesSection />}
        {activeSection === 'usage'    && <UsageSection isAdmin={isAdmin} />}
        {activeSection === 'vectordb' && isAdmin && <VectorDbSection />}
        {activeSection === 'feedback' && isAdmin && <FeedbackSection />}
        {activeSection === 'users'    && isAdmin && <UsersSection />}
        {activeSection === 'teams'    && isAdmin && <TeamsSection />}
        {activeSection === 'audit'    && isAdmin && <AuditSection />}
        {activeSection === 'backup'   && isAdmin && <BackupSection />}
        </div>
      </div>
    </div>
  );
}

// ── Profile section ───────────────────────────────────────────────────────────
function ProfileSection() {
  const { t } = useTranslation('settings');
  const { user, setAuth, token } = useStore();
  const qc = useQueryClient();

  // ── Profile data ─────────────────────────────────────────────────────────────
  const [name, setName]   = useState(user?.name  ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [profileMsg, setProfileMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // ── Custom instructions ────────────────────────────────────────────────
  const profileQuery = useQuery({
    queryKey: ['profile'],
    queryFn: profileApi.get,
    staleTime: 60_000,
  });
  const [systemPrompt, setSystemPrompt] = useState<string>('');
  const [promptMsg, setPromptMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Initialize when the response arrives
  useEffect(() => {
    if (profileQuery.data?.systemPrompt != null) {
      setSystemPrompt(profileQuery.data.systemPrompt ?? '');
    }
  }, [profileQuery.data?.systemPrompt]);

  const promptMutation = useMutation({
    mutationFn: () => profileApi.update({ systemPrompt: systemPrompt.trim() || null }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['profile'] });
      setPromptMsg({ ok: true, text: t('profile.instructionsSaved') });
      setTimeout(() => setPromptMsg(null), 3000);
    },
    onError: (e: any) => {
      setPromptMsg({ ok: false, text: e?.response?.data?.message ?? e.message });
    },
  });

  // ── Token count preference ───────────────────────────────────────────────────
  const [showTokenCount, setShowTokenCount] = useState<boolean>(false);
  const [tokenMsg, setTokenMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (profileQuery.data) {
      setShowTokenCount(profileQuery.data.showTokenCount ?? false);
    }
  }, [profileQuery.data?.showTokenCount]);

  const tokenMutation = useMutation({
    mutationFn: (val: boolean) => profileApi.update({ showTokenCount: val }),
    onSuccess: (updated) => {
      if (token) setAuth(token, { ...updated, role: updated.role });
      qc.invalidateQueries({ queryKey: ['profile'] });
      setTokenMsg({ ok: true, text: t('profile.preferenceSaved') });
      setTimeout(() => setTokenMsg(null), 2500);
    },
    onError: (e: any) => {
      setTokenMsg({ ok: false, text: e?.response?.data?.message ?? e.message });
    },
  });

  const profileMutation = useMutation({
    mutationFn: () => profileApi.update({ name: name.trim(), email: email.trim() }),
    onSuccess: (updated) => {
      // Update the store with the new user data
      if (token) setAuth(token, { ...updated, role: updated.role });
      setProfileMsg({ ok: true, text: t('profile.profileUpdated') });
      setTimeout(() => setProfileMsg(null), 3000);
    },
    onError: (e: any) => {
      setProfileMsg({ ok: false, text: e?.response?.data?.message ?? e.message });
    },
  });

  // ── Password change ──────────────────────────────────────────────────────────
  const [currentPwd, setCurrentPwd]   = useState('');
  const [newPwd, setNewPwd]           = useState('');
  const [confirmPwd, setConfirmPwd]   = useState('');
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew]         = useState(false);
  const [pwdMsg, setPwdMsg]           = useState<{ ok: boolean; text: string } | null>(null);

  const pwdMutation = useMutation({
    mutationFn: () => profileApi.changePassword(currentPwd, newPwd),
    onSuccess: () => {
      setCurrentPwd(''); setNewPwd(''); setConfirmPwd('');
      setPwdMsg({ ok: true, text: t('profile.passwordUpdated') });
      setTimeout(() => setPwdMsg(null), 3000);
    },
    onError: (e: any) => {
      setPwdMsg({ ok: false, text: e?.response?.data?.message ?? e.message });
    },
  });

  const handlePasswordSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (newPwd !== confirmPwd) {
      setPwdMsg({ ok: false, text: t('profile.pwdMismatch') });
      return;
    }
    if (newPwd.length < 8) {
      setPwdMsg({ ok: false, text: t('profile.pwdTooShort') });
      return;
    }
    setPwdMsg(null);
    pwdMutation.mutate();
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-white">{t('profile.title')}</h2>
        <p className="text-sm text-gray-500 mt-1">{t('profile.subtitle')}</p>
      </div>

      {/* ── Personal data card ─────────────────────────────────────────────── */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-gray-100">{t('profile.personalData')}</h3>
          <p className="text-sm text-gray-500 mt-1">{t('profile.personalDataHint')}</p>
        </div>

        <form
          onSubmit={(e) => { e.preventDefault(); profileMutation.mutate(); }}
          className="space-y-3"
        >
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">{t('profile.name')}</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('profile.namePlaceholder')}
              className="w-full px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm
                text-gray-100 placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">{t('profile.email')}</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t('profile.emailPlaceholder')}
              className="w-full px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm
                text-gray-100 placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors"
            />
          </div>

          <div className="flex items-center justify-between pt-1">
            {profileMsg && (
              <span className={`text-xs flex items-center gap-1.5 ${profileMsg.ok ? 'text-emerald-400' : 'text-red-400'}`}>
                {profileMsg.ok ? <CheckCircle size={13} /> : <XCircle size={13} />}
                {profileMsg.text}
              </span>
            )}
            <div className="ml-auto">
              <button
                type="submit"
                disabled={profileMutation.isPending}
                className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 hover:bg-blue-500
                  disabled:opacity-50 text-white text-sm rounded-lg transition-colors"
              >
                {profileMutation.isPending
                  ? <Loader2 size={13} className="animate-spin" />
                  : <Save size={13} />}
                {t('common:actions.save')}
              </button>
            </div>
          </div>
        </form>
      </div>

      {/* ── Language card ──────────────────────────────────────────────────────── */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-100">{t('common:language.label')}</h3>
          <p className="text-sm text-gray-500 mt-1">{t('common:language.hint')}</p>
        </div>
        <LanguageSwitcher />
      </div>

      {/* ── Password change card ─────────────────────────────────────────────── */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-gray-100 flex items-center gap-2">
            <KeyRound size={14} className="text-gray-400" />
            {t('profile.changePassword')}
          </h3>
          <p className="text-sm text-gray-500 mt-1">{t('profile.passwordHint')}</p>
        </div>

        <form onSubmit={handlePasswordSubmit} className="space-y-3">
          {/* Current password */}
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">{t('profile.currentPwd')}</label>
            <div className="relative">
              <input
                type={showCurrent ? 'text' : 'password'}
                value={currentPwd}
                onChange={(e) => setCurrentPwd(e.target.value)}
                className="w-full px-3 py-1.5 pr-9 bg-gray-800 border border-gray-700 rounded-lg text-sm
                  text-gray-100 placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors"
              />
              <button
                type="button"
                onClick={() => setShowCurrent((p) => !p)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
              >
                {showCurrent ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>

          {/* New password */}
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">{t('profile.newPwd')}</label>
            <div className="relative">
              <input
                type={showNew ? 'text' : 'password'}
                value={newPwd}
                onChange={(e) => setNewPwd(e.target.value)}
                className="w-full px-3 py-1.5 pr-9 bg-gray-800 border border-gray-700 rounded-lg text-sm
                  text-gray-100 placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors"
              />
              <button
                type="button"
                onClick={() => setShowNew((p) => !p)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
              >
                {showNew ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>

          {/* Confirmation */}
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">{t('profile.confirmPwd')}</label>
            <input
              type="password"
              value={confirmPwd}
              onChange={(e) => setConfirmPwd(e.target.value)}
              className="w-full px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm
                text-gray-100 placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors"
            />
          </div>

          <div className="flex items-center justify-between pt-1">
            {pwdMsg && (
              <span className={`text-xs flex items-center gap-1.5 ${pwdMsg.ok ? 'text-emerald-400' : 'text-red-400'}`}>
                {pwdMsg.ok ? <CheckCircle size={13} /> : <XCircle size={13} />}
                {pwdMsg.text}
              </span>
            )}
            <div className="ml-auto">
              <button
                type="submit"
                disabled={pwdMutation.isPending || !currentPwd || !newPwd || !confirmPwd}
                className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 hover:bg-blue-500
                  disabled:opacity-50 text-white text-sm rounded-lg transition-colors"
              >
                {pwdMutation.isPending
                  ? <Loader2 size={13} className="animate-spin" />
                  : <KeyRound size={13} />}
                {t('profile.updatePwd')}
              </button>
            </div>
          </div>
        </form>
      </div>

      {/* ── Custom instructions card ──────────────────────────────────── */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-gray-100 flex items-center gap-2">
            <Bot size={14} className="text-gray-400" />
            {t('profile.customInstructions')}
          </h3>
          <p className="text-sm text-gray-500 mt-1">
            {t('profile.customInstructionsHint')}
          </p>
        </div>

        <div>
          <textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            rows={6}
            placeholder={t('profile.systemPromptPlaceholder')}
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm
              text-gray-100 placeholder-gray-600 focus:outline-none focus:border-blue-500
              transition-colors resize-none font-mono leading-relaxed"
          />
          {profileQuery.isLoading && (
            <p className="text-xs text-gray-600 mt-1 flex items-center gap-1.5">
              <Loader2 size={11} className="animate-spin" /> {t('common:actions.loading')}
            </p>
          )}
        </div>

        <div className="flex items-center justify-between">
          {promptMsg && (
            <span className={`text-xs flex items-center gap-1.5 ${promptMsg.ok ? 'text-emerald-400' : 'text-red-400'}`}>
              {promptMsg.ok ? <CheckCircle size={13} /> : <XCircle size={13} />}
              {promptMsg.text}
            </span>
          )}
          <div className="ml-auto">
            <button
              onClick={() => promptMutation.mutate()}
              disabled={promptMutation.isPending || profileQuery.isLoading}
              className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 hover:bg-blue-500
                disabled:opacity-50 text-white text-sm rounded-lg transition-colors"
            >
              {promptMutation.isPending
                ? <Loader2 size={13} className="animate-spin" />
                : <Save size={13} />}
              {t('common:actions.save')}
            </button>
          </div>
        </div>
      </div>

      {/* ── Interface preferences ──────────────────────────────────────────── */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-gray-100 flex items-center gap-2">
            <Zap size={14} className="text-gray-400" />
            {t('profile.uiPrefs')}
          </h3>
          <p className="text-sm text-gray-500 mt-1">
            {t('profile.uiPrefsHint')}
          </p>
        </div>

        {/* Toggle showTokenCount */}
        <div className="flex items-center justify-between py-2 border-t border-gray-800">
          <div>
            <p className="text-sm text-gray-200">{t('profile.tokenCount')}</p>
            <p className="text-xs text-gray-500 mt-0.5">
              {t('profile.tokenCountHint')}
            </p>
          </div>
          <button
            role="switch"
            aria-checked={showTokenCount}
            disabled={tokenMutation.isPending || profileQuery.isLoading}
            onClick={() => {
              const next = !showTokenCount;
              setShowTokenCount(next);
              tokenMutation.mutate(next);
            }}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors
              disabled:opacity-50 focus:outline-none
              ${showTokenCount ? 'bg-blue-600' : 'bg-gray-700'}`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform
                ${showTokenCount ? 'translate-x-6' : 'translate-x-1'}`}
            />
          </button>
        </div>

        {tokenMsg && (
          <span className={`text-xs flex items-center gap-1.5 ${tokenMsg.ok ? 'text-emerald-400' : 'text-red-400'}`}>
            {tokenMsg.ok ? <CheckCircle size={13} /> : <XCircle size={13} />}
            {tokenMsg.text}
          </span>
        )}
      </div>

      {/* ── Tool optimization ──────────────────────────────────────────────── */}
      <ToolLoadingUserCard />

      {/* ── Account info ─────────────────────────────────────────────────────── */}
      {user && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-gray-100 mb-3">{t('profile.accountInfo')}</h3>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between text-gray-400">
              <span>{t('profile.userId')}</span>
              <span className="font-mono text-xs text-gray-500">{user.id}</span>
            </div>
            <div className="flex justify-between text-gray-400">
              <span>{t('profile.role')}</span>
              <span className="capitalize text-gray-300">{user.role}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// A-MEM note metadata (F1): category + tags chips, context in muted text.
function NoteMeta({ f }: { f: UserMemoryItem }) {
  const { t } = useTranslation('settings');
  if (!f.category && !(f.tags?.length) && !f.context && !(f.mergeOfIds?.length) && (f.scope ?? 'personal') === 'personal') return null;
  return (
    <div className="flex flex-wrap items-center gap-1 mt-0.5">
      {f.scope && f.scope !== 'personal' && <ScopeBadge scope={f.scope} />}
      {(f.mergeOfIds?.length ?? 0) > 0 && (
        <span className="px-1.5 py-px rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-300 text-[10px]">
          {t('memory.mergeProposal')}
        </span>
      )}
      {f.category && (
        <span className="px-1.5 py-px rounded-full bg-indigo-500/15 text-indigo-300 text-[10px]">{f.category}</span>
      )}
      {(f.tags ?? []).filter((tg) => tg !== f.category).map((tg) => (
        <span key={tg} className="px-1.5 py-px rounded-full bg-gray-800 border border-gray-700 text-gray-400 text-[10px]">{tg}</span>
      ))}
      {f.context && <span className="basis-full text-[11px] text-gray-600 leading-snug">{f.context}</span>}
    </div>
  );
}

// ── Note graph (A-MEM F5): nodes = notes, edges = linkedIds ────────────────
const CATEGORY_COLORS: Record<string, string> = {
  preference: '#818cf8', // indigo-400
  profile:    '#34d399', // emerald-400
  constraint: '#fbbf24', // amber-400
  knowledge:  '#60a5fa', // blue-400
};
const NODE_DEFAULT_COLOR = '#9ca3af'; // gray-400

function NoteGraph({ notes }: { notes: UserMemoryItem[] }) {
  const { t } = useTranslation('settings');
  const [hovered, setHovered] = useState<string | null>(null);

  // Deterministic circular layout (no physics): stable across renders, and the
  // edges from linkedIds are what carry the structure, not the positions.
  const size = 320;
  const cx = size / 2, cy = size / 2, r = size / 2 - 34;
  const ids = new Set(notes.map((n) => n.id));
  const layout = notes.map((n, i) => {
    const angle = (2 * Math.PI * i) / Math.max(notes.length, 1) - Math.PI / 2;
    return { note: n, x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
  });
  const pos = new Map(layout.map((l) => [l.note.id, l]));

  // Undirected edge set (dedup a↔b), only between notes present in this view.
  const edgeSet = new Set<string>();
  const edges: Array<{ a: string; b: string }> = [];
  for (const n of notes) {
    for (const other of n.linkedIds ?? []) {
      if (!ids.has(other)) continue;
      const key = [n.id, other].sort().join('|');
      if (edgeSet.has(key)) continue;
      edgeSet.add(key);
      edges.push({ a: n.id, b: other });
    }
  }

  if (!notes.length) return <p className="text-xs text-gray-600">{t('memory.noFacts')}</p>;

  const neighbours = (id: string): Set<string> => {
    const s = new Set<string>([id]);
    for (const e of edges) {
      if (e.a === id) s.add(e.b);
      if (e.b === id) s.add(e.a);
    }
    return s;
  };
  const active = hovered ? neighbours(hovered) : null;
  const hoveredNote = hovered ? pos.get(hovered)?.note : null;

  return (
    <div className="space-y-2">
      <svg viewBox={`0 0 ${size} ${size}`} className="w-full max-w-[340px] mx-auto select-none">
        {edges.map((e, i) => {
          const a = pos.get(e.a)!, b = pos.get(e.b)!;
          const dim = active && !(active.has(e.a) && active.has(e.b));
          return (
            <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
              stroke={dim ? '#374151' : '#4b5563'} strokeWidth={dim ? 0.5 : 1}
              opacity={dim ? 0.3 : 0.8} />
          );
        })}
        {layout.map(({ note, x, y }) => {
          const dim = active && !active.has(note.id);
          const color = CATEGORY_COLORS[note.category ?? ''] ?? NODE_DEFAULT_COLOR;
          return (
            <g key={note.id} opacity={dim ? 0.3 : 1}
              onMouseEnter={() => setHovered(note.id)} onMouseLeave={() => setHovered(null)}
              className="cursor-pointer">
              <circle cx={x} cy={y} r={note.pinned ? 8 : 6}
                fill={color} stroke={note.pinned ? '#fbbf24' : '#111827'}
                strokeWidth={note.pinned ? 2 : 1.5} />
            </g>
          );
        })}
      </svg>
      {hoveredNote ? (
        <div className="text-[11px] text-gray-300 bg-gray-800/60 border border-gray-700 rounded-lg px-2.5 py-1.5 leading-snug">
          {hoveredNote.content}
          {hoveredNote.category && <span className="text-gray-500"> · {hoveredNote.category}</span>}
        </div>
      ) : (
        <p className="text-[11px] text-gray-600 text-center">{t('memory.graphHint')}</p>
      )}
    </div>
  );
}

// ── Memory section (dedicated tab) ─────────────────────────────────────────
// The persistent-memory card is large (notes list + graph), so it gets its own
// settings section instead of living inside Profile.
function MemorySection() {
  const profileQuery = useQuery({ queryKey: ['profile'], queryFn: profileApi.get, staleTime: 60_000 });
  return (
    <div className="space-y-6">
      <UserMemoryCard
        autoMemoryEnabled={profileQuery.data?.autoMemoryEnabled ?? false}
        memoryThreshold={profileQuery.data?.memoryThreshold ?? null}
        loading={profileQuery.isLoading}
      />
    </div>
  );
}

// ── Persistent user memory card ────────────────────────────────────────────
function UserMemoryCard({
  autoMemoryEnabled, memoryThreshold, loading,
}: {
  autoMemoryEnabled: boolean;
  memoryThreshold: number | null;
  loading: boolean;
}) {
  const { t } = useTranslation('settings');
  const qc = useQueryClient();
  const [enabled, setEnabled]     = useState(autoMemoryEnabled);
  const [threshold, setThreshold] = useState<string>(memoryThreshold != null ? String(memoryThreshold) : '');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText]   = useState('');
  const [editScope, setEditScope] = useState<ResourceScope>('personal');
  const [editTeamId, setEditTeamId] = useState<string | null>(null);
  const [graphView, setGraphView] = useState(false);
  const isAdminUser = useStore((s) => s.user?.role === 'admin');

  useEffect(() => { setEnabled(autoMemoryEnabled); }, [autoMemoryEnabled]);
  useEffect(() => { setThreshold(memoryThreshold != null ? String(memoryThreshold) : ''); }, [memoryThreshold]);

  // List of stored facts (only if memory is enabled)
  const memoryQuery = useQuery({
    queryKey: ['user-memory'],
    queryFn: userMemoryApi.list,
    enabled,
  });

  const toggleMutation = useMutation({
    mutationFn: (val: boolean) => profileApi.update({ autoMemoryEnabled: val }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['profile'] });
      qc.invalidateQueries({ queryKey: ['user-memory'] });
    },
  });

  const thresholdMutation = useMutation({
    mutationFn: (val: number | null) => profileApi.update({ memoryThreshold: val }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['profile'] }),
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => userMemoryApi.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['user-memory'] }),
  });

  const confirmMutation = useMutation({
    mutationFn: (id: string) => userMemoryApi.confirm([id]),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['user-memory'] }),
  });

  const pinMutation = useMutation({
    mutationFn: ({ id, pinned }: { id: string; pinned: boolean }) => userMemoryApi.setPinned(id, pinned),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['user-memory'] }),
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, content, scope, teamId }: { id: string; content: string; scope: ResourceScope; teamId: string | null }) => {
      await userMemoryApi.update(id, content);
      await userMemoryApi.setScope(id, scope, teamId);
    },
    onSuccess: () => {
      setEditingId(null);
      qc.invalidateQueries({ queryKey: ['user-memory'] });
    },
  });

  const facts: UserMemoryItem[] = memoryQuery.data ?? [];
  const confirmed = facts.filter((f) => f.status === 'confirmed');
  const pending   = facts.filter((f) => f.status === 'pending');

  const saveThreshold = () => {
    const trimmed = threshold.trim();
    if (trimmed === '') { thresholdMutation.mutate(null); return; }
    const n = Number(trimmed);
    if (Number.isFinite(n) && n >= 1 && n <= 100) thresholdMutation.mutate(n);
  };

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-gray-100 flex items-center gap-2">
          <BrainCircuit size={14} className="text-gray-400" />
          {t('memory.title')}
        </h3>
        <p className="text-sm text-gray-500 mt-1">
          {t('memory.intro')}
        </p>
      </div>

      {/* Enable toggle */}
      <div className="flex items-center justify-between py-2 border-t border-gray-800">
        <div>
          <p className="text-sm text-gray-200">{t('memory.autoMemory')}</p>
          <p className="text-xs text-gray-500 mt-0.5">
            {t('memory.autoMemoryHint')}
          </p>
        </div>
        <button
          role="switch"
          aria-checked={enabled}
          disabled={toggleMutation.isPending || loading}
          onClick={() => { const next = !enabled; setEnabled(next); toggleMutation.mutate(next); }}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors
            disabled:opacity-50 focus:outline-none ${enabled ? 'bg-blue-600' : 'bg-gray-700'}`}
        >
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform
            ${enabled ? 'translate-x-6' : 'translate-x-1'}`} />
        </button>
      </div>

      {enabled && (
        <>
          {/* Per-user threshold (override of the global default) */}
          <div className="flex items-center justify-between py-2 border-t border-gray-800">
            <div className="pr-4">
              <p className="text-sm text-gray-200">{t('memory.threshold')}</p>
              <p className="text-xs text-gray-500 mt-0.5">
                {t('memory.thresholdHint')}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="number" min={1} max={100}
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
                onBlur={saveThreshold}
                placeholder="auto"
                className="w-20 px-2 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-100
                  placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors text-center"
              />
            </div>
          </div>

          {/* Pending items awaiting confirmation */}
          {pending.length > 0 && (
            <div className="border-t border-gray-800 pt-3 space-y-1.5">
              <p className="text-xs font-medium text-indigo-300">{t('memory.pendingConfirm')}</p>
              {pending.map((f) => (
                <div key={f.id} className="flex items-start gap-2 text-sm text-gray-300">
                  <div className="flex-1 leading-snug">
                    {f.content}
                    <NoteMeta f={f} />
                  </div>
                  <button onClick={() => confirmMutation.mutate(f.id)} disabled={confirmMutation.isPending}
                    className="p-1 rounded text-emerald-400 hover:bg-emerald-500/15" title={t('memory.confirm')}>
                    <CheckCircle size={14} />
                  </button>
                  <button onClick={() => removeMutation.mutate(f.id)} disabled={removeMutation.isPending}
                    className="p-1 rounded text-gray-400 hover:bg-red-500/15 hover:text-red-400" title={t('memory.reject')}>
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Confirmed facts */}
          <div className="border-t border-gray-800 pt-3 space-y-1.5">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-gray-400">
                {t('memory.storedFacts')} {confirmed.length > 0 && <span className="text-gray-600">({confirmed.length})</span>}
              </p>
              {confirmed.length > 0 && (
                <button
                  onClick={() => setGraphView((v) => !v)}
                  className={`flex items-center gap-1 px-2 py-0.5 rounded text-[11px] transition-colors ${graphView
                    ? 'text-blue-300 bg-blue-500/15'
                    : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800'}`}
                  title={graphView ? t('memory.listView') : t('memory.graphView')}>
                  <Network size={12} /> {graphView ? t('memory.listView') : t('memory.graphView')}
                </button>
              )}
            </div>
            {memoryQuery.isLoading && (
              <p className="text-xs text-gray-600 flex items-center gap-1.5">
                <Loader2 size={11} className="animate-spin" /> {t('common:actions.loading')}
              </p>
            )}
            {!memoryQuery.isLoading && confirmed.length === 0 && (
              <p className="text-xs text-gray-600">{t('memory.noFacts')}</p>
            )}
            {graphView && confirmed.length > 0 && <NoteGraph notes={confirmed} />}
            {!graphView && confirmed.map((f) => (
              <div key={f.id} className="flex items-start gap-2 text-sm text-gray-300 group">
                {editingId === f.id ? (
                  <>
                    <div className="flex-1 space-y-2">
                      <input
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        className="w-full px-2 py-1 bg-gray-800 border border-gray-700 rounded text-sm text-gray-100
                          focus:outline-none focus:border-blue-500"
                        autoFocus
                      />
                      {/* Visibility (F4): owner shares with a team; org is admin-only. */}
                      <ScopeSelector
                        scope={editScope}
                        teamId={editTeamId}
                        onScope={setEditScope}
                        onTeam={setEditTeamId}
                        allowOrg={isAdminUser}
                      />
                    </div>
                    <button onClick={() => updateMutation.mutate({ id: f.id, content: editText, scope: editScope, teamId: editTeamId })}
                      disabled={updateMutation.isPending}
                      className="p-1 rounded text-emerald-400 hover:bg-emerald-500/15" title={t('common:actions.save')}>
                      <Save size={14} />
                    </button>
                    <button onClick={() => setEditingId(null)}
                      className="p-1 rounded text-gray-400 hover:bg-gray-700" title={t('common:actions.cancel')}>
                      <X size={14} />
                    </button>
                  </>
                ) : (
                  <>
                    <div className="flex-1 leading-snug">
                      {f.content}
                      <NoteMeta f={f} />
                    </div>
                    <button onClick={() => pinMutation.mutate({ id: f.id, pinned: !f.pinned })}
                      disabled={pinMutation.isPending}
                      className={`p-1 rounded ${f.pinned
                        ? 'text-amber-400 hover:bg-amber-500/15'
                        : 'text-gray-500 hover:bg-gray-700 hover:text-gray-300 opacity-0 group-hover:opacity-100'}`}
                      title={f.pinned ? t('memory.unpin') : t('memory.pin')}>
                      <Star size={13} fill={f.pinned ? 'currentColor' : 'none'} />
                    </button>
                    <button onClick={() => { setEditingId(f.id); setEditText(f.content); setEditScope(f.scope ?? 'personal'); setEditTeamId(f.teamId ?? null); }}
                      className="p-1 rounded text-gray-500 hover:bg-gray-700 hover:text-gray-300 opacity-0 group-hover:opacity-100"
                      title={t('common:actions.edit')}>
                      <Pencil size={13} />
                    </button>
                    <button onClick={() => removeMutation.mutate(f.id)} disabled={removeMutation.isPending}
                      className="p-1 rounded text-gray-500 hover:bg-red-500/15 hover:text-red-400 opacity-0 group-hover:opacity-100"
                      title={t('common:actions.delete')}>
                      <Trash2 size={13} />
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── Usage section (token usage dashboard) ───────────────────────────────────
const RANGE_PRESETS: { key: string; days: number | null }[] = [
  { key: 'range7',   days: 7 },
  { key: 'range30',  days: 30 },
  { key: 'range90',  days: 90 },
  { key: 'rangeAll', days: null },
];

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
function fmtCost(n: number | undefined): string {
  if (n == null) return '—';
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}

function UsageSection({ isAdmin }: { isAdmin: boolean }) {
  const { t } = useTranslation('settings');
  const [days, setDays] = useState<number | null>(30);

  const range = (() => {
    if (days == null) return {};
    const from = new Date();
    from.setDate(from.getDate() - days);
    return { from: from.toISOString() };
  })();

  const query = useQuery({
    queryKey: ['usage', isAdmin ? 'admin' : 'me', days],
    queryFn: () => (isAdmin ? usageApi.all(range) : usageApi.me(range)),
  });

  const data = query.data;
  const totals = data?.totals;
  const admin = isAdmin ? (data as AdminUsageSummary | undefined) : undefined;
  const showCost = isAdmin;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-white">{t('usage.title')}</h2>
          <p className="text-sm text-gray-500 mt-1">
            {isAdmin ? t('usage.subtitleAdmin') : t('usage.subtitleUser')}
          </p>
        </div>
        <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-lg p-1 overflow-x-auto flex-shrink-0 self-start">
          {RANGE_PRESETS.map((p) => (
            <button
              key={p.key}
              onClick={() => setDays(p.days)}
              className={`px-2.5 py-1 text-xs rounded-md transition-colors
                ${days === p.days ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-gray-200'}`}
            >
              {t(`usage.${p.key}`)}
            </button>
          ))}
        </div>
      </div>

      {query.isLoading && (
        <div className="flex items-center gap-2 text-gray-500 text-sm">
          <Loader2 size={14} className="animate-spin" /> {t('usage.loading')}
        </div>
      )}

      {!query.isLoading && totals && (
        <>
          {/* Totals */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard label={t('usage.statInputTokens')}  value={fmtTokens(totals.inputTokens)} />
            <StatCard label={t('usage.statOutputTokens')} value={fmtTokens(totals.outputTokens)} />
            <StatCard label={t('usage.statTotalTokens')} value={fmtTokens(totals.totalTokens)} sub={t('usage.statMessages', { count: totals.messages })} />
            {showCost
              ? <StatCard label={t('usage.statEstimatedCost')} value={fmtCost(totals.cost)} accent
                  sub={totals.costMissing ? t('usage.statCostPartial') : undefined} />
              : <StatCard label={t('usage.statCache')} value={`${fmtTokens(totals.cacheReadTokens)} / ${fmtTokens(totals.cacheWriteTokens)}`} />}
          </div>

          {totals.totalTokens === 0 && (
            <p className="text-sm text-gray-600">{t('usage.noData')}</p>
          )}

          {/* Admin: per user */}
          {admin && admin.byUser.length > 0 && (
            <UsageTable
              title={t('usage.tableByUser')}
              rows={admin.byUser.map((r) => ({ key: r.userId ?? '∅', label: r.userName ?? t('usage.unknownUser'), g: r }))}
              showCost={showCost}
              colLabels={{ name: t('usage.tableColName'), input: t('usage.tableColInput'), output: t('usage.tableColOutput'), total: t('usage.tableColTotal'), cost: t('usage.tableColCost') }}
            />
          )}

          {/* Per project */}
          {data!.byProject.length > 0 && (
            <UsageTable
              title={t('usage.tableByProject')}
              rows={data!.byProject.map((r) => ({ key: r.projectId ?? '∅', label: r.projectName ?? t('usage.noProject'), g: r }))}
              showCost={showCost}
              colLabels={{ name: t('usage.tableColName'), input: t('usage.tableColInput'), output: t('usage.tableColOutput'), total: t('usage.tableColTotal'), cost: t('usage.tableColCost') }}
            />
          )}

          {/* Per model */}
          {data!.byModel.length > 0 && (
            <UsageTable
              title={t('usage.tableByModel')}
              rows={data!.byModel.map((r) => ({
                key: `${r.provider ?? '∅'}:${r.model ?? ''}`,
                label: r.provider ? `${r.provider}${r.model ? ` · ${r.model}` : ''}` : t('usage.untracked'),
                g: r,
              }))}
              showCost={showCost}
              colLabels={{ name: t('usage.tableColName'), input: t('usage.tableColInput'), output: t('usage.tableColOutput'), total: t('usage.tableColTotal'), cost: t('usage.tableColCost') }}
            />
          )}

          {showCost && (
            <p className="text-xs text-gray-600">{t('usage.costNote')}</p>
          )}

          {/* Admin: call-level serving metrics (latency, errors, throughput). */}
          {isAdmin && <ServingSection days={days} />}
        </>
      )}
    </div>
  );
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;
}

/** Serving metrics (admin): KPI row + calls timeline + per-config table. */
function ServingSection({ days }: { days: number | null }) {
  const { t, i18n } = useTranslation('settings');

  const range = (() => {
    if (days == null) return {};
    const from = new Date();
    from.setDate(from.getDate() - days);
    return { from: from.toISOString() };
  })();

  const query = useQuery({
    queryKey: ['usage-serving', days],
    queryFn: () => usageApi.serving(range),
  });

  // Live queues (P1-F4): only configs with maxConcurrency are gated → appear here.
  const liveQuery = useQuery({
    queryKey: ['usage-serving-live'],
    queryFn: usageApi.servingLive,
    refetchInterval: 5000,
  });
  const liveByConfig = new Map((liveQuery.data ?? []).map((l) => [l.llmConfigId, l]));

  const s = query.data;
  if (query.isLoading || !s) return null;

  const maxCalls = Math.max(...s.timeline.map((p) => p.calls), 1);
  const bucketLabel = (iso: string): string => {
    const d = new Date(iso);
    return s.bucket === 'day'
      ? d.toLocaleDateString(i18n.language, { day: '2-digit', month: '2-digit' })
      : d.toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="space-y-3 pt-2">
      <div>
        <h3 className="text-sm font-semibold text-gray-200">{t('usage.servingTitle')}</h3>
        <p className="text-xs text-gray-500 mt-0.5">{t('usage.servingSubtitle')}</p>
      </div>

      {s.totals.calls === 0 ? (
        <p className="text-sm text-gray-600">{t('usage.servingNoData')}</p>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <StatCard label={t('usage.servingCalls')} value={String(s.totals.calls)} />
            <StatCard label={t('usage.servingErrorRate')} value={`${(s.totals.errorRate * 100).toFixed(1)}%`}
              sub={s.totals.errors > 0 ? t('usage.servingErrors', { count: s.totals.errors }) : undefined} />
            <StatCard label={t('usage.servingP50')} value={fmtMs(s.totals.p50LatencyMs)} />
            <StatCard label={t('usage.servingP95')} value={fmtMs(s.totals.p95LatencyMs)} />
            <StatCard label={t('usage.servingTps')}
              value={s.totals.tokensPerSecond != null ? String(s.totals.tokensPerSecond) : '—'} />
          </div>

          {/* Calls per bucket (single series, one axis; p95/errors in the tooltip). */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <div className="flex items-end gap-[2px] h-16" role="img" aria-label={t('usage.servingTimelineAria')}>
              {s.timeline.map((p) => (
                <div
                  key={p.bucket}
                  title={`${bucketLabel(p.bucket)} — ${t('usage.servingCalls')}: ${p.calls}` +
                    (p.errors > 0 ? ` · ${t('usage.servingErrors', { count: p.errors })}` : '') +
                    ` · p95 ${fmtMs(p.p95LatencyMs)}`}
                  className={`flex-1 min-w-[5px] max-w-[28px] rounded-t-[2px] ${p.errors > 0 ? 'bg-red-500/70' : 'bg-blue-500/60'}`}
                  style={{ height: `${Math.max(10, (p.calls / maxCalls) * 100)}%` }}
                />
              ))}
            </div>
            <p className="text-[11px] text-gray-600 mt-2">
              {t('usage.servingTimelineCaption', { from: bucketLabel(s.from), to: bucketLabel(s.to) })}
            </p>
          </div>

          {s.byConfig.length > 0 && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
              <div className="px-4 py-2.5 border-b border-gray-800">
                <h3 className="text-sm font-semibold text-gray-200">{t('usage.servingTableTitle')}</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-sm">
                  <thead>
                    <tr className="text-xs text-gray-500 border-b border-gray-800">
                      <th className="text-left font-medium px-4 py-2">{t('usage.servingColConfig')}</th>
                      <th className="text-right font-medium px-3 py-2">{t('usage.servingCalls')}</th>
                      <th className="text-right font-medium px-3 py-2">{t('usage.servingColErr')}</th>
                      <th className="text-right font-medium px-3 py-2">p50</th>
                      <th className="text-right font-medium px-3 py-2">p95</th>
                      <th className="text-right font-medium px-3 py-2">{t('usage.servingColTps')}</th>
                      <th className="text-right font-medium px-3 py-2">{t('usage.servingColActive')}</th>
                      <th className="text-right font-medium px-4 py-2">{t('usage.servingColWaiting')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.byConfig.map((r) => {
                      const live = r.llmConfigId ? liveByConfig.get(r.llmConfigId) : undefined;
                      return (
                      <tr key={`${r.llmConfigId ?? '∅'}:${r.model ?? ''}`} className="border-b border-gray-800/50 last:border-0">
                        <td className="px-4 py-2 text-gray-300 truncate max-w-[240px]">
                          {r.configName ?? t('usage.untracked')}
                          <span className="text-gray-600 text-xs"> · {r.provider}{r.model ? ` / ${r.model}` : ''}</span>
                        </td>
                        <td className="px-3 py-2 text-right text-gray-200 font-mono text-xs">{r.calls}</td>
                        <td className={`px-3 py-2 text-right font-mono text-xs ${r.errors > 0 ? 'text-red-400' : 'text-gray-400'}`}>
                          {(r.errorRate * 100).toFixed(1)}%
                        </td>
                        <td className="px-3 py-2 text-right text-gray-400 font-mono text-xs">{fmtMs(r.p50LatencyMs)}</td>
                        <td className="px-3 py-2 text-right text-gray-400 font-mono text-xs">{fmtMs(r.p95LatencyMs)}</td>
                        <td className="px-3 py-2 text-right text-gray-400 font-mono text-xs">{r.tokensPerSecond ?? '—'}</td>
                        {/* Live: gated configs only (maxConcurrency set); '—' = pass-through. */}
                        <td className="px-3 py-2 text-right text-gray-400 font-mono text-xs" title={t('usage.servingLiveHint')}>
                          {live ? `${live.active}${live.max != null ? `/${live.max}` : ''}` : '—'}
                        </td>
                        <td className={`px-4 py-2 text-right font-mono text-xs ${live && live.waiting > 0 ? 'text-amber-400' : 'text-gray-400'}`} title={t('usage.servingLiveHint')}>
                          {live ? live.waiting : '—'}
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function StatCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`text-xl font-semibold mt-1 ${accent ? 'text-emerald-400' : 'text-gray-100'}`}>{value}</p>
      {sub && <p className="text-xs text-gray-600 mt-0.5">{sub}</p>}
    </div>
  );
}

function UsageTable({
  title, rows, showCost, colLabels,
}: {
  title: string;
  rows: { key: string; label: string; g: TokenGroup }[];
  showCost: boolean;
  colLabels: { name: string; input: string; output: string; total: string; cost: string };
}) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <div className="px-4 py-2.5 border-b border-gray-800">
        <h3 className="text-sm font-semibold text-gray-200">{title}</h3>
      </div>
      <div className="overflow-x-auto">
      <table className="w-full min-w-[460px] text-sm">
        <thead>
          <tr className="text-xs text-gray-500 border-b border-gray-800">
            <th className="text-left font-medium px-4 py-2">{colLabels.name}</th>
            <th className="text-right font-medium px-3 py-2">{colLabels.input}</th>
            <th className="text-right font-medium px-3 py-2">{colLabels.output}</th>
            <th className="text-right font-medium px-3 py-2">{colLabels.total}</th>
            {showCost && <th className="text-right font-medium px-4 py-2">{colLabels.cost}</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-b border-gray-800/50 last:border-0">
              <td className="px-4 py-2 text-gray-300 truncate max-w-[200px]">{r.label}</td>
              <td className="px-3 py-2 text-right text-gray-400 font-mono text-xs">{fmtTokens(r.g.inputTokens)}</td>
              <td className="px-3 py-2 text-right text-gray-400 font-mono text-xs">{fmtTokens(r.g.outputTokens)}</td>
              <td className="px-3 py-2 text-right text-gray-200 font-mono text-xs">{fmtTokens(r.g.totalTokens)}</td>
              {showCost && (
                <td className="px-4 py-2 text-right text-emerald-400 font-mono text-xs">
                  {r.g.costMissing && r.g.cost === 0 ? '—' : fmtCost(r.g.cost)}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}

// ── AI System section ────────────────────────────────────────────────────────
function AiSection() {
  const { t } = useTranslation('settings');
  const user = useStore((s) => s.user);
  const isAdmin = user?.role === 'admin';

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-white">{t('ai.title')}</h2>
        <p className="text-sm text-gray-500 mt-1">{t('ai.subtitle')}</p>
      </div>

      {isAdmin && <LlmConfigsSection />}
      {isAdmin && <ToolLoadingAdminCard />}
      {isAdmin && <SandboxAdminCard />}
      {isAdmin && <DataSourceSecurityAdminCard />}
      {isAdmin && <SystemPromptCard />}
    </div>
  );
}

// ── LLM provider metadata ─────────────────────────────────────────────────────
const LLM_PROVIDERS: {
  value:       LlmProvider;
  label:       string;
  descKey:     string;
  needsKey:    boolean;
  /** The token is optional (local servers with optional auth or behind a proxy). */
  keyOptional?: boolean;
  needsUrl:    boolean;
  defaultModels: string[];
}[] = [
  {
    value:         'anthropic',
    label:         'Anthropic (Claude)',
    descKey:       'llm.providerAnthropicDesc',
    needsKey:      true,
    needsUrl:      false,
    defaultModels: ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
  },
  {
    value:         'openai',
    label:         'OpenAI',
    descKey:       'llm.providerOpenAiDesc',
    needsKey:      true,
    needsUrl:      false,
    defaultModels: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini'],
  },
  {
    value:         'gemini',
    label:         'Google Gemini',
    descKey:       'llm.providerGeminiDesc',
    needsKey:      true,
    needsUrl:      false,
    // Use the "-latest" aliases: Google retires pinned versions (e.g. gemini-2.0-flash
    // now 404s), whereas the aliases always resolve to a live model.
    defaultModels: ['gemini-flash-latest', 'gemini-pro-latest', 'gemini-flash-lite-latest'],
  },
  {
    value:         'ollama',
    label:         'Ollama (locale)',
    descKey:       'llm.providerOllamaDesc',
    needsKey:      true,
    keyOptional:   true,
    needsUrl:      true,
    defaultModels: ['llama3.3', 'llama3.2', 'qwen3', 'gemma3', 'mistral', 'deepseek-r1'],
  },
  {
    value:         'lmstudio',
    label:         'LM Studio (locale)',
    descKey:       'llm.providerLmStudioDesc',
    needsKey:      true,
    keyOptional:   true,
    needsUrl:      true,
    defaultModels: [],
  },
  {
    value:         'openai-compatible',
    label:         'OpenAI-compatibile',
    descKey:       'llm.providerOpenAiCompatDesc',
    needsKey:      true,
    keyOptional:   true,
    needsUrl:      true,
    defaultModels: [],
  },
  {
    value:         'deepseek',
    label:         'DeepSeek',
    descKey:       'llm.providerDeepSeekDesc',
    needsKey:      true,
    needsUrl:      false,
    defaultModels: ['deepseek-v4-flash', 'deepseek-v4-pro'],
  },
];

const DEFAULT_URLS: Partial<Record<LlmProvider, string>> = {
  ollama:    'http://localhost:11434',
  lmstudio:  'http://localhost:1234/v1',
  deepseek:  'https://api.deepseek.com/v1',
};

// ── Card: tool prompt optimization (admin only) ────────────────────────────

const STRATEGY_ICON: Record<ToolLoadingStrategy, React.ReactNode> = {
  always_inject_all: <Package size={14} />,
  top_k_rag:         <Filter size={14} />,
  auto:              <Zap size={14} />,
};

/**
 * Compact, searchable multi-select: chips of the selected items + search + fixed-height
 * scrollable list. Stays compact even with many options.
 */
function MultiSelectSearch({ options, selected, onChange, searchPlaceholder, emptyText }: {
  options: { id: string; name: string }[];
  selected: string[];
  onChange: (next: string[]) => void;
  searchPlaceholder: string;
  emptyText: string;
}) {
  const [q, setQ] = useState('');
  if (options.length === 0) return <p className="text-xs text-gray-600 italic">{emptyText}</p>;

  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  const needle = q.trim().toLowerCase();
  const filtered = needle ? options.filter((o) => o.name.toLowerCase().includes(needle)) : options;
  const selectedOpts = options.filter((o) => selected.includes(o.id));

  return (
    <div className="space-y-1.5">
      {selectedOpts.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selectedOpts.map((o) => (
            <span key={o.id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border border-blue-500 bg-blue-500/15 text-blue-200">
              {o.name}
              <button type="button" onClick={() => toggle(o.id)} className="hover:text-white"><X size={11} /></button>
            </span>
          ))}
        </div>
      )}
      <div className="relative">
        <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-500" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={searchPlaceholder}
          className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-7 pr-3 py-1.5 text-xs text-gray-200" />
      </div>
      <div className="max-h-36 overflow-y-auto rounded-lg border border-gray-800 divide-y divide-gray-800/60">
        {filtered.length === 0 ? (
          <div className="px-3 py-2 text-xs text-gray-600">—</div>
        ) : filtered.map((o) => {
          const on = selected.includes(o.id);
          return (
            <button key={o.id} type="button" onClick={() => toggle(o.id)}
              className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left ${on ? 'bg-blue-500/10 text-blue-200' : 'text-gray-300 hover:bg-gray-800/60'}`}>
              <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 ${on ? 'border-blue-400 bg-blue-500/30' : 'border-gray-600'}`}>
                {on && <Check size={10} />}
              </span>
              <span className="truncate">{o.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SandboxAdminCard() {
  const { t } = useTranslation('settings');
  const qc = useQueryClient();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['sandbox-config'],
    queryFn: appConfigApi.getSandboxConfig,
  });

  // Team/project lists for the selectors (by name, not UUID).
  const { data: teamList } = useQuery({ queryKey: ['teams'], queryFn: teamsApi.list });
  const { data: projectList } = useQuery({ queryKey: ['projects'], queryFn: projectsApi.list });

  const [enabled, setEnabled]     = useState(false);
  const [network, setNetwork]     = useState<SandboxNetwork>('none');
  const [execMode, setExecMode]   = useState<SandboxExecMode>('hardened');
  const [teamIds, setTeamIds]     = useState<string[]>([]);
  const [projectIds, setProjectIds] = useState<string[]>([]);

  useEffect(() => {
    if (!data) return;
    setEnabled(data.sandboxEnabled);
    setNetwork(data.sandboxNetwork);
    setExecMode(data.sandboxExecMode ?? 'hardened');
    setTeamIds(data.sandboxAllowedTeamIds ?? []);
    setProjectIds(data.sandboxAllowedProjectIds ?? []);
  }, [data]);

  const mutation = useMutation({
    mutationFn: () => appConfigApi.updateSandboxConfig({
      sandboxEnabled:           enabled,
      sandboxNetwork:           network,
      sandboxExecMode:          execMode,
      sandboxAllowedTeamIds:    teamIds,
      sandboxAllowedProjectIds: projectIds,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sandbox-config'] });
      setMsg({ ok: true, text: t('sandbox.savedOk') });
      setTimeout(() => setMsg(null), 3000);
    },
    onError: (e: any) => setMsg({ ok: false, text: e?.response?.data?.message ?? e.message }),
  });

  const netOptions: Array<{ value: SandboxNetwork; labelKey: string; descKey: string }> = [
    { value: 'none',     labelKey: 'sandbox.netNoneLabel',     descKey: 'sandbox.netNoneDesc' },
    { value: 'internal', labelKey: 'sandbox.netInternalLabel', descKey: 'sandbox.netInternalDesc' },
    { value: 'internet', labelKey: 'sandbox.netInternetLabel', descKey: 'sandbox.netInternetDesc' },
    { value: 'open',     labelKey: 'sandbox.netOpenLabel',     descKey: 'sandbox.netOpenDesc' },
  ];

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-5">
      <div>
        <h3 className="text-sm font-semibold text-gray-100 flex items-center gap-2">
          <Terminal size={14} className="text-emerald-400" />
          {t('sandbox.adminTitle')}
        </h3>
        <p className="text-xs text-gray-500 mt-1">{t('sandbox.adminSubtitle')}</p>
      </div>

      {/* Runtime mode declared by the executor: transparency on the isolation level. */}
      {data?.sandboxRuntimeMode === 'in-process' && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/15 px-3 py-2">
          <ShieldAlert size={14} className="text-amber-400 mt-0.5 shrink-0" />
          <div>
            <p className="text-xs font-semibold text-amber-300">{t('sandbox.runtimeInProcess')}</p>
            <p className="text-xs text-amber-200/80 mt-0.5">{t('sandbox.runtimeInProcessDesc')}</p>
          </div>
        </div>
      )}
      {data?.sandboxRuntimeMode === 'broker' && (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/15 px-3 py-2">
          <CheckCircle size={14} className="text-emerald-400 shrink-0" />
          <p className="text-xs text-emerald-300">{t('sandbox.runtimeBroker')}</p>
        </div>
      )}
      {data?.sandboxRuntimeMode === 'unavailable' && (
        <div className="flex items-center gap-2 rounded-lg border border-gray-700 bg-gray-800/60 px-3 py-2">
          <ShieldAlert size={14} className="text-gray-400 shrink-0" />
          <p className="text-xs text-gray-400">{t('sandbox.runtimeUnavailable')}</p>
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center gap-2 text-gray-500 text-xs"><Loader2 size={13} className="animate-spin" /> {t('sandbox.loading')}</div>
      ) : (
        <>
          {/* Master switch */}
          <div>
            <label className="flex items-center gap-3 cursor-pointer">
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="accent-blue-500 w-4 h-4" />
              <span className="text-sm text-gray-200">{t('sandbox.enableLabel')}</span>
            </label>
            <p className="text-xs text-gray-500 mt-1">{t('sandbox.enableHint')}</p>
          </div>

          {/* Network policy */}
          <div className="space-y-2">
            <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wide">{t('sandbox.networkLabel')}</label>
            <div className="grid grid-cols-1 gap-2">
              {netOptions.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => setNetwork(o.value)}
                  className={`flex flex-col items-start p-3 rounded-lg border text-left transition-colors
                    ${network === o.value
                      ? 'border-blue-500 bg-blue-500/10 text-white'
                      : 'border-gray-700 bg-gray-800/50 text-gray-400 hover:border-gray-600'}`}
                >
                  <span className="text-sm font-medium">{t(o.labelKey)}</span>
                  <span className="text-xs text-gray-500">{t(o.descKey)}</span>
                </button>
              ))}
            </div>
            {network === 'open' && (
              <p className="text-xs text-amber-400 flex items-start gap-1.5">
                <ShieldAlert size={13} className="mt-0.5 shrink-0" /> {t('sandbox.openWarning')}
              </p>
            )}
          </div>

          {/* Execution profile: isolated (hardened) vs writable rootfs + root (trusted) */}
          <div className="space-y-2">
            <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wide">{t('sandbox.execModeLabel')}</label>
            <div className="grid grid-cols-1 gap-2">
              {([
                { value: 'hardened', labelKey: 'sandbox.execHardenedLabel', descKey: 'sandbox.execHardenedDesc' },
                { value: 'trusted',  labelKey: 'sandbox.execTrustedLabel',  descKey: 'sandbox.execTrustedDesc' },
              ] as Array<{ value: SandboxExecMode; labelKey: string; descKey: string }>).map((o) => (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => setExecMode(o.value)}
                  className={`flex flex-col items-start p-3 rounded-lg border text-left transition-colors
                    ${execMode === o.value
                      ? 'border-blue-500 bg-blue-500/10 text-white'
                      : 'border-gray-700 bg-gray-800/50 text-gray-400 hover:border-gray-600'}`}
                >
                  <span className="text-sm font-medium">{t(o.labelKey)}</span>
                  <span className="text-xs text-gray-500">{t(o.descKey)}</span>
                </button>
              ))}
            </div>
            {execMode === 'trusted' && (
              <p className="text-xs text-amber-400 flex items-start gap-1.5">
                <ShieldAlert size={13} className="mt-0.5 shrink-0" /> {t('sandbox.execTrustedWarning')}
              </p>
            )}
          </div>

          {/* Team/project allowlist — selection by name (chips) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-gray-400">{t('sandbox.teamsLabel')}</label>
              <MultiSelectSearch
                options={(teamList ?? []).map((tm) => ({ id: tm.id, name: tm.name }))}
                selected={teamIds}
                onChange={setTeamIds}
                searchPlaceholder={t('sandbox.searchPlaceholder')}
                emptyText={t('sandbox.noTeams')}
              />
            </div>
            <div className="space-y-1.5">
              <label className="block text-xs font-semibold text-gray-400">{t('sandbox.projectsLabel')}</label>
              <MultiSelectSearch
                options={(projectList ?? []).map((pr) => ({ id: pr.id, name: pr.name }))}
                selected={projectIds}
                onChange={setProjectIds}
                searchPlaceholder={t('sandbox.searchPlaceholder')}
                emptyText={t('sandbox.noProjects')}
              />
            </div>
          </div>
          <p className="text-xs text-gray-500">{t('sandbox.allowlistHint')}</p>

          <div className="flex items-center gap-3">
            <button onClick={() => mutation.mutate()} disabled={mutation.isPending}
              className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium px-4 py-2 rounded-lg">
              {mutation.isPending ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              {t('sandbox.save')}
            </button>
            {msg && <span className={`text-xs ${msg.ok ? 'text-emerald-400' : 'text-red-400'}`}>{msg.text}</span>}
          </div>
        </>
      )}
    </div>
  );
}

function DataSourceSecurityAdminCard() {
  const { t } = useTranslation('settings');
  const qc = useQueryClient();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['datasource-security-config'],
    queryFn: appConfigApi.getDataSourceSecurityConfig,
  });

  const [allowPrivate, setAllowPrivate] = useState(true);
  const [allowlistText, setAllowlistText] = useState('');

  useEffect(() => {
    if (!data) return;
    setAllowPrivate(data.dataSourceAllowPrivateHosts);
    setAllowlistText((data.dataSourceHostAllowlist ?? []).join('\n'));
  }, [data]);

  const mutation = useMutation({
    mutationFn: () => appConfigApi.updateDataSourceSecurityConfig({
      dataSourceAllowPrivateHosts: allowPrivate,
      dataSourceHostAllowlist: allowlistText.split(/[\n,]/).map((s) => s.trim()).filter(Boolean),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['datasource-security-config'] });
      setMsg({ ok: true, text: t('dsSecurity.savedOk') });
      setTimeout(() => setMsg(null), 3000);
    },
    onError: (e: any) => setMsg({ ok: false, text: e?.response?.data?.message ?? e.message }),
  });

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-5">
      <div>
        <h3 className="text-sm font-semibold text-gray-100 flex items-center gap-2">
          <ShieldAlert size={14} className="text-emerald-400" />
          {t('dsSecurity.title')}
        </h3>
        <p className="text-xs text-gray-500 mt-1">{t('dsSecurity.subtitle')}</p>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-gray-500 text-xs"><Loader2 size={13} className="animate-spin" /> {t('dsSecurity.loading')}</div>
      ) : (
        <>
          <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/15 px-3 py-2">
            <ShieldAlert size={14} className="text-emerald-400 mt-0.5 shrink-0" />
            <p className="text-xs text-emerald-300">{t('dsSecurity.metadataNote')}</p>
          </div>

          <div>
            <label className="flex items-center gap-3 cursor-pointer">
              <input type="checkbox" checked={allowPrivate} onChange={(e) => setAllowPrivate(e.target.checked)} className="accent-blue-500 w-4 h-4" />
              <span className="text-sm text-gray-200">{t('dsSecurity.allowPrivateLabel')}</span>
            </label>
            <p className="text-xs text-gray-500 mt-1">{t('dsSecurity.allowPrivateHint')}</p>
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs font-semibold text-gray-400">{t('dsSecurity.allowlistLabel')}</label>
            <textarea
              value={allowlistText}
              onChange={(e) => setAllowlistText(e.target.value)}
              rows={3}
              placeholder={"db.internal.example\n10.0.5.0/24\n192.168.1.20"}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 font-mono resize-y"
            />
            <p className="text-xs text-gray-500">{t('dsSecurity.allowlistHint')}</p>
          </div>

          <div className="flex items-center gap-3">
            <button onClick={() => mutation.mutate()} disabled={mutation.isPending}
              className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium px-4 py-2 rounded-lg">
              {mutation.isPending ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              {t('dsSecurity.save')}
            </button>
            {msg && <span className={`text-xs ${msg.ok ? 'text-emerald-400' : 'text-red-400'}`}>{msg.text}</span>}
          </div>
        </>
      )}
    </div>
  );
}

function ToolLoadingAdminCard() {
  const { t } = useTranslation('settings');
  const qc = useQueryClient();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['tool-loading-config'],
    queryFn: appConfigApi.getToolLoadingConfig,
  });

  const [strategy, setStrategy] = useState<ToolLoadingStrategy>('always_inject_all');
  const [maxTools, setMaxTools] = useState('15');
  const [format, setFormat]     = useState<ToolSchemaFormat>('full');
  const [maxHistoryTokens, setMaxHistory] = useState('6000');
  const [compaction, setCompaction] = useState(false);
  const [compactionThreshold, setCompactionThreshold] = useState('80');
  const [autoMemoryThreshold, setAutoMemoryThreshold] = useState('6');

  useEffect(() => {
    if (!data) return;
    setStrategy(data.toolLoadingStrategy);
    setMaxTools(String(data.toolLoadingMaxTools));
    setFormat(data.toolSchemaFormat);
    setMaxHistory(String(data.maxHistoryTokens));
    setCompaction(data.historyCompactionEnabled);
    setCompactionThreshold(String(data.historyCompactionThreshold));
    setAutoMemoryThreshold(String(data.autoMemoryThreshold));
  }, [data]);

  const mutation = useMutation({
    mutationFn: () => appConfigApi.updateToolLoadingConfig({
      toolLoadingStrategy: strategy,
      toolLoadingMaxTools: parseInt(maxTools, 10) || 15,
      toolSchemaFormat:    format,
      maxHistoryTokens:    parseInt(maxHistoryTokens, 10) || 6000,
      historyCompactionEnabled: compaction,
      historyCompactionThreshold: Math.min(95, Math.max(50, parseInt(compactionThreshold, 10) || 80)),
      autoMemoryThreshold: Math.min(100, Math.max(1, parseInt(autoMemoryThreshold, 10) || 6)),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tool-loading-config'] });
      setMsg({ ok: true, text: t('toolLoading.savedOk') });
      setTimeout(() => setMsg(null), 3000);
    },
    onError: (e: any) => setMsg({ ok: false, text: e?.response?.data?.message ?? e.message }),
  });

  const needsMaxTools = strategy === 'top_k_rag' || strategy === 'auto';

  // Translated strategy options
  const strategyAdminOptions: Array<{ value: ToolLoadingStrategy; labelKey: string; descKey: string }> = [
    { value: 'always_inject_all', labelKey: 'toolLoading.strategyAlwaysLabel', descKey: 'toolLoading.strategyAlwaysDesc' },
    { value: 'top_k_rag',         labelKey: 'toolLoading.strategyTopKLabel',   descKey: 'toolLoading.strategyTopKDesc' },
    { value: 'auto',              labelKey: 'toolLoading.strategyAutoLabel',   descKey: 'toolLoading.strategyAutoDesc' },
  ];

  // Translated format options
  const formatAdminOptions: Array<{ value: ToolSchemaFormat; labelKey: string; descKey: string; savingKey: string }> = [
    { value: 'full',       labelKey: 'toolLoading.formatFullLabel',       descKey: 'toolLoading.formatFullDesc',       savingKey: 'toolLoading.formatFullSaving' },
    { value: 'compressed', labelKey: 'toolLoading.formatCompressedLabel', descKey: 'toolLoading.formatCompressedDesc', savingKey: 'toolLoading.formatCompressedSaving' },
    { value: 'deferred',   labelKey: 'toolLoading.formatDeferredLabel',   descKey: 'toolLoading.formatDeferredDesc',   savingKey: 'toolLoading.formatDeferredSaving' },
  ];

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-5">
      <div>
        <h3 className="text-sm font-semibold text-gray-100 flex items-center gap-2">
          <Zap size={14} className="text-yellow-400" />
          {t('toolLoading.adminTitle')}
        </h3>
        <p className="text-xs text-gray-500 mt-1">
          {t('toolLoading.adminSubtitle')}
        </p>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-gray-500 text-xs"><Loader2 size={13} className="animate-spin" /> {t('toolLoading.loading')}</div>
      ) : (
        <>
          {/* Axis 1: Selection */}
          <div className="space-y-2">
            <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wide">
              {t('toolLoading.axis1Label')}
            </label>
            <div className="grid grid-cols-1 gap-2">
              {strategyAdminOptions.map((s) => (
                <button
                  key={s.value}
                  type="button"
                  onClick={() => setStrategy(s.value)}
                  className={`flex items-start gap-3 p-3 rounded-lg border text-left transition-colors
                    ${strategy === s.value
                      ? 'border-blue-500 bg-blue-500/10 text-white'
                      : 'border-gray-700 bg-gray-800/50 text-gray-400 hover:border-gray-600'}`}
                >
                  <span className={`mt-0.5 shrink-0 ${strategy === s.value ? 'text-blue-400' : 'text-gray-500'}`}>
                    {STRATEGY_ICON[s.value]}
                  </span>
                  <span>
                    <span className="block text-xs font-medium">{t(s.labelKey)}</span>
                    <span className="block text-xs text-gray-500 mt-0.5">{t(s.descKey)}</span>
                  </span>
                  {strategy === s.value && <CheckCircle size={13} className="ml-auto shrink-0 mt-0.5 text-blue-400" />}
                </button>
              ))}
            </div>

            {needsMaxTools && (
              <div className="flex items-center gap-3 mt-2">
                <label className="text-xs text-gray-400 shrink-0">
                  {strategy === 'top_k_rag' ? t('toolLoading.kLabel_topkrag') : t('toolLoading.kLabel_auto')}
                </label>
                <input
                  type="number"
                  min={1} max={100}
                  value={maxTools}
                  onChange={(e) => setMaxTools(e.target.value)}
                  className="w-20 px-2 py-1 bg-gray-800 border border-gray-700 rounded text-sm
                    text-gray-100 focus:outline-none focus:border-blue-500"
                />
                <span className="text-xs text-gray-600">{t('toolLoading.kUnit')}</span>
              </div>
            )}
          </div>

          {/* Axis 2: Schema format */}
          <div className="space-y-2">
            <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wide">
              {t('toolLoading.axis2Label')}
            </label>
            <div className="grid grid-cols-1 gap-2">
              {formatAdminOptions.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  onClick={() => setFormat(f.value)}
                  className={`flex items-start gap-3 p-3 rounded-lg border text-left transition-colors
                    ${format === f.value
                      ? 'border-purple-500 bg-purple-500/10 text-white'
                      : 'border-gray-700 bg-gray-800/50 text-gray-400 hover:border-gray-600'}`}
                >
                  <span className="flex-1">
                    <span className="block text-xs font-medium">{t(f.labelKey)}</span>
                    <span className="block text-xs text-gray-500 mt-0.5">{t(f.descKey)}</span>
                  </span>
                  <span className={`text-xs shrink-0 mt-0.5 font-mono
                    ${format === f.value ? 'text-purple-400' : 'text-gray-600'}`}>
                    {t(f.savingKey)}
                  </span>
                  {format === f.value && <CheckCircle size={13} className="shrink-0 mt-0.5 text-purple-400" />}
                </button>
              ))}
            </div>
          </div>

          {/* Conversation memory (global default) */}
          <div className="space-y-2">
            <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wide">
              {t('toolLoading.conversationMemoryLabel')}
            </label>
            <div className="flex items-center gap-3">
              <input
                type="number" min={500} max={32000} step={500}
                value={maxHistoryTokens}
                onChange={(e) => setMaxHistory(e.target.value)}
                placeholder="es. 6000"
                className="w-28 px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-sm
                  text-gray-100 focus:outline-none focus:border-blue-500"
              />
              <span className="text-xs text-gray-500">{t('toolLoading.conversationMemoryUnit')}</span>
            </div>
            <p className="text-xs text-gray-600">
              {t('toolLoading.conversationMemoryHint')}
            </p>

            <label className="flex items-start gap-2 mt-2 cursor-pointer">
              <input
                type="checkbox"
                checked={compaction}
                onChange={(e) => setCompaction(e.target.checked)}
                className="mt-0.5 accent-blue-500"
              />
              <span className="text-xs text-gray-400">
                {t('toolLoading.compactInsteadLabel')}
                <span className="block text-gray-600 mt-0.5">
                  {t('toolLoading.compactInsteadHint')}
                </span>
              </span>
            </label>

            {compaction && (
              <div className="ml-6 mt-1 space-y-1">
                <div className="flex items-center gap-3">
                  <label className="text-xs text-gray-400 shrink-0">{t('toolLoading.compactionThresholdLabel')}</label>
                  <input
                    type="number" min={50} max={95} step={5}
                    value={compactionThreshold}
                    onChange={(e) => setCompactionThreshold(e.target.value)}
                    className="w-20 px-2 py-1 bg-gray-800 border border-gray-700 rounded text-sm
                      text-gray-100 focus:outline-none focus:border-blue-500"
                  />
                  <span className="text-xs text-gray-600">{t('toolLoading.compactionThresholdUnit')}</span>
                </div>
                <p className="text-xs text-gray-600">
                  {t('toolLoading.compactionThresholdHint', { budget: maxHistoryTokens || 6000 })}
                </p>
              </div>
            )}
          </div>

          {/* Persistent user memory (global default threshold) */}
          <div className="space-y-2">
            <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wide">
              {t('toolLoading.persistentMemoryLabel')}
            </label>
            <div className="flex items-center gap-3">
              <input
                type="number" min={1} max={100}
                value={autoMemoryThreshold}
                onChange={(e) => setAutoMemoryThreshold(e.target.value)}
                placeholder="es. 6"
                className="w-20 px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-sm
                  text-gray-100 focus:outline-none focus:border-blue-500"
              />
              <span className="text-xs text-gray-500">{t('toolLoading.persistentMemoryUnit')}</span>
            </div>
            <p className="text-xs text-gray-600">
              {t('toolLoading.persistentMemoryHint')}
            </p>
          </div>

          <div className="flex items-center justify-between pt-1">
            {msg ? (
              <span className={`text-xs flex items-center gap-1.5 ${msg.ok ? 'text-emerald-400' : 'text-red-400'}`}>
                {msg.ok ? <CheckCircle size={13} /> : <XCircle size={13} />}
                {msg.text}
              </span>
            ) : <span />}
            <button
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending}
              className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 hover:bg-blue-500
                disabled:opacity-50 text-white text-sm rounded-lg transition-colors"
            >
              {mutation.isPending ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
              {t('toolLoading.saveGlobal')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ── Card: per-user tool loading override ──────────────────────────────────────

function ToolLoadingUserCard() {
  const { t } = useTranslation('settings');
  const qc = useQueryClient();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const profileQuery = useQuery({ queryKey: ['profile'], queryFn: profileApi.get, staleTime: 60_000 });

  // null = "use global default"
  const [strategy, setStrategy]           = useState<ToolLoadingStrategy | 'global'>('global');
  const [maxTools, setMaxTools]           = useState('');
  const [format, setFormat]               = useState<ToolSchemaFormat | 'global'>('global');
  const [maxHistoryTokens, setMaxHistory] = useState('');

  useEffect(() => {
    if (!profileQuery.data) return;
    setStrategy(profileQuery.data.toolLoadingStrategy ?? 'global');
    setMaxTools(profileQuery.data.toolLoadingMaxTools != null ? String(profileQuery.data.toolLoadingMaxTools) : '');
    setFormat(profileQuery.data.toolSchemaFormat ?? 'global');
    setMaxHistory(profileQuery.data.maxHistoryTokens != null ? String(profileQuery.data.maxHistoryTokens) : '');
  }, [profileQuery.data]);

  const mutation = useMutation({
    mutationFn: () => profileApi.update({
      toolLoadingStrategy: strategy === 'global' ? null : strategy,
      toolLoadingMaxTools: maxTools.trim() ? parseInt(maxTools, 10) : null,
      toolSchemaFormat:    format === 'global' ? null : format,
      maxHistoryTokens:    maxHistoryTokens.trim() ? parseInt(maxHistoryTokens, 10) : null,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['profile'] });
      setMsg({ ok: true, text: t('toolLoading.toolSavedOk') });
      setTimeout(() => setMsg(null), 3000);
    },
    onError: (e: any) => setMsg({ ok: false, text: e?.response?.data?.message ?? e.message }),
  });

  const needsMaxTools = strategy !== 'global' && (strategy === 'top_k_rag' || strategy === 'auto');

  const strategyOptions: Array<{ value: ToolLoadingStrategy | 'global'; labelKey: string; descKey: string }> = [
    { value: 'global',            labelKey: 'toolLoading.globalDefault',        descKey: 'toolLoading.globalDefaultDesc' },
    { value: 'always_inject_all', labelKey: 'toolLoading.strategyAlwaysLabel',  descKey: 'toolLoading.strategyAlwaysDesc' },
    { value: 'top_k_rag',         labelKey: 'toolLoading.strategyTopKLabel',    descKey: 'toolLoading.strategyTopKDesc' },
    { value: 'auto',              labelKey: 'toolLoading.strategyAutoLabel',    descKey: 'toolLoading.strategyAutoDesc' },
  ];

  const formatOptions: Array<{ value: ToolSchemaFormat | 'global'; labelKey: string; descKey: string }> = [
    { value: 'global',     labelKey: 'toolLoading.globalDefault',          descKey: 'toolLoading.globalFormatDesc' },
    { value: 'full',       labelKey: 'toolLoading.formatFullLabel',        descKey: 'toolLoading.formatFullDesc' },
    { value: 'compressed', labelKey: 'toolLoading.formatCompressedLabel',  descKey: 'toolLoading.formatCompressedDesc' },
    { value: 'deferred',   labelKey: 'toolLoading.formatDeferredLabel',    descKey: 'toolLoading.formatDeferredDesc' },
  ];

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-5">
      <div>
        <h3 className="text-sm font-semibold text-gray-100 flex items-center gap-2">
          <Zap size={14} className="text-yellow-400" />
          {t('toolLoading.userTitle')}
        </h3>
        <p className="text-xs text-gray-500 mt-1">
          {t('toolLoading.userSubtitle')}
        </p>
      </div>

      {profileQuery.isLoading ? (
        <div className="flex items-center gap-2 text-gray-500 text-xs"><Loader2 size={13} className="animate-spin" /> {t('toolLoading.loading')}</div>
      ) : (
        <>
          {/* Selection */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-gray-400">{t('toolLoading.toolSelectionLabel')}</label>
            <div className="grid grid-cols-1 gap-1.5">
              {strategyOptions.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setStrategy(opt.value)}
                  className={`flex items-start gap-3 px-3 py-2.5 rounded-lg border text-left transition-colors text-xs
                    ${strategy === opt.value
                      ? 'border-blue-500 bg-blue-500/10 text-white'
                      : 'border-gray-700 bg-gray-800/40 text-gray-400 hover:border-gray-600'}`}
                >
                  <span className="flex-1">
                    <span className="font-medium">{t(opt.labelKey)}</span>
                    <span className="block text-gray-500 mt-0.5">{t(opt.descKey)}</span>
                  </span>
                  {strategy === opt.value && <CheckCircle size={12} className="shrink-0 mt-0.5 text-blue-400" />}
                </button>
              ))}
            </div>

            {needsMaxTools && (
              <div className="flex items-center gap-3 mt-1.5 pl-1">
                <label className="text-xs text-gray-400 shrink-0">{t('toolLoading.kLabelUser')}</label>
                <input
                  type="number" min={1} max={100}
                  value={maxTools}
                  onChange={(e) => setMaxTools(e.target.value)}
                  placeholder={t('toolLoading.kPlaceholderUser')}
                  className="w-20 px-2 py-1 bg-gray-800 border border-gray-700 rounded text-sm
                    text-gray-100 focus:outline-none focus:border-blue-500"
                />
                <span className="text-xs text-gray-600">{t('toolLoading.kHintUser')}</span>
              </div>
            )}
          </div>

          {/* Format */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-gray-400">{t('toolLoading.schemaFormatLabel')}</label>
            <div className="grid grid-cols-1 gap-1.5">
              {formatOptions.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setFormat(opt.value)}
                  className={`flex items-start gap-3 px-3 py-2.5 rounded-lg border text-left transition-colors text-xs
                    ${format === opt.value
                      ? 'border-purple-500 bg-purple-500/10 text-white'
                      : 'border-gray-700 bg-gray-800/40 text-gray-400 hover:border-gray-600'}`}
                >
                  <span className="flex-1">
                    <span className="font-medium">{t(opt.labelKey)}</span>
                    <span className="block text-gray-500 mt-0.5">{t(opt.descKey)}</span>
                  </span>
                  {format === opt.value && <CheckCircle size={12} className="shrink-0 mt-0.5 text-purple-400" />}
                </button>
              ))}
            </div>
          </div>

          {/* Conversation history */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-gray-400">{t('toolLoading.conversationMemoryLabel')}</label>
            <div className="flex items-center gap-3">
              <input
                type="number" min={500} max={32000} step={500}
                value={maxHistoryTokens}
                onChange={(e) => setMaxHistory(e.target.value)}
                placeholder="es. 6000"
                className="w-28 px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-sm
                  text-gray-100 focus:outline-none focus:border-blue-500"
              />
              <span className="text-xs text-gray-500">
                {t('toolLoading.conversationMemoryUnitUser')}
              </span>
            </div>
            <p className="text-xs text-gray-600">
              {t('toolLoading.conversationMemoryHintUser')}
            </p>
          </div>

          <div className="flex items-center justify-between pt-1">
            {msg ? (
              <span className={`text-xs flex items-center gap-1.5 ${msg.ok ? 'text-emerald-400' : 'text-red-400'}`}>
                {msg.ok ? <CheckCircle size={13} /> : <XCircle size={13} />}
                {msg.text}
              </span>
            ) : <span />}
            <button
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending}
              className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 hover:bg-blue-500
                disabled:opacity-50 text-white text-sm rounded-lg transition-colors"
            >
              {mutation.isPending ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
              {t('common:actions.save')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ── LlmConfigForm — create/edit form for a single config ─────────────────────

function LlmConfigForm({
  initial,
  onSave,
  onCancel,
  isSaving,
}: {
  initial?: LlmConfigDto | null;
  onSave: (payload: {
    name: string; provider: LlmProvider; model: string | null;
    apiKey?: string | null; baseUrl: string | null; maxTokens: number | null;
    maxConcurrency: number | null;
    inputPricePerM: number | null; outputPricePerM: number | null;
    cacheReadPricePerM: number | null; cacheWritePricePerM: number | null;
  }) => void;
  onCancel: () => void;
  isSaving: boolean;
}) {
  const { t } = useTranslation('settings');
  const [name, setName]         = useState(initial?.name ?? '');
  const [provider, setProvider] = useState<LlmProvider>(initial?.provider ?? 'anthropic');
  const [model, setModel]       = useState(initial?.model ?? '');
  const [apiKey, setApiKey]     = useState('');
  const [removeKey, setRemoveKey] = useState(false);
  const [baseUrl, setBaseUrl]   = useState(initial?.baseUrl ?? '');
  const [maxTokens, setMaxTokens] = useState(String(initial?.maxTokens ?? 4096));
  const [maxConcurrency, setMaxConcurrency] = useState(initial?.maxConcurrency != null ? String(initial.maxConcurrency) : '');
  const [inputPrice, setInputPrice]   = useState(initial?.inputPricePerM != null ? String(initial.inputPricePerM) : '');
  const [outputPrice, setOutputPrice] = useState(initial?.outputPricePerM != null ? String(initial.outputPricePerM) : '');
  const [cacheReadPrice, setCacheReadPrice]   = useState(initial?.cacheReadPricePerM != null ? String(initial.cacheReadPricePerM) : '');
  const [cacheWritePrice, setCacheWritePrice] = useState(initial?.cacheWritePricePerM != null ? String(initial.cacheWritePricePerM) : '');
  const [showKey, setShowKey]   = useState(false);

  const meta = LLM_PROVIDERS.find((p) => p.value === provider)!;

  const handleProviderChange = (p: LlmProvider) => {
    setProvider(p);
    setModel('');
    setBaseUrl(DEFAULT_URLS[p] ?? '');
  };

  const handleSave = () => {
    const payload: any = {
      name: name.trim(),
      provider,
      model: model.trim() || null,
      baseUrl: baseUrl.trim() || null,
      maxTokens: parseInt(maxTokens, 10) || null,
      maxConcurrency: maxConcurrency.trim() !== '' ? parseInt(maxConcurrency, 10) || null : null,
      inputPricePerM:  inputPrice.trim()  !== '' ? Number(inputPrice)  : null,
      outputPricePerM: outputPrice.trim() !== '' ? Number(outputPrice) : null,
      cacheReadPricePerM:  cacheReadPrice.trim()  !== '' ? Number(cacheReadPrice)  : null,
      cacheWritePricePerM: cacheWritePrice.trim() !== '' ? Number(cacheWritePrice) : null,
    };
    if (removeKey) {
      payload.apiKey = null;
    } else if (apiKey.trim()) {
      payload.apiKey = apiKey.trim();
    }
    onSave(payload);
  };

  return (
    <div className="space-y-4">
      {/* Name */}
      <div>
        <label className="block text-xs font-medium text-gray-400 mb-1">{t('llm.formNameLabel')}</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('llm.formNamePlaceholder')}
          className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm
            text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-600 transition-colors"
        />
      </div>

      {/* Provider */}
      <div>
        <label className="block text-xs font-medium text-gray-400 mb-1.5">{t('llm.formProviderLabel')}</label>
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
          {LLM_PROVIDERS.map((p) => (
            <button
              key={p.value}
              type="button"
              onClick={() => handleProviderChange(p.value)}
              className={`flex flex-col items-start gap-0.5 px-2.5 py-2 rounded-lg border text-left transition-all
                ${provider === p.value
                  ? 'border-blue-500 bg-blue-900/20 text-white'
                  : 'border-gray-700 bg-gray-800/50 text-gray-400 hover:border-gray-600 hover:text-gray-300'}`}
            >
              <span className="text-xs font-medium leading-tight">{p.label}</span>
              <span className="text-[10px] text-gray-500 leading-tight">{t(p.descKey)}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Model */}
      <div>
        <label className="block text-xs font-medium text-gray-400 mb-1">{t('llm.formModelLabel')}</label>
        {meta.defaultModels.length > 0 && (
          <div className="flex gap-1.5 flex-wrap mb-1.5">
            {meta.defaultModels.map((m) => (
              <button
                key={m} type="button"
                onClick={() => setModel(m)}
                className={`text-[11px] px-2.5 py-0.5 rounded-full border transition-colors
                  ${model === m
                    ? 'border-blue-500 bg-blue-900/30 text-blue-300'
                    : 'border-gray-700 text-gray-500 hover:border-gray-500 hover:text-gray-300'}`}
              >
                {m}
              </button>
            ))}
          </div>
        )}
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder={meta.defaultModels[0] ? `es. ${meta.defaultModels[0]}` : t('llm.formModelPlaceholder')}
          className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm
            text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-600 transition-colors"
        />
      </div>

      {/* API Key */}
      {meta.needsKey && (
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1 flex items-center gap-1.5">
            <KeyRound size={11} /> {t('llm.formApiKeyLabel')}
            {meta.keyOptional && (
              <span className="text-[10px] text-gray-600">— {t('llm.apiKeyOptionalHint')}</span>
            )}
            {initial?.hasApiKey && !removeKey && (
              <span className="text-[10px] text-emerald-500 bg-emerald-900/20 px-1.5 py-0.5 rounded-full">● {t('llm.keyStored')}</span>
            )}
          </label>
          <div className="relative">
            <input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => { setApiKey(e.target.value); setRemoveKey(false); }}
              disabled={removeKey}
              placeholder={initial?.hasApiKey ? t('llm.apiKeyKeepPlaceholder') : t('llm.apiKeyPastePlaceholder')}
              className="w-full px-3 py-2 pr-9 bg-gray-800 border border-gray-700 rounded-lg text-sm
                text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-600
                transition-colors font-mono disabled:opacity-40"
            />
            <button type="button" onClick={() => setShowKey((v) => !v)}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300">
              {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
          {initial?.hasApiKey && (
            <label className="flex items-center gap-1.5 mt-1.5 cursor-pointer">
              <input type="checkbox" checked={removeKey}
                onChange={(e) => { setRemoveKey(e.target.checked); setApiKey(''); }}
                className="accent-red-500" />
              <span className="text-[11px] text-gray-500">{t('llm.removeKeyLabel')}</span>
            </label>
          )}
        </div>
      )}

      {/* Base URL */}
      {meta.needsUrl && (
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">{t('llm.formBaseUrlLabel')}</label>
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={DEFAULT_URLS[provider] ?? 'http://localhost:8080/v1'}
            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm
              text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-600
              transition-colors font-mono"
          />
        </div>
      )}

      {/* Max Tokens */}
      <div>
        <label className="block text-xs font-medium text-gray-400 mb-1">{t('llm.formMaxTokensLabel')}</label>
        <input
          type="number" min={256} max={384000} step={256}
          value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)}
          className="w-36 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm
            text-gray-200 focus:outline-none focus:border-blue-600 transition-colors"
        />
      </div>

      {/* Max concurrency (request scheduler): empty = unlimited (pass-through) */}
      <div>
        <label className="block text-xs font-medium text-gray-400 mb-1">
          {t('llm.formMaxConcurrencyLabel')} <span className="text-gray-600">— {t('llm.formMaxConcurrencyHint')}</span>
        </label>
        <input
          type="number" min={1} max={64} step={1}
          value={maxConcurrency} onChange={(e) => setMaxConcurrency(e.target.value)}
          placeholder={t('llm.formMaxConcurrencyPlaceholder')}
          className="w-36 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm
            text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-600 transition-colors"
        />
      </div>

      {/* Prices (for the usage dashboard) */}
      <div>
        <label className="block text-xs font-medium text-gray-400 mb-1">
          {t('llm.formPriceLabel')} <span className="text-gray-600">— {t('llm.formPriceHint')}</span>
        </label>
        <div className="grid grid-cols-2 gap-x-3 gap-y-2">
          <label className="flex items-center gap-1.5">
            <span className="text-xs text-gray-500 flex-shrink-0">{t('llm.formPriceInput')}</span>
            <input
              type="number" min={0} step="0.01"
              value={inputPrice} onChange={(e) => setInputPrice(e.target.value)}
              placeholder="es. 3.00"
              className="flex-1 min-w-0 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm
                text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-600 transition-colors"
            />
          </label>
          <label className="flex items-center gap-1.5">
            <span className="text-xs text-gray-500 flex-shrink-0">{t('llm.formPriceOutput')}</span>
            <input
              type="number" min={0} step="0.01"
              value={outputPrice} onChange={(e) => setOutputPrice(e.target.value)}
              placeholder="es. 15.00"
              className="flex-1 min-w-0 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm
                text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-600 transition-colors"
            />
          </label>
          <label className="flex items-center gap-1.5">
            <span className="text-xs text-gray-500 flex-shrink-0">{t('llm.formPriceCacheRead')}</span>
            <input
              type="number" min={0} step="0.001"
              value={cacheReadPrice} onChange={(e) => setCacheReadPrice(e.target.value)}
              placeholder="es. 0.30"
              className="flex-1 min-w-0 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm
                text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-600 transition-colors"
            />
          </label>
          <label className="flex items-center gap-1.5">
            <span className="text-xs text-gray-500 flex-shrink-0">{t('llm.formPriceCacheWrite')}</span>
            <input
              type="number" min={0} step="0.001"
              value={cacheWritePrice} onChange={(e) => setCacheWritePrice(e.target.value)}
              placeholder="es. 3.75"
              className="flex-1 min-w-0 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm
                text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-600 transition-colors"
            />
          </label>
        </div>
        <p className="text-[11px] text-gray-600 mt-1">{t('llm.formPriceCacheHint')}</p>
      </div>

      {/* Form actions */}
      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={handleSave}
          disabled={isSaving || !name.trim()}
          className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 hover:bg-blue-500
            disabled:opacity-50 text-white text-sm rounded-lg transition-colors"
        >
          {isSaving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
          {initial ? t('llm.formSaveChanges') : t('llm.formCreate')}
        </button>
        <button type="button" onClick={onCancel}
          className="px-3 py-1.5 text-sm text-gray-400 hover:text-gray-200 rounded-lg transition-colors">
          {t('common:actions.cancel')}
        </button>
      </div>
    </div>
  );
}

// ── LlmConfigsSection — list + management of LLM configs (admin only) ─────────
function LlmConfigsSection() {
  const { t } = useTranslation('settings');
  const qc = useQueryClient();
  const [editing, setEditing]   = useState<LlmConfigDto | null | 'new'>(null);
  const [testId, setTestId]     = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; error?: string }>>({});
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [saveError, setSaveError]   = useState('');

  const { data: configs = [], isLoading } = useQuery({
    queryKey: ['llm-configs'],
    queryFn:  llmConfigsApi.list,
    staleTime: 30_000,
  });

  const createMut = useMutation({
    mutationFn: (p: any) => llmConfigsApi.create(p),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['llm-configs'] }); setEditing(null); setSaveError(''); },
    onError: (e: any) => setSaveError(e?.response?.data?.message ?? e.message),
  });

  const updateMut = useMutation({
    mutationFn: ({ id, p }: { id: string; p: any }) => llmConfigsApi.update(id, p),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['llm-configs'] }); setEditing(null); setSaveError(''); },
    onError: (e: any) => setSaveError(e?.response?.data?.message ?? e.message),
  });

  const removeMut = useMutation({
    mutationFn: (id: string) => llmConfigsApi.remove(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['llm-configs'] }); setConfirmDel(null); },
  });

  const defaultMut = useMutation({
    mutationFn: (id: string) => llmConfigsApi.setDefault(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['llm-configs'] }),
  });

  const summarizerMut = useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) =>
      on ? llmConfigsApi.setSummarizer(id) : llmConfigsApi.clearSummarizer(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['llm-configs'] }),
  });

  const visionMut = useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) =>
      on ? llmConfigsApi.setVision(id) : llmConfigsApi.clearVision(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['llm-configs'] }),
  });

  const testMut = useMutation({
    mutationFn: (id: string) => llmConfigsApi.testConnection(id),
    onMutate: (id) => { setTestId(id); },
    onSettled: (data, _err, id) => {
      setTestId(null);
      if (data) setTestResult((prev) => ({ ...prev, [id]: data }));
    },
  });

  const isSaving = createMut.isPending || updateMut.isPending;

  return (
    <div className="bg-gray-900 border border-blue-800/40 rounded-xl p-5 space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-100 flex items-center gap-2">
            <Cpu size={14} className="text-blue-400" />
            {t('llm.sectionTitle')}
            <span className="text-xs font-normal text-blue-600 bg-blue-900/30 px-2 py-0.5 rounded-full">{t('llm.adminBadge')}</span>
          </h3>
          <p className="text-xs text-gray-500 mt-1 leading-relaxed">
            {t('llm.sectionHintPre')}{' '}
            <strong className="text-gray-400">{t('llm.sectionHintDefault')}</strong>{' '}
            {t('llm.sectionHintPost')}
          </p>
        </div>
        {editing === null && (
          <button
            onClick={() => { setEditing('new'); setSaveError(''); }}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500
              text-white text-xs font-medium rounded-lg transition-colors flex-shrink-0"
          >
            <Plus size={13} /> {t('llm.addBtn')}
          </button>
        )}
      </div>

      {/* Creation form */}
      {editing === 'new' && (
        <div className="bg-gray-800/60 rounded-xl p-4 border border-gray-700">
          <p className="text-xs font-semibold text-gray-400 mb-3 uppercase tracking-wider">{t('llm.newConfigTitle')}</p>
          <LlmConfigForm
            onSave={(p) => createMut.mutate(p as any)}
            onCancel={() => { setEditing(null); setSaveError(''); }}
            isSaving={isSaving}
          />
          {saveError && <p className="text-xs text-red-400 mt-2 flex items-center gap-1"><XCircle size={12} />{saveError}</p>}
        </div>
      )}

      {/* Config list */}
      {isLoading ? (
        <div className="flex items-center gap-2 text-xs text-gray-600 py-4">
          <Loader2 size={13} className="animate-spin" /> {t('common:actions.loading')}
        </div>
      ) : configs.length === 0 ? (
        <p className="text-xs text-gray-600 py-4 text-center">{t('llm.noConfigs')}</p>
      ) : (
        <div className="space-y-2">
          {configs.map((cfg) => {
            const isEditingThis = editing !== 'new' && editing?.id === cfg.id;
            const tr = testResult[cfg.id];
            const providerMeta = LLM_PROVIDERS.find((p) => p.value === cfg.provider);

            return (
              <div
                key={cfg.id}
                className={`rounded-xl border transition-colors
                  ${cfg.isDefault
                    ? 'border-blue-700/60 bg-blue-950/20'
                    : 'border-gray-700/60 bg-gray-800/30'}`}
              >
                {/* Card header */}
                <div className="flex items-start gap-3 px-4 py-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-gray-100">{cfg.name}</span>
                      {cfg.isDefault && (
                        <span className="flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-full
                          bg-blue-900/50 text-blue-300 border border-blue-700/50">
                          <Star size={9} fill="currentColor" /> {t('llm.badgePredefined')}
                        </span>
                      )}
                      {cfg.isSummarizer && (
                        <span className="flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-full
                          bg-amber-900/40 text-amber-300 border border-amber-700/50">
                          <Sparkles size={9} /> {t('llm.badgeSummarizer')}
                        </span>
                      )}
                      {cfg.isVision && (
                        <span className="flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-full
                          bg-violet-900/40 text-violet-300 border border-violet-700/50">
                          <Eye size={9} /> {t('llm.badgeVision')}
                        </span>
                      )}
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-700/60 text-gray-400">
                        {providerMeta?.label ?? cfg.provider}
                      </span>
                      {cfg.model && (
                        <span className="text-[11px] font-mono text-gray-500">{cfg.model}</span>
                      )}
                      {cfg.hasApiKey && (
                        <span className="text-[10px] text-emerald-500 flex items-center gap-0.5">
                          <KeyRound size={9} /> key
                        </span>
                      )}
                    </div>
                    {cfg.baseUrl && (
                      <p className="text-[11px] font-mono text-gray-600 mt-0.5 truncate">{cfg.baseUrl}</p>
                    )}
                  </div>

                  {/* Card actions */}
                  {!isEditingThis && (
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {/* Test */}
                      <button
                        onClick={() => testMut.mutate(cfg.id)}
                        disabled={testId === cfg.id}
                        title={t('llm.testTitle')}
                        className="p-1.5 text-gray-500 hover:text-gray-300 rounded transition-colors"
                      >
                        {testId === cfg.id
                          ? <Loader2 size={13} className="animate-spin" />
                          : tr?.ok === true
                            ? <Wifi size={13} className="text-emerald-400" />
                            : tr?.ok === false
                              ? <WifiOff size={13} className="text-red-400" />
                              : <Wifi size={13} />}
                      </button>

                      {/* Set as default */}
                      {!cfg.isDefault && (
                        <button
                          onClick={() => defaultMut.mutate(cfg.id)}
                          disabled={defaultMut.isPending}
                          title={t('llm.setDefaultTitle')}
                          className="p-1.5 text-gray-500 hover:text-blue-300 rounded transition-colors"
                        >
                          <Star size={13} />
                        </button>
                      )}

                      {/* Designate/remove as summarizer for history compaction */}
                      <button
                        onClick={() => summarizerMut.mutate({ id: cfg.id, on: !cfg.isSummarizer })}
                        disabled={summarizerMut.isPending}
                        title={cfg.isSummarizer ? t('llm.removeSummarizerTitle') : t('llm.setSummarizerTitle')}
                        className={`p-1.5 rounded transition-colors ${
                          cfg.isSummarizer
                            ? 'text-amber-400 hover:text-amber-300'
                            : 'text-gray-500 hover:text-amber-300'}`}
                      >
                        <Sparkles size={13} />
                      </button>

                      {/* Designate/remove as vision model (image OCR, multimodal) */}
                      <button
                        onClick={() => visionMut.mutate({ id: cfg.id, on: !cfg.isVision })}
                        disabled={visionMut.isPending}
                        title={cfg.isVision ? t('llm.removeVisionTitle') : t('llm.setVisionTitle')}
                        className={`p-1.5 rounded transition-colors ${
                          cfg.isVision
                            ? 'text-violet-400 hover:text-violet-300'
                            : 'text-gray-500 hover:text-violet-300'}`}
                      >
                        <Eye size={13} />
                      </button>

                      {/* Edit */}
                      <button
                        onClick={() => { setEditing(cfg); setSaveError(''); }}
                        title={t('llm.editTitle')}
                        className="p-1.5 text-gray-500 hover:text-gray-300 rounded transition-colors"
                      >
                        <Pencil size={13} />
                      </button>

                      {/* Delete */}
                      {confirmDel === cfg.id ? (
                        <>
                          <button
                            onClick={() => removeMut.mutate(cfg.id)}
                            disabled={removeMut.isPending}
                            className="px-2 py-1 text-xs bg-red-600 hover:bg-red-500 text-white rounded transition-colors"
                          >
                            {removeMut.isPending ? <Loader2 size={11} className="animate-spin" /> : t('llm.deleteConfirmYes')}
                          </button>
                          <button onClick={() => setConfirmDel(null)}
                            className="px-2 py-1 text-xs text-gray-400 hover:text-gray-200 rounded">{t('llm.deleteConfirmNo')}</button>
                        </>
                      ) : (
                        <button
                          onClick={() => setConfirmDel(cfg.id)}
                          title={t('llm.deleteTitle')}
                          className="p-1.5 text-gray-500 hover:text-red-400 rounded transition-colors"
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {/* Test result */}
                {tr && (
                  <div className={`px-4 pb-2 text-[11px] flex items-center gap-1
                    ${tr.ok ? 'text-emerald-400' : 'text-red-400'}`}>
                    {tr.ok
                      ? <><CheckCircle size={11} /> {t('llm.connectionOk')}</>
                      : <><XCircle size={11} /> {tr.error}</>}
                  </div>
                )}

                {/* Inline edit form */}
                {isEditingThis && (
                  <div className="px-4 pb-4 border-t border-gray-700/50 pt-3">
                    <LlmConfigForm
                      initial={cfg}
                      onSave={(p) => updateMut.mutate({ id: cfg.id, p })}
                      onCancel={() => { setEditing(null); setSaveError(''); }}
                      isSaving={isSaving}
                    />
                    {saveError && <p className="text-xs text-red-400 mt-2 flex items-center gap-1"><XCircle size={12} />{saveError}</p>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Card: base system prompt (admin only) ────────────────────────────────────
function SystemPromptCard() {
  const { t } = useTranslation('settings');
  const qc = useQueryClient();

  const { data: config, isLoading } = useQuery({
    queryKey: ['admin-config'],
    queryFn: appConfigApi.get,
    staleTime: 60_000,
  });

  const [prompt, setPrompt] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (config?.systemPrompt != null) setPrompt(config.systemPrompt);
  }, [config?.systemPrompt]);

  const mutation = useMutation({
    mutationFn: () => appConfigApi.update(prompt),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-config'] });
      setMsg({ ok: true, text: t('systemPrompt.savedOk') });
      setTimeout(() => setMsg(null), 4000);
    },
    onError: (e: any) => {
      setMsg({ ok: false, text: e?.response?.data?.message ?? e.message });
    },
  });

  return (
    <div className="bg-gray-900 border border-amber-800/40 rounded-xl p-5 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-gray-100 flex items-center gap-2">
          <Bot size={14} className="text-amber-400" />
          {t('systemPrompt.title')}
          <span className="ml-1 text-xs font-normal text-amber-600 bg-amber-900/30 px-2 py-0.5 rounded-full">
            {t('systemPrompt.adminBadge')}
          </span>
        </h3>
        <p className="text-sm text-gray-500 mt-1 leading-relaxed">
          {t('systemPrompt.subtitle')}
        </p>
        {config?.updatedAt && (
          <p className="text-xs text-gray-600 mt-1">
            {t('systemPrompt.lastModified')} {new Date(config.updatedAt).toLocaleString()}
          </p>
        )}
      </div>

      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={18}
        disabled={isLoading}
        className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-xs
          text-gray-200 placeholder-gray-600 focus:outline-none focus:border-amber-600
          transition-colors resize-y font-mono leading-relaxed disabled:opacity-50"
        placeholder={t('systemPrompt.loadingPlaceholder')}
      />

      <div className="flex items-center justify-between">
        {msg ? (
          <span className={`text-xs flex items-center gap-1.5 ${msg.ok ? 'text-emerald-400' : 'text-red-400'}`}>
            {msg.ok ? <CheckCircle size={13} /> : <XCircle size={13} />}
            {msg.text}
          </span>
        ) : (
          <span className="text-xs text-gray-600">
            {t('systemPrompt.charCount', { count: prompt.length })}
          </span>
        )}
        <button
          onClick={() => mutation.mutate()}
          disabled={mutation.isPending || isLoading || !prompt.trim()}
          className="flex items-center gap-1.5 px-4 py-1.5 bg-amber-600 hover:bg-amber-500
            disabled:opacity-50 text-white text-sm rounded-lg transition-colors"
        >
          {mutation.isPending
            ? <Loader2 size={13} className="animate-spin" />
            : <Save size={13} />}
          {t('systemPrompt.saveBtn')}
        </button>
      </div>
    </div>
  );
}

// ── Files section ─────────────────────────────────────────────────────────────
function fileIcon(mimeType: string) {
  if (mimeType === 'application/pdf') return '📄';
  if (mimeType.includes('word')) return '📝';
  if (mimeType.includes('sheet') || mimeType.includes('csv')) return '📊';
  if (mimeType.startsWith('image/')) return '🖼️';
  return '📎';
}

function FilesSection() {
  const { t } = useTranslation('settings');
  const qc = useQueryClient();
  const [search, setSearch] = useState('');

  /** ID of the file whose collection selector is open (null = none open) */
  const [ingestFileId, setIngestFileId] = useState<string | null>(null);
  const [selectValue,  setSelectValue]  = useState('');
  const [scopeValue,   setScopeValue]   = useState<DocScope>('personal');
  const [ingestProjectId, setIngestProjectId] = useState<string | null>(null);

  const { data: files = [], isLoading } = useQuery({
    queryKey: ['files', 'all'],
    queryFn: () => filesApi.list(),
  });

  const { data: collections = [], isLoading: collectionsLoading } = useQuery<string[]>({
    queryKey: ['embed-collections'],
    queryFn:  filesApi.listCollections,
    enabled:  ingestFileId !== null,
    staleTime: 30_000,
  });

  const ingest = useMutation({
    mutationFn: ({ fileId, collection, scope, projectId }: { fileId: string; collection?: string; scope: DocScope; projectId?: string | null }) =>
      filesApi.ingest(fileId, { scope, collection: collection || undefined, projectId: projectId || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['files'] });
      closeIngest();
    },
  });

  const deleteFile = useMutation({
    mutationFn: (fileId: string) => filesApi.delete(fileId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['files'] }),
  });

  const setScope = useMutation({
    mutationFn: ({ id, scope }: { id: string; scope: FileScope }) => filesApi.setScope(id, scope),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['files'] }),
  });

  function openIngest(file: FileRecord) {
    setIngestFileId(file.id);
    setSelectValue('');
    setIngestProjectId(file.projectId ?? null);
    setScopeValue(file.projectId ? 'project' : 'personal');
  }

  function closeIngest() {
    setIngestFileId(null);
    setSelectValue('');
    setIngestProjectId(null);
  }

  function confirmIngest() {
    if (!ingestFileId) return;
    ingest.mutate({ fileId: ingestFileId, collection: selectValue.trim() || undefined, scope: scopeValue, projectId: ingestProjectId });
  }

  const filtered = files.filter((f) =>
    f.originalName.toLowerCase().includes(search.toLowerCase()),
  );

  const stats = {
    total: files.length,
    vectorized: files.filter((f) => f.vectorized).length,
    size: files.reduce((acc, f) => acc + Number(f.size), 0),
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-white">{t('files.title')}</h2>
        <p className="text-sm text-gray-500 mt-1">{t('files.subtitle')}</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: t('files.statTotal'), value: stats.total.toString() },
          { label: t('files.statIndexed'), value: `${stats.vectorized} / ${stats.total}` },
          { label: t('files.statSize'), value: filesApi.formatSize(stats.size) },
        ].map(({ label, value }) => (
          <div key={label} className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3">
            <p className="text-xs text-gray-500">{label}</p>
            <p className="text-lg font-semibold text-white mt-0.5">{value}</p>
          </div>
        ))}
      </div>

      {/* Search + table */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-800 flex items-center gap-3">
          <Search size={15} className="text-gray-500 flex-shrink-0" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('files.searchPlaceholder')}
            className="flex-1 bg-transparent text-sm text-gray-200 placeholder-gray-600 focus:outline-none"
          />
          {isLoading && <Loader2 size={14} className="animate-spin text-gray-500" />}
        </div>

        {filtered.length === 0 ? (
          <div className="py-12 text-center text-sm text-gray-600">
            {search ? t('files.emptySearch') : t('files.emptyAll')}
          </div>
        ) : (
          <div className="divide-y divide-gray-800">
            {filtered.map((file: FileRecord) => (
              <FileRow
                key={file.id}
                file={file}
                isIngesting={ingest.isPending && ingest.variables?.fileId === file.id}
                isDeleting={deleteFile.isPending && deleteFile.variables === file.id}
                onIngest={() => openIngest(file)}
                onDelete={() => deleteFile.mutate(file.id)}
                isSelectingThis={ingestFileId === file.id}
                collectionsLoading={collectionsLoading}
                collections={collections}
                selectValue={ingestFileId === file.id ? selectValue : ''}
                onSelectChange={setSelectValue}
                scopeValue={ingestFileId === file.id ? scopeValue : 'personal'}
                onScopeChange={setScopeValue}
                onConfirmIngest={confirmIngest}
                onCancelIngest={closeIngest}
                onSetScope={(scope) => setScope.mutate({ id: file.id, scope })}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function FileRow({
  file,
  isIngesting,
  isDeleting,
  onIngest,
  onDelete,
  isSelectingThis,
  collectionsLoading,
  collections,
  selectValue,
  onSelectChange,
  scopeValue,
  onScopeChange,
  onConfirmIngest,
  onCancelIngest,
  onSetScope,
}: {
  file: FileRecord;
  isIngesting: boolean;
  isDeleting: boolean;
  onIngest: () => void;
  onDelete: () => void;
  isSelectingThis: boolean;
  collectionsLoading: boolean;
  collections: string[];
  selectValue: string;
  onSelectChange: (v: string) => void;
  scopeValue: DocScope;
  onScopeChange: (v: DocScope) => void;
  onConfirmIngest: () => void;
  onCancelIngest: () => void;
  onSetScope: (scope: FileScope) => void;
}) {
  const { t } = useTranslation('settings');
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div className="px-4 py-3 hover:bg-gray-800/40 transition-colors group">
      {/* ── Main row ── */}
      <div className="flex items-center gap-3">
        <span className="text-xl flex-shrink-0">{fileIcon(file.mimeType)}</span>

        <div className="flex-1 min-w-0">
          <p className="text-sm text-gray-200 truncate">{file.originalName}</p>
          <p className="text-xs text-gray-500 mt-0.5">
            {filesApi.formatSize(file.size)}
            {' · '}
            {new Date(file.createdAt).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' })}
          </p>
        </div>

        {/* Access scope (C2): personal | team | org */}
        <select
          value={file.scope ?? 'personal'}
          onChange={(e) => onSetScope(e.target.value as FileScope)}
          title={t('files.scopeTitle')}
          className="flex-shrink-0 bg-gray-800 border border-gray-700 rounded px-1.5 py-1 text-xs text-gray-300 focus:outline-none focus:border-indigo-500/50"
        >
          <option value="personal">{t('files.scopePersonal')}</option>
          <option value="team">{t('files.scopeTeam')}</option>
          <option value="org">{t('files.scopeOrg')}</option>
        </select>

        {/* RAG status — shows the collection if already indexed */}
        <div className="flex-shrink-0">
          {file.vectorized ? (
            <span className="flex items-center gap-1 text-xs text-green-500" title={file.vectorCollectionId ? `Collection: ${file.vectorCollectionId}` : undefined}>
              <CheckCircle size={12} />
              {file.vectorCollectionId ? file.vectorCollectionId : 'RAG'}
            </span>
          ) : (
            <span className="text-xs text-gray-600">—</span>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={() => filesApi.download(file.id)}
            className="p-1.5 text-gray-400 hover:text-gray-200 rounded transition-colors"
            title={t('files.download')}
          >
            <Download size={14} />
          </button>
          <button
            onClick={isSelectingThis ? onCancelIngest : onIngest}
            disabled={isIngesting}
            className={`p-1.5 rounded transition-colors disabled:opacity-40 ${
              isSelectingThis
                ? 'text-teal-400'
                : 'text-gray-400 hover:text-teal-400'
            }`}
            title={file.vectorized ? t('files.reindexBtn') : t('files.indexBtn')}
          >
            {isIngesting ? <Loader2 size={14} className="animate-spin" /> : <Brain size={14} />}
          </button>
          {confirmDelete ? (
            <div className="flex items-center gap-1">
              <button
                onClick={() => { onDelete(); setConfirmDelete(false); }}
                disabled={isDeleting}
                className="px-2 py-1 text-xs bg-red-600 hover:bg-red-500 text-white rounded transition-colors"
              >
                {t('files.confirmDeleteBtn')}
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="px-2 py-1 text-xs text-gray-400 hover:text-gray-200 rounded transition-colors"
              >
                {t('common:actions.cancel')}
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              className="p-1.5 text-gray-400 hover:text-red-400 rounded transition-colors"
              title={t('files.deleteBtn')}
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>

      {/* ── Scope + collection selector (expanded inline) ── */}
      {isSelectingThis && (
        <div className="mt-2.5 ml-9 space-y-2">
          <select
            value={scopeValue}
            onChange={(e) => onScopeChange(e.target.value as DocScope)}
            className="w-full bg-gray-950 border border-gray-700 rounded-lg px-2.5 py-1.5
              text-xs text-gray-200 focus:outline-none focus:border-teal-500 transition-colors"
          >
            <option value="universal">🌐 {t('files.indexingScopeUniversal')}</option>
            <option value="project" disabled={!file.projectId}>📁 {file.projectId ? t('files.indexingScopeProject') : t('files.indexingScopeProjectDisabled')}</option>
            <option value="personal">🔒 {t('files.indexingScopePersonal')}</option>
          </select>
          {collectionsLoading ? (
            <div className="flex items-center gap-1.5 text-xs text-gray-500 py-1">
              <Loader2 size={11} className="animate-spin" /> {t('files.loadingCollections')}
            </div>
          ) : (
            <select
              value={selectValue}
              onChange={(e) => onSelectChange(e.target.value)}
              className="w-full bg-gray-950 border border-gray-700 rounded-lg px-2.5 py-1.5
                text-xs text-gray-200 focus:outline-none focus:border-teal-500 transition-colors"
            >
              <option value="">{t('files.defaultCollection')}</option>
              {collections.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          )}

          <div className="flex gap-1.5">
            <button
              onClick={onConfirmIngest}
              disabled={isIngesting || collectionsLoading}
              className="flex-1 py-1.5 bg-teal-600 hover:bg-teal-500 disabled:opacity-50
                text-white text-xs rounded-lg transition-colors flex items-center justify-center gap-1"
            >
              {isIngesting
                ? <><Loader2 size={11} className="animate-spin" /> {t('files.indexing')}</>
                : <><Brain size={11} /> {t('files.indexBtn2')}</>
              }
            </button>
            <button
              onClick={onCancelIngest}
              disabled={isIngesting}
              className="px-2.5 py-1.5 text-gray-500 hover:text-gray-300
                border border-gray-700 rounded-lg transition-colors"
            >
              <X size={12} />
            </button>
          </div>

          <p className="text-xs text-gray-600 leading-tight">
            {t('files.defaultCollectionHint')}
          </p>
        </div>
      )}
    </div>
  );
}

// ── Generic card component ────────────────────────────────────────────────────
function SettingCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-gray-100">{title}</h3>
        <p className="text-sm text-gray-500 mt-1 leading-relaxed">{description}</p>
      </div>
      {children}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── VECTOR DB SECTION (admin only) ────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function VectorDbSection() {
  const { t } = useTranslation('settings');
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-white">{t('vectordb.title')}</h2>
        <p className="text-sm text-gray-500 mt-1">
          {t('vectordb.subtitle')}
        </p>
      </div>
      <VectorDbConnectionCard />
      <VectorCollectionsCard />
      <ActiveCollectionCard />
      <EmbeddingConfigCard />
      <TranscriptionConfigCard />
    </div>
  );
}

// ── Vector DB provider metadata ───────────────────────────────────────────────
const VECTOR_DB_PROVIDERS: {
  value:       VectorDbProvider;
  label:       string;
  descKey:     string;
  needsUrl:    boolean;
  needsConn:   boolean;
  needsKey:    boolean;
  urlLabel:    string;
  urlPlaceholder: string;
  keyLabel:    string;
  extraFields: { key: string; labelKey: string; placeholder: string }[];
}[] = [
  {
    value:       'qdrant',
    label:       'Qdrant',
    descKey:     'vectordb.providerQdrantDesc',
    needsUrl:    true,
    needsConn:   false,
    needsKey:    true,
    urlLabel:    'URL Server',
    urlPlaceholder: 'http://localhost:6333',
    keyLabel:    'API Key (Qdrant Cloud, optional)',
    extraFields: [],
  },
  {
    value:       'pgvector',
    label:       'PGVector',
    descKey:     'vectordb.providerPgVectorDesc',
    needsUrl:    false,
    needsConn:   true,
    needsKey:    false,
    urlLabel:    '',
    urlPlaceholder: '',
    keyLabel:    '',
    extraFields: [
      { key: 'tablePrefix', labelKey: 'vectordb.extraTablePrefix', placeholder: 'vecs_' },
    ],
  },
  {
    value:       'chroma',
    label:       'Chroma',
    descKey:     'vectordb.providerChromaDesc',
    needsUrl:    true,
    needsConn:   false,
    needsKey:    true,
    urlLabel:    'URL Server',
    urlPlaceholder: 'http://localhost:8000',
    keyLabel:    'API Key (Chroma Cloud, optional)',
    extraFields: [
      { key: 'tenant',   labelKey: 'vectordb.extraTenant',   placeholder: 'default_tenant' },
      { key: 'database', labelKey: 'vectordb.extraDatabase', placeholder: 'default_database' },
    ],
  },
  {
    value:       'astradb',
    label:       'AstraDB',
    descKey:     'vectordb.providerAstraDbDesc',
    needsUrl:    true,
    needsConn:   false,
    needsKey:    true,
    urlLabel:    'Endpoint',
    urlPlaceholder: 'https://ID-REGION.apps.astra.datastax.com',
    keyLabel:    'Application Token (AstraCS:...)',
    extraFields: [
      { key: 'keyspace', labelKey: 'vectordb.extraKeyspace', placeholder: 'default_keyspace' },
    ],
  },
];

// ── Card: Vector DB connection (multi-provider) ────────────────────────────────
function VectorDbConnectionCard() {
  const { t } = useTranslation('settings');
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['vector-db-config'],
    queryFn:  vectorDbApi.getConfig,
    staleTime: 60_000,
  });

  const [provider, setProvider]   = useState<VectorDbProvider>('qdrant');
  const [url,      setUrl]        = useState('');
  const [connStr,  setConnStr]    = useState('');
  const [apiKey,   setApiKey]     = useState('');
  const [showKey,  setShowKey]    = useState(false);
  const [extra,    setExtra]      = useState<Record<string, string>>({});
  const [msg,      setMsg]        = useState<{ ok: boolean; text: string } | null>(null);

  const meta = VECTOR_DB_PROVIDERS.find((p) => p.value === provider)!;

  useEffect(() => {
    if (!data) return;
    setProvider(data.provider ?? 'qdrant');
    setUrl(data.url ?? '');
    setConnStr('');  // connection string is never returned (it contains credentials)
    setExtra(data.extraConfig ? Object.fromEntries(
      Object.entries(data.extraConfig).map(([k, v]) => [k, String(v)])
    ) : {});
  }, [data]);

  const mutation = useMutation({
    mutationFn: () => vectorDbApi.updateConfig({
      provider,
      url:              meta.needsUrl  ? url.trim() || null    : null,
      connectionString: meta.needsConn ? connStr.trim() || null : null,
      apiKey:           apiKey || undefined,
      extraConfig:      Object.keys(extra).length
        ? Object.fromEntries(Object.entries(extra).filter(([, v]) => v.trim()))
        : null,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['vector-db-config'] });
      setApiKey('');
      setMsg({ ok: true, text: t('vectordb.savedOk') });
      setTimeout(() => setMsg(null), 3000);
    },
    onError: (e: any) => setMsg({ ok: false, text: e?.response?.data?.message ?? t('vectordb.errorGeneric') }),
  });

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-5">
      <div className="flex items-center gap-2">
        <Server size={15} className="text-indigo-400" />
        <h3 className="text-sm font-semibold text-gray-100">{t('vectordb.connectionTitle')}</h3>
      </div>

      {/* Provider selector */}
      <div>
        <label className="block text-xs font-medium text-gray-400 mb-1.5">{t('vectordb.providerLabel')}</label>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {VECTOR_DB_PROVIDERS.map((p) => (
            <button
              key={p.value}
              onClick={() => setProvider(p.value)}
              className={`flex flex-col items-start px-3 py-2.5 rounded-lg border text-left transition-colors
                ${provider === p.value
                  ? 'border-indigo-500 bg-indigo-900/30 text-white'
                  : 'border-gray-700 bg-gray-800/50 text-gray-400 hover:border-gray-600 hover:text-gray-300'}`}
            >
              <span className="text-sm font-semibold">{p.label}</span>
              <span className="text-xs mt-0.5 opacity-70 leading-tight">{t(p.descKey)}</span>
            </button>
          ))}
        </div>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 text-gray-500 text-sm">
          <Loader2 size={14} className="animate-spin" /> {t('vectordb.loading')}
        </div>
      )}

      {/* URL (Qdrant, Chroma, AstraDB) */}
      {meta.needsUrl && (
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">{meta.urlLabel}</label>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={meta.urlPlaceholder}
            className="w-full px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm
              text-gray-100 placeholder-gray-600 focus:outline-none focus:border-blue-500
              transition-colors font-mono"
          />
        </div>
      )}

      {/* Connection string (PGVector) */}
      {meta.needsConn && (
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">
            {t('vectordb.connStringLabel')}
          </label>
          <input
            value={connStr}
            onChange={(e) => setConnStr(e.target.value)}
            placeholder="postgresql://user:pass@host:5432/dbname"
            className="w-full px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm
              text-gray-100 placeholder-gray-600 focus:outline-none focus:border-blue-500
              transition-colors font-mono"
          />
          <p className="text-xs text-gray-600 mt-1">
            {t('vectordb.connStringHint')} <code className="text-gray-500">pgvector</code> {t('vectordb.connStringHint2')}
          </p>
        </div>
      )}

      {/* API key */}
      {meta.needsKey && (
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">
            {meta.keyLabel}
            {data?.hasApiKey && <span className="ml-2 text-emerald-500 font-normal">✓ {t('vectordb.apiKeyConfigured')}</span>}
          </label>
          <div className="relative">
            <input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={data?.hasApiKey ? t('vectordb.apiKeyKeepPlaceholder') : t('vectordb.apiKeyPastePlaceholder')}
              className="w-full px-3 py-1.5 pr-9 bg-gray-800 border border-gray-700 rounded-lg text-sm
                text-gray-100 placeholder-gray-600 focus:outline-none focus:border-blue-500
                transition-colors font-mono"
            />
            <button
              type="button"
              onClick={() => setShowKey((p) => !p)}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
            >
              {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </div>
      )}

      {/* Extra fields (provider-specific) */}
      {meta.extraFields.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {meta.extraFields.map((f) => (
            <div key={f.key}>
              <label className="block text-xs font-medium text-gray-400 mb-1">{t(f.labelKey)}</label>
              <input
                value={extra[f.key] ?? ''}
                onChange={(e) => setExtra((prev) => ({ ...prev, [f.key]: e.target.value }))}
                placeholder={f.placeholder}
                className="w-full px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm
                  text-gray-100 placeholder-gray-600 focus:outline-none focus:border-blue-500
                  transition-colors font-mono"
              />
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between pt-1">
        {msg && (
          <span className={`text-xs flex items-center gap-1.5 ${msg.ok ? 'text-emerald-400' : 'text-red-400'}`}>
            {msg.ok ? <CheckCircle size={13} /> : <XCircle size={13} />}
            {msg.text}
          </span>
        )}
        <div className="ml-auto">
          <button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
            className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 hover:bg-blue-500
              disabled:opacity-50 text-white text-sm rounded-lg transition-colors"
          >
            {mutation.isPending ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            {t('common:actions.save')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Card: collection management ─────────────────────────────────────────────────
function VectorCollectionsCard() {
  const { t } = useTranslation('settings');
  const qc = useQueryClient();
  const { data: collections = [], isLoading } = useQuery({
    queryKey: ['vector-collections'],
    queryFn:  vectorDbApi.listCollections,
    staleTime: 30_000,
  });

  // Create/edit collection form state
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formName, setFormName]   = useState('');
  const [formDesc, setFormDesc]   = useState('');
  const [formDefault, setFormDefault] = useState(false);
  const [formCreateTool, setFormCreateTool] = useState(true);
  const [formMsg, setFormMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const openCreate = () => {
    setEditingId(null);
    setFormName('');
    setFormDesc('');
    setFormDefault(collections.length === 0);
    setFormCreateTool(true);
    setFormMsg(null);
    setShowForm(true);
  };

  const openEdit = (col: VectorCollection) => {
    setEditingId(col.id);
    setFormName(col.name);
    setFormDesc(col.description ?? '');
    setFormDefault(col.isDefault);
    setFormMsg(null);
    setShowForm(true);
  };

  const closeForm = () => { setShowForm(false); setEditingId(null); };

  const saveMutation = useMutation({
    mutationFn: () => editingId
      ? vectorDbApi.updateCollection(editingId, { name: formName.trim(), description: formDesc.trim() || null, isDefault: formDefault })
      : vectorDbApi.createCollection({ name: formName.trim(), description: formDesc.trim() || null, isDefault: formDefault, createSearchTool: formCreateTool }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['vector-collections'] });
      setFormMsg({ ok: true, text: editingId ? t('vectordb.collectionUpdatedOk') : t('vectordb.collectionCreatedOk') });
      setTimeout(() => { closeForm(); setFormMsg(null); }, 1200);
    },
    onError: (e: any) => setFormMsg({ ok: false, text: e?.response?.data?.message ?? t('vectordb.errorGeneric') }),
  });

  const setDefaultMutation = useMutation({
    mutationFn: (id: string) => vectorDbApi.setDefault(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vector-collections'] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => vectorDbApi.deleteCollection(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vector-collections'] }),
    onError: (e: any) => alert(e?.response?.data?.message ?? 'Deletion error'),
  });

  const clearMutation = useMutation({
    mutationFn: (name: string) => vectorDbApi.clearCollection(name),
    onError: (e: any) => alert(e?.response?.data?.message ?? 'Error clearing collection'),
  });

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FileStack size={15} className="text-indigo-400" />
          <h3 className="text-sm font-semibold text-gray-100">{t('vectordb.collectionsTitle')}</h3>
        </div>
        <button
          onClick={openCreate}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-indigo-600 hover:bg-indigo-500
            text-white rounded-lg transition-colors"
        >
          <Plus size={12} /> {t('vectordb.collectionsNewBtn')}
        </button>
      </div>
      <p className="text-sm text-gray-500">
        {t('vectordb.collectionsSubtitle')}
      </p>

      {/* Collection list */}
      {isLoading && (
        <div className="flex items-center gap-2 text-gray-500 text-sm py-2">
          <Loader2 size={14} className="animate-spin" /> {t('vectordb.loading')}
        </div>
      )}

      {!isLoading && collections.length === 0 && (
        <p className="text-sm text-gray-600 italic py-2">
          {t('vectordb.collectionsEmpty')}
        </p>
      )}

      {collections.length > 0 && (
        <ul className="space-y-2">
          {collections.map((col) => (
            <CollectionRow
              key={col.id}
              col={col}
              onEdit={() => openEdit(col)}
              onSetDefault={() => setDefaultMutation.mutate(col.id)}
              onDelete={() => deleteMutation.mutate(col.id)}
              onClear={() => clearMutation.mutate(col.name)}
              isSettingDefault={setDefaultMutation.isPending}
              isDeleting={deleteMutation.isPending}
              isClearing={clearMutation.isPending}
            />
          ))}
        </ul>
      )}

      {/* Form inline (create / edit) */}
      {showForm && (
        <div className="mt-4 border border-gray-700 rounded-xl p-4 space-y-3 bg-gray-800/50">
          <h4 className="text-xs font-semibold text-gray-300 uppercase tracking-wider">
            {editingId ? t('vectordb.collectionFormEdit') : t('vectordb.collectionFormCreate')}
          </h4>

          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">{t('vectordb.collectionNameLabel')}</label>
            <input
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder={t('vectordb.collectionNamePlaceholder')}
              className="w-full px-3 py-1.5 bg-gray-700 border border-gray-600 rounded-lg text-sm
                text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500
                transition-colors font-mono"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">{t('vectordb.collectionDescLabel')}</label>
            <input
              value={formDesc}
              onChange={(e) => setFormDesc(e.target.value)}
              placeholder={t('vectordb.collectionDescPlaceholder')}
              className="w-full px-3 py-1.5 bg-gray-700 border border-gray-600 rounded-lg text-sm
                text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500
                transition-colors"
            />
          </div>

          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={formDefault}
              onChange={(e) => setFormDefault(e.target.checked)}
              className="w-4 h-4 rounded border-gray-600 bg-gray-700 text-indigo-500
                focus:ring-indigo-500 focus:ring-offset-0"
            />
            <span className="text-sm text-gray-300">{t('vectordb.collectionSetDefault')}</span>
          </label>

          {/* Auto search tool: only on creation — an existing collection may already have its tool */}
          {!editingId && (
            <label className="flex items-start gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={formCreateTool}
                onChange={(e) => setFormCreateTool(e.target.checked)}
                className="w-4 h-4 mt-0.5 rounded border-gray-600 bg-gray-700 text-indigo-500
                  focus:ring-indigo-500 focus:ring-offset-0"
              />
              <span className="text-sm text-gray-300">
                {t('vectordb.collectionCreateSearchTool')}
                <span className="block text-xs text-gray-500">{t('vectordb.collectionCreateSearchToolHint')}</span>
              </span>
            </label>
          )}

          <div className="flex items-center justify-between pt-1">
            {formMsg && (
              <span className={`text-xs flex items-center gap-1.5 ${formMsg.ok ? 'text-emerald-400' : 'text-red-400'}`}>
                {formMsg.ok ? <CheckCircle size={13} /> : <XCircle size={13} />}
                {formMsg.text}
              </span>
            )}
            <div className="ml-auto flex items-center gap-2">
              <button
                onClick={closeForm}
                className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200 transition-colors"
              >
                {t('common:actions.cancel')}
              </button>
              <button
                onClick={() => saveMutation.mutate()}
                disabled={saveMutation.isPending || !formName.trim()}
                className="flex items-center gap-1.5 px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500
                  disabled:opacity-50 text-white text-xs rounded-lg transition-colors"
              >
                {saveMutation.isPending
                  ? <Loader2 size={12} className="animate-spin" />
                  : <Save size={12} />}
                {t('common:actions.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Single collection row ─────────────────────────────────────────────────────
function CollectionRow({
  col, onEdit, onSetDefault, onDelete, onClear,
  isSettingDefault, isDeleting, isClearing,
}: {
  col: VectorCollection;
  onEdit: () => void;
  onSetDefault: () => void;
  onDelete: () => void;
  onClear: () => void;
  isSettingDefault: boolean;
  isDeleting: boolean;
  isClearing: boolean;
}) {
  const { t } = useTranslation('settings');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmClear,  setConfirmClear]  = useState(false);

  return (
    <li className="flex items-center gap-3 px-3 py-2.5 bg-gray-800/60 rounded-lg border border-gray-700/50">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-mono text-gray-100 truncate">{col.name}</span>
          {col.isDefault && (
            <span className="flex items-center gap-1 px-1.5 py-0.5 text-xs bg-indigo-900/60
              border border-indigo-700/50 text-indigo-300 rounded-md">
              <Star size={10} /> {t('vectordb.collectionDefaultBadge')}
            </span>
          )}
        </div>
        {col.description && (
          <p className="text-xs text-gray-500 mt-0.5 truncate">{col.description}</p>
        )}
      </div>

      <div className="flex items-center gap-1 flex-shrink-0">
        {/* Set as default */}
        {!col.isDefault && (
          <button
            onClick={onSetDefault}
            disabled={isSettingDefault}
            title={t('vectordb.collectionSetDefaultTitle')}
            className="p-1.5 text-gray-500 hover:text-indigo-400 rounded transition-colors disabled:opacity-50"
          >
            <Star size={14} />
          </button>
        )}

        {/* Clear vectors */}
        {confirmClear ? (
          <div className="flex items-center gap-1">
            <span className="text-xs text-amber-400 mr-1">{t('vectordb.collectionClearConfirmQuestion')}</span>
            <button
              onClick={() => { onClear(); setConfirmClear(false); }}
              disabled={isClearing}
              className="px-2 py-1 text-xs bg-amber-600 hover:bg-amber-500 text-white rounded transition-colors disabled:opacity-50"
            >
              {isClearing ? <Loader2 size={11} className="animate-spin" /> : t('vectordb.collectionClearConfirmYes')}
            </button>
            <button
              onClick={() => setConfirmClear(false)}
              className="px-2 py-1 text-xs text-gray-500 hover:text-gray-300 rounded transition-colors"
            >
              {t('vectordb.collectionClearConfirmNo')}
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmClear(true)}
            title={t('vectordb.collectionClearTitle')}
            className="p-1.5 text-gray-500 hover:text-amber-400 rounded transition-colors"
          >
            <Eraser size={13} />
          </button>
        )}

        {/* Edit */}
        <button
          onClick={onEdit}
          title={t('vectordb.collectionEditTitle')}
          className="p-1.5 text-gray-500 hover:text-gray-300 rounded transition-colors"
        >
          <Pencil size={13} />
        </button>

        {/* Delete */}
        {confirmDelete ? (
          <div className="flex items-center gap-1">
            <button
              onClick={() => { onDelete(); setConfirmDelete(false); }}
              disabled={isDeleting}
              className="px-2 py-1 text-xs bg-red-600 hover:bg-red-500 text-white rounded transition-colors"
            >
              {t('vectordb.collectionDeleteConfirmYes')}
            </button>
            <button
              onClick={() => setConfirmDelete(false)}
              className="px-2 py-1 text-xs text-gray-500 hover:text-gray-300 rounded transition-colors"
            >
              {t('vectordb.collectionDeleteConfirmNo')}
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmDelete(true)}
            className="p-1.5 text-gray-500 hover:text-red-400 rounded transition-colors"
            title={t('vectordb.collectionDeleteTitle')}
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
    </li>
  );
}

// ── Embedding provider metadata ─────────────────────────────────────────────────
const EMBEDDING_PROVIDERS: {
  value:         EmbeddingProvider;
  label:         string;
  descKey:       string;
  needsKey:      boolean;
  needsUrl:      boolean;
  defaultModels: string[];
  defaultUrl?:   string;
  internal?:     boolean;
}[] = [
  {
    value:         'internal',
    label:         'Interno (default)',
    descKey:       'vectordb.embeddingProviderInternalDesc',
    needsKey:      false,
    needsUrl:      false,
    defaultModels: [],
    internal:      true,
  },
  {
    value:         'openai',
    label:         'OpenAI',
    descKey:       'vectordb.embeddingProviderOpenAiDesc',
    needsKey:      true,
    needsUrl:      false,
    defaultModels: ['text-embedding-3-small', 'text-embedding-3-large', 'text-embedding-ada-002'],
  },
  {
    value:         'voyage',
    label:         'VoyageAI',
    descKey:       'vectordb.embeddingProviderVoyageDesc',
    needsKey:      true,
    needsUrl:      false,
    defaultModels: ['voyage-multilingual-2', 'voyage-3', 'voyage-3-lite', 'voyage-finance-2'],
  },
  {
    value:         'ollama',
    label:         'Ollama (locale)',
    descKey:       'vectordb.embeddingProviderOllamaDesc',
    needsKey:      false,
    needsUrl:      true,
    defaultModels: ['nomic-embed-text', 'mxbai-embed-large', 'all-minilm', 'snowflake-arctic-embed2'],
    defaultUrl:    'http://localhost:11434',
  },
  {
    value:         'lmstudio',
    label:         'LM Studio (locale)',
    descKey:       'vectordb.embeddingProviderLmStudioDesc',
    needsKey:      false,
    needsUrl:      true,
    defaultModels: ['nomic-embed-text', 'text-embedding-nomic-embed-text-v1.5'],
    defaultUrl:    'http://localhost:1234/v1',
  },
  {
    value:         'openai-compatible',
    label:         'OpenAI-compatibile',
    descKey:       'vectordb.embeddingProviderOpenAiCompatDesc',
    needsKey:      false,
    needsUrl:      true,
    defaultModels: [],
    defaultUrl:    'http://localhost:1234/v1',
  },
];

// ── Card: active collection selection ──────────────────────────────────────────
function ActiveCollectionCard() {
  const { t } = useTranslation('settings');
  const qc = useQueryClient();

  const { data: collections = [], isLoading } = useQuery({
    queryKey: ['vector-collections'],
    queryFn:  vectorDbApi.listCollections,
    staleTime: 30_000,
  });

  const defaultCol    = collections.find((c) => c.isDefault);
  const [selectedId, setSelectedId]   = useState<string>('');
  const [showWarning, setShowWarning] = useState(false);
  const [msg, setMsg]                 = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (defaultCol && !selectedId) setSelectedId(defaultCol.id);
  }, [defaultCol]);

  const changed = selectedId && selectedId !== defaultCol?.id;

  const mutation = useMutation({
    mutationFn: () => vectorDbApi.setDefault(selectedId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['vector-collections'] });
      setMsg({ ok: true, text: t('vectordb.activeCollectionUpdatedOk') });
      setShowWarning(false);
      setTimeout(() => setMsg(null), 3000);
    },
    onError: (e: any) => setMsg({ ok: false, text: e?.response?.data?.message ?? t('vectordb.errorGeneric') }),
  });

  const handleChange = (id: string) => {
    setSelectedId(id);
    if (id !== defaultCol?.id) setShowWarning(true);
    else setShowWarning(false);
  };

  if (collections.length === 0 && !isLoading) return null;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
      <div className="flex items-center gap-2">
        <Star size={15} className="text-amber-400" />
        <h3 className="text-sm font-semibold text-gray-100">{t('vectordb.activeCollectionTitle')}</h3>
      </div>
      <p className="text-sm text-gray-500">
        {t('vectordb.activeCollectionSubtitle')}
      </p>

      {isLoading ? (
        <div className="flex items-center gap-2 text-gray-500 text-sm">
          <Loader2 size={14} className="animate-spin" /> {t('vectordb.loading')}
        </div>
      ) : (
        <div className="space-y-3">
          <select
            value={selectedId}
            onChange={(e) => handleChange(e.target.value)}
            className="w-full px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm
              text-gray-100 focus:outline-none focus:border-indigo-500 transition-colors"
          >
            {collections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}{c.isDefault ? ' ★' : ''}
                {c.description ? ` — ${c.description}` : ''}
              </option>
            ))}
          </select>

          {/* Re-indexing warning */}
          {showWarning && (
            <div className="flex items-start gap-2 px-3 py-2.5 bg-amber-900/20 border border-amber-700/40 rounded-lg">
              <span className="text-amber-400 mt-0.5 flex-shrink-0">⚠️</span>
              <p className="text-xs text-amber-300 leading-relaxed">
                <strong>{t('vectordb.activeCollectionWarningTitle')}</strong>{' '}
                {t('vectordb.activeCollectionWarningBody')}
              </p>
            </div>
          )}

          <div className="flex items-center justify-between">
            {msg && (
              <span className={`text-xs flex items-center gap-1.5 ${msg.ok ? 'text-emerald-400' : 'text-red-400'}`}>
                {msg.ok ? <CheckCircle size={13} /> : <XCircle size={13} />}
                {msg.text}
              </span>
            )}
            {changed && (
              <div className="ml-auto">
                <button
                  onClick={() => mutation.mutate()}
                  disabled={mutation.isPending}
                  className="flex items-center gap-1.5 px-4 py-1.5 bg-amber-600 hover:bg-amber-500
                    disabled:opacity-50 text-white text-sm rounded-lg transition-colors"
                >
                  {mutation.isPending ? <Loader2 size={13} className="animate-spin" /> : <Star size={13} />}
                  {t('vectordb.activeCollectionApply')}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Card: embedding configuration ─────────────────────────────────────────────
function EmbeddingConfigCard() {
  const { t } = useTranslation('settings');
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['embedding-config'],
    queryFn:  appConfigApi.getEmbeddingConfig,
    staleTime: 60_000,
  });

  // Local form state
  const [provider,    setProvider]    = useState<EmbeddingProvider>('lmstudio');
  const [model,       setModel]       = useState('');
  const [apiKey,      setApiKey]      = useState('');
  const [baseUrl,     setBaseUrl]     = useState('');
  const [vectorSize,  setVectorSize]  = useState('1024');
  const [queryPrefix, setQueryPrefix] = useState('');
  const [chunkSize,   setChunkSize]   = useState('500');
  const [chunkOverlap, setChunkOverlap] = useState('50');
  const [showKey,     setShowKey]     = useState(false);
  const [msg,         setMsg]         = useState<{ ok: boolean; text: string } | null>(null);
  const [testState,   setTestState]   = useState<'idle' | 'pending' | 'ok' | 'error'>('idle');
  const [testError,   setTestError]   = useState('');
  const [detected,    setDetected]    = useState<{ model?: string; dims?: number } | null>(null);

  const providerMeta = EMBEDDING_PROVIDERS.find((p) => p.value === provider)!;

  // Populate the form with values from the DB
  useEffect(() => {
    if (!data) return;
    setProvider(data.embeddingProvider);
    setModel(data.embeddingModel ?? '');
    setBaseUrl(data.embeddingBaseUrl ?? '');
    setVectorSize(String(data.embeddingVectorSize));
    setQueryPrefix(data.embeddingQueryPrefix ?? '');
    setChunkSize(String(data.embeddingChunkSize));
    setChunkOverlap(String(data.embeddingChunkOverlap));
  }, [data]);

  // When the provider changes: update the default URL
  useEffect(() => {
    const meta = EMBEDDING_PROVIDERS.find((p) => p.value === provider);
    if (meta?.defaultUrl && !baseUrl) setBaseUrl(meta.defaultUrl);
  }, [provider]);

  const saveMutation = useMutation({
    mutationFn: () => appConfigApi.updateEmbeddingConfig({
      embeddingProvider:    provider,
      embeddingModel:       model || null,
      embeddingApiKey:      apiKey || undefined, // undefined = don't touch the key
      embeddingBaseUrl:     baseUrl || null,
      embeddingVectorSize:  parseInt(vectorSize, 10) || 1024,
      embeddingQueryPrefix: queryPrefix || null,
      embeddingChunkSize:   parseInt(chunkSize, 10) || 500,
      embeddingChunkOverlap: parseInt(chunkOverlap, 10) || 50,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['embedding-config'] });
      setApiKey('');  // clear the key field after saving
      setMsg({ ok: true, text: t('vectordb.embeddingSavedOk') });
      setTimeout(() => setMsg(null), 3000);
    },
    onError: (e: any) => setMsg({ ok: false, text: e?.response?.data?.message ?? t('vectordb.errorGeneric') }),
  });

  const handleTest = async () => {
    setTestState('pending');
    setTestError('');
    try {
      const result = await appConfigApi.testEmbeddingConnection();
      setTestState(result.ok ? 'ok' : 'error');
      if (result.ok) setDetected({ model: result.model, dims: result.dims });
      else setTestError(result.error ?? t('vectordb.embeddingConnectionFailed'));
    } catch (e: any) {
      setTestState('error');
      setTestError(e?.response?.data?.message ?? t('vectordb.errorGeneric'));
    }
    setTimeout(() => setTestState('idle'), 5000);
  };

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-5">
      <div className="flex items-center gap-2">
        <BrainCircuit size={15} className="text-indigo-400" />
        <h3 className="text-sm font-semibold text-gray-100">{t('vectordb.embeddingTitle')}</h3>
      </div>
      <p className="text-sm text-gray-500">
        {t('vectordb.embeddingSubtitle')}
      </p>

      {isLoading && (
        <div className="flex items-center gap-2 text-gray-500 text-sm">
          <Loader2 size={14} className="animate-spin" /> {t('vectordb.loading')}
        </div>
      )}

      {/* ── Provider ── */}
      <div>
        <label className="block text-xs font-medium text-gray-400 mb-1.5">{t('vectordb.embeddingProviderLabel')}</label>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {EMBEDDING_PROVIDERS.map((p) => (
            <button
              key={p.value}
              onClick={() => setProvider(p.value)}
              className={`flex flex-col items-start px-3 py-2.5 rounded-lg border text-left transition-colors
                ${provider === p.value
                  ? 'border-indigo-500 bg-indigo-900/30 text-white'
                  : 'border-gray-700 bg-gray-800/50 text-gray-400 hover:border-gray-600 hover:text-gray-300'}`}
            >
              <span className="text-sm font-medium">{p.label}</span>
              <span className="text-xs mt-0.5 opacity-70">{t(p.descKey)}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ── Internal service info box (auto-configured) ── */}
      {providerMeta.internal && (
        <div className="flex items-start gap-2.5 bg-indigo-900/40 border border-indigo-800/50 rounded-lg px-3.5 py-3">
          <BrainCircuit size={15} className="text-indigo-400 flex-shrink-0 mt-0.5" />
          <div className="text-xs text-gray-400 leading-relaxed">
            <p className="text-gray-300 font-medium mb-0.5">{t('vectordb.embeddingInternalInfoTitle')}</p>
            <p>{t('vectordb.embeddingInternalInfoDesc')}</p>
            {detected?.model && (
              <p className="mt-1 text-emerald-400 font-mono">
                {detected.model}{detected.dims ? ` · ${detected.dims} dims` : ''}
              </p>
            )}
          </div>
        </div>
      )}

      {/* ── Model ── */}
      {!providerMeta.internal && (
      <div>
        <label className="block text-xs font-medium text-gray-400 mb-1">{t('vectordb.embeddingModelLabel')}</label>
        {providerMeta.defaultModels.length > 0 ? (
          <div className="space-y-1.5">
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={`es. ${providerMeta.defaultModels[0]}`}
              list={`models-${provider}`}
              className="w-full px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm
                text-gray-100 placeholder-gray-600 focus:outline-none focus:border-blue-500
                transition-colors font-mono"
            />
            <datalist id={`models-${provider}`}>
              {providerMeta.defaultModels.map((m) => <option key={m} value={m} />)}
            </datalist>
            <div className="flex flex-wrap gap-1.5 mt-1">
              {providerMeta.defaultModels.map((m) => (
                <button
                  key={m}
                  onClick={() => setModel(m)}
                  className={`px-2 py-0.5 text-xs rounded border transition-colors
                    ${model === m
                      ? 'border-indigo-500 bg-indigo-900/40 text-indigo-300'
                      : 'border-gray-700 text-gray-500 hover:border-gray-600 hover:text-gray-400'}`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={t('vectordb.embeddingModelPlaceholder')}
            className="w-full px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm
              text-gray-100 placeholder-gray-600 focus:outline-none focus:border-blue-500
              transition-colors font-mono"
          />
        )}
      </div>
      )}

      {/* ── API Key (cloud only) ── */}
      {providerMeta.needsKey && (
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">
            {t('vectordb.embeddingApiKeyLabel')}
            {data?.hasEmbeddingApiKey && (
              <span className="ml-2 text-emerald-500 font-normal">✓ {t('vectordb.embeddingApiKeyConfigured')}</span>
            )}
          </label>
          <div className="relative">
            <input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={data?.hasEmbeddingApiKey ? t('vectordb.embeddingApiKeyKeepPlaceholder') : t('llm.apiKeyPastePlaceholder')}
              className="w-full px-3 py-1.5 pr-9 bg-gray-800 border border-gray-700 rounded-lg text-sm
                text-gray-100 placeholder-gray-600 focus:outline-none focus:border-blue-500
                transition-colors font-mono"
            />
            <button
              type="button"
              onClick={() => setShowKey((p) => !p)}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
            >
              {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </div>
      )}

      {/* ── Base URL (local / compatible) ── */}
      {providerMeta.needsUrl && (
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">{t('vectordb.embeddingBaseUrlLabel')}</label>
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={providerMeta.defaultUrl ?? 'http://localhost:1234/v1'}
            className="w-full px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm
              text-gray-100 placeholder-gray-600 focus:outline-none focus:border-blue-500
              transition-colors font-mono"
          />
        </div>
      )}

      {/* ── Vector & chunking parameters ── */}
      <div className="border-t border-gray-800 pt-4">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
          {t('vectordb.embeddingVectorParamsLabel')}
        </p>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {/* Vector Size — auto-detected for the internal provider */}
          {!providerMeta.internal && (
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">
              {t('vectordb.embeddingVectorSizeLabel')}
              <span className="ml-1 text-gray-600 font-normal">(dims)</span>
            </label>
            <input
              type="number"
              value={vectorSize}
              onChange={(e) => setVectorSize(e.target.value)}
              min={1}
              className="w-full px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm
                text-gray-100 focus:outline-none focus:border-blue-500 transition-colors"
            />
          </div>
          )}

          {/* Chunk Size */}
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">
              {t('vectordb.embeddingChunkSizeLabel')}
              <span className="ml-1 text-gray-600 font-normal">(char)</span>
            </label>
            <input
              type="number"
              value={chunkSize}
              onChange={(e) => setChunkSize(e.target.value)}
              min={100}
              max={10000}
              className="w-full px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm
                text-gray-100 focus:outline-none focus:border-blue-500 transition-colors"
            />
          </div>

          {/* Chunk Overlap */}
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">
              {t('vectordb.embeddingOverlapLabel')}
              <span className="ml-1 text-gray-600 font-normal">(char)</span>
            </label>
            <input
              type="number"
              value={chunkOverlap}
              onChange={(e) => setChunkOverlap(e.target.value)}
              min={0}
              max={5000}
              className="w-full px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm
                text-gray-100 focus:outline-none focus:border-blue-500 transition-colors"
            />
          </div>

          {/* Query Prefix */}
          <div className="sm:col-span-4">
            <label className="block text-xs font-medium text-gray-400 mb-1">
              {t('vectordb.embeddingQueryPrefixLabel')}
              <span className="ml-1 text-gray-600 font-normal">({t('vectordb.embeddingQueryPrefixOptional')})</span>
            </label>
            <input
              value={queryPrefix}
              onChange={(e) => setQueryPrefix(e.target.value)}
              placeholder={t('vectordb.embeddingQueryPrefixPlaceholder')}
              className="w-full px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm
                text-gray-100 placeholder-gray-600 focus:outline-none focus:border-blue-500
                transition-colors font-mono"
            />
            {/* An empty field is not "no prefix" for the internal service: there the model
                declares its own query prompt. Say so, otherwise the field reads as unset. */}
            <p className="text-xs text-gray-600 mt-1">
              {provider === 'internal'
                ? t('vectordb.embeddingQueryPrefixHintInternal')
                : t('vectordb.embeddingQueryPrefixHint')}
            </p>
          </div>
        </div>
      </div>

      {/* ── Actions ── */}
      <div className="flex items-center justify-between pt-1">
        <div className="flex items-center gap-2">
          {/* Test state */}
          {testState === 'pending' && (
            <span className="text-xs text-gray-400 flex items-center gap-1.5">
              <Loader2 size={12} className="animate-spin" /> {t('vectordb.embeddingTestPending')}
            </span>
          )}
          {testState === 'ok' && (
            <span className="text-xs text-emerald-400 flex items-center gap-1.5">
              <Wifi size={13} /> {t('vectordb.embeddingTestOk')}
            </span>
          )}
          {testState === 'error' && (
            <span className="text-xs text-red-400 flex items-center gap-1.5">
              <WifiOff size={13} /> {testError || t('vectordb.embeddingConnectionFailed')}
            </span>
          )}
          {msg && testState === 'idle' && (
            <span className={`text-xs flex items-center gap-1.5 ${msg.ok ? 'text-emerald-400' : 'text-red-400'}`}>
              {msg.ok ? <CheckCircle size={13} /> : <XCircle size={13} />}
              {msg.text}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleTest}
            disabled={testState === 'pending'}
            className="flex items-center gap-1.5 px-3 py-1.5 border border-gray-700 hover:border-gray-600
              text-gray-300 hover:text-white text-sm rounded-lg transition-colors disabled:opacity-50"
          >
            {testState === 'pending'
              ? <Loader2 size={13} className="animate-spin" />
              : testState === 'ok'
              ? <Wifi size={13} className="text-emerald-400" />
              : <Wifi size={13} />}
            {t('vectordb.embeddingTestBtn')}
          </button>
          <button
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
            className="flex items-center gap-1.5 px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500
              disabled:opacity-50 text-white text-sm rounded-lg transition-colors"
          >
            {saveMutation.isPending ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            {t('common:actions.save')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Transcription provider metadata (Whisper) ──────────────────────────────────
const TRANSCRIPTION_PROVIDERS: {
  value:         TranscriptionProvider;
  label:         string;
  descKey:       string;
  needsKey:      boolean;
  needsUrl:      boolean;
  defaultUrl?:   string;
  defaultModels: string[];
  internal?:     boolean;
}[] = [
  {
    value: 'internal', label: 'Interno (default)',
    descKey: 'transcription.providerInternalDesc',
    needsKey: false, needsUrl: false,
    defaultModels: [], internal: true,
  },
  {
    value: 'openai', label: 'OpenAI',
    descKey: 'transcription.providerOpenAiDesc',
    needsKey: true, needsUrl: false,
    defaultModels: ['whisper-1', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe'],
  },
  {
    value: 'groq', label: 'Groq',
    descKey: 'transcription.providerGroqDesc',
    needsKey: true, needsUrl: true, defaultUrl: 'https://api.groq.com/openai/v1',
    defaultModels: ['whisper-large-v3', 'whisper-large-v3-turbo'],
  },
  {
    value: 'openai-compatible', label: 'Self-hosted',
    descKey: 'transcription.providerCompatDesc',
    needsKey: false, needsUrl: true, defaultUrl: 'http://localhost:9000/v1',
    defaultModels: ['whisper-1', 'Systran/faster-whisper-large-v3'],
  },
];

// ── Card: voice transcription configuration (Whisper) ──────────────────────────
function TranscriptionConfigCard() {
  const { t } = useTranslation('settings');
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['transcription-config'],
    queryFn:  appConfigApi.getTranscriptionConfig,
    staleTime: 60_000,
  });

  const [enabled,  setEnabled]  = useState(false);
  const [provider, setProvider] = useState<TranscriptionProvider>('openai');
  const [model,    setModel]    = useState('');
  const [apiKey,   setApiKey]   = useState('');
  const [baseUrl,  setBaseUrl]  = useState('');
  const [showKey,  setShowKey]  = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [testState, setTestState] = useState<'idle' | 'pending' | 'ok' | 'error'>('idle');
  const [testError, setTestError] = useState('');
  const [detectedModel, setDetectedModel] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    setEnabled(data.transcriptionEnabled);
    setProvider(data.transcriptionProvider);
    setModel(data.transcriptionModel ?? '');
    setBaseUrl(data.transcriptionBaseUrl ?? '');
  }, [data]);

  // Provider change: pre-populate the default URL if empty
  useEffect(() => {
    const meta = TRANSCRIPTION_PROVIDERS.find((p) => p.value === provider);
    if (meta?.defaultUrl && !baseUrl) setBaseUrl(meta.defaultUrl);
  }, [provider]);

  const providerMeta = TRANSCRIPTION_PROVIDERS.find((p) => p.value === provider)!;

  const saveMutation = useMutation({
    mutationFn: () => appConfigApi.updateTranscriptionConfig({
      transcriptionEnabled:  enabled,
      transcriptionProvider: provider,
      transcriptionModel:    model || null,
      transcriptionApiKey:   apiKey || undefined,   // undefined = don't touch the key
      transcriptionBaseUrl:  baseUrl || null,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['transcription-config'] });
      setApiKey('');
      setMsg({ ok: true, text: t('transcription.savedOk') });
      setTimeout(() => setMsg(null), 3000);
    },
    onError: (e: any) => setMsg({ ok: false, text: e?.response?.data?.message ?? t('vectordb.errorGeneric') }),
  });

  const handleTest = async () => {
    setTestState('pending');
    setTestError('');
    try {
      const result = await appConfigApi.testTranscriptionConnection();
      setTestState(result.ok ? 'ok' : 'error');
      if (result.ok) setDetectedModel(result.model ?? null);
      else setTestError(result.error ?? t('transcription.connectionFailed'));
    } catch (e: any) {
      setTestState('error');
      setTestError(e?.response?.data?.message ?? t('vectordb.errorGeneric'));
    }
    setTimeout(() => setTestState('idle'), 5000);
  };

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-5">
      <div className="flex items-center gap-2">
        <Mic size={15} className="text-indigo-400" />
        <h3 className="text-sm font-semibold text-gray-100">{t('transcription.title')}</h3>
      </div>
      <p className="text-sm text-gray-500">{t('transcription.subtitle')}</p>

      {isLoading && (
        <div className="flex items-center gap-2 text-gray-500 text-sm">
          <Loader2 size={14} className="animate-spin" /> {t('vectordb.loading')}
        </div>
      )}

      {/* ── Enable toggle ── */}
      <label className="flex items-center justify-between gap-3 cursor-pointer">
        <div>
          <span className="text-sm font-medium text-gray-200">{t('transcription.enableLabel')}</span>
          <p className="text-xs text-gray-500 mt-0.5">{t('transcription.enableDesc')}</p>
        </div>
        <button
          type="button"
          onClick={() => setEnabled((v) => !v)}
          className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition-colors
            ${enabled ? 'bg-indigo-600' : 'bg-gray-700'}`}
        >
          <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform mt-0.5
            ${enabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
        </button>
      </label>

      {/* ── Provider ── */}
      <div>
        <label className="block text-xs font-medium text-gray-400 mb-1.5">{t('transcription.providerLabel')}</label>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {TRANSCRIPTION_PROVIDERS.map((p) => (
            <button
              key={p.value}
              onClick={() => setProvider(p.value)}
              className={`flex flex-col items-start px-3 py-2.5 rounded-lg border text-left transition-colors
                ${provider === p.value
                  ? 'border-indigo-500 bg-indigo-900/30 text-white'
                  : 'border-gray-700 bg-gray-800/50 text-gray-400 hover:border-gray-600 hover:text-gray-300'}`}
            >
              <span className="text-sm font-medium">{p.label}</span>
              <span className="text-xs mt-0.5 opacity-70">{t(p.descKey)}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ── Internal service info box (auto-configured) ── */}
      {providerMeta.internal && (
        <div className="flex items-start gap-2.5 bg-indigo-900/40 border border-indigo-800/50 rounded-lg px-3.5 py-3">
          <Mic size={15} className="text-indigo-400 flex-shrink-0 mt-0.5" />
          <div className="text-xs text-gray-400 leading-relaxed">
            <p className="text-gray-300 font-medium mb-0.5">{t('transcription.internalInfoTitle')}</p>
            <p>{t('transcription.internalInfoDesc')}</p>
            {detectedModel && (
              <p className="mt-1 text-emerald-400 font-mono">{detectedModel}</p>
            )}
          </div>
        </div>
      )}

      {/* ── Model ── */}
      {!providerMeta.internal && (
      <div>
        <label className="block text-xs font-medium text-gray-400 mb-1">{t('transcription.modelLabel')}</label>
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder={`es. ${providerMeta.defaultModels[0]}`}
          list={`transcription-models-${provider}`}
          className="w-full px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm
            text-gray-100 placeholder-gray-600 focus:outline-none focus:border-blue-500
            transition-colors font-mono"
        />
        <datalist id={`transcription-models-${provider}`}>
          {providerMeta.defaultModels.map((m) => <option key={m} value={m} />)}
        </datalist>
        <div className="flex flex-wrap gap-1.5 mt-1">
          {providerMeta.defaultModels.map((m) => (
            <button
              key={m}
              onClick={() => setModel(m)}
              className={`px-2 py-0.5 text-xs rounded border transition-colors
                ${model === m
                  ? 'border-indigo-500 bg-indigo-900/40 text-indigo-300'
                  : 'border-gray-700 text-gray-500 hover:border-gray-600 hover:text-gray-400'}`}
            >
              {m}
            </button>
          ))}
        </div>
      </div>
      )}

      {/* ── API Key (cloud) ── */}
      {providerMeta.needsKey && (
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">
            {t('transcription.apiKeyLabel')}
            {data?.hasTranscriptionApiKey && (
              <span className="ml-2 text-emerald-500 font-normal">✓ {t('transcription.apiKeyConfigured')}</span>
            )}
          </label>
          <div className="relative">
            <input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={data?.hasTranscriptionApiKey ? t('transcription.apiKeyKeepPlaceholder') : t('llm.apiKeyPastePlaceholder')}
              className="w-full px-3 py-1.5 pr-9 bg-gray-800 border border-gray-700 rounded-lg text-sm
                text-gray-100 placeholder-gray-600 focus:outline-none focus:border-blue-500
                transition-colors font-mono"
            />
            <button
              type="button"
              onClick={() => setShowKey((p) => !p)}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
            >
              {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </div>
      )}

      {/* ── Base URL (self-hosted / compatible) ── */}
      {providerMeta.needsUrl && (
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">{t('transcription.baseUrlLabel')}</label>
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={providerMeta.defaultUrl ?? 'http://localhost:9000/v1'}
            className="w-full px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm
              text-gray-100 placeholder-gray-600 focus:outline-none focus:border-blue-500
              transition-colors font-mono"
          />
        </div>
      )}

      {/* ── Actions ── */}
      <div className="flex items-center justify-between pt-1">
        <div className="flex items-center gap-2">
          {testState === 'pending' && (
            <span className="text-xs text-gray-400 flex items-center gap-1.5">
              <Loader2 size={12} className="animate-spin" /> {t('transcription.testPending')}
            </span>
          )}
          {testState === 'ok' && (
            <span className="text-xs text-emerald-400 flex items-center gap-1.5">
              <Wifi size={13} /> {t('transcription.testOk')}
            </span>
          )}
          {testState === 'error' && (
            <span className="text-xs text-red-400 flex items-center gap-1.5">
              <WifiOff size={13} /> {testError || t('transcription.connectionFailed')}
            </span>
          )}
          {msg && testState === 'idle' && (
            <span className={`text-xs flex items-center gap-1.5 ${msg.ok ? 'text-emerald-400' : 'text-red-400'}`}>
              {msg.ok ? <CheckCircle size={13} /> : <XCircle size={13} />}
              {msg.text}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleTest}
            disabled={testState === 'pending'}
            className="flex items-center gap-1.5 px-3 py-1.5 border border-gray-700 hover:border-gray-600
              text-gray-300 hover:text-white text-sm rounded-lg transition-colors disabled:opacity-50"
          >
            {testState === 'pending'
              ? <Loader2 size={13} className="animate-spin" />
              : testState === 'ok'
              ? <Wifi size={13} className="text-emerald-400" />
              : <Wifi size={13} />}
            {t('transcription.testBtn')}
          </button>
          <button
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
            className="flex items-center gap-1.5 px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500
              disabled:opacity-50 text-white text-sm rounded-lg transition-colors"
          >
            {saveMutation.isPending ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            {t('common:actions.save')}
          </button>
        </div>
      </div>
    </div>
  );
}