/**
 * @file McpServersPage.tsx
 *
 * "MCP Servers" section in the settings.
 * Allows adding, editing and deleting MCP servers.
 *
 * Transport types:
 *   http   — remote HTTP endpoint (e.g. https://mcp.tavily.com/mcp)
 *   sse    — remote Server-Sent Events
 *   local  — stdio process spawned directly by the NestJS backend (same machine)
 *   remote — stdio process on the user's machine, proxied via the Electron bridge
 */
import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus, Trash2, Globe, Wifi, Monitor, HardDrive, CheckCircle2,
  XCircle, Loader2, Eye, EyeOff, ChevronDown, ChevronUp,
  Download, RefreshCw, AlertCircle, ArrowLeft, X, Save, Copy, Check, Link2,
} from 'lucide-react';
import { mcpServersApi, type McpServer, type CreateMcpServerPayload } from '../api/mcpServers';
import { useStore } from '../store/useStore';
import { detectBridgeOS, bridgeOSLabel, bridgeReleasesUrl } from '../utils/bridgeDownload';

// ── Form types ─────────────────────────────────────────────────────────────────

interface KvEntry { key: string; value: string }

interface FormState {
  name: string;
  description: string;
  transport: 'http' | 'sse' | 'local' | 'remote';
  url: string;
  command: string;
  args: string;       // space-separated
  headers: KvEntry[];
  env: KvEntry[];
  secrets: KvEntry[];
  loadOnFirst: boolean;
}

const emptyForm = (): FormState => ({
  name: '', description: '', transport: 'http',
  url: '', command: '', args: '',
  headers: [], env: [], secrets: [],
  loadOnFirst: true,
});

function serverToForm(s: McpServer): FormState {
  return {
    name:        s.name,
    description: s.description ?? '',
    transport:   s.transport,
    url:         s.url ?? '',
    command:     s.command ?? '',
    args:        (s.args ?? []).join(' '),
    headers:     Object.entries(s.headers ?? {}).map(([key, value]) => ({ key, value })),
    env:         Object.entries(s.env ?? {}).map(([key, value]) => ({ key, value })),
    secrets:     (s.secrets ?? []).map((sec) => ({ key: sec.keyName, value: '' })),
    loadOnFirst: s.loadOnFirst ?? true,
  };
}

function formToPayload(form: FormState): CreateMcpServerPayload {
  const headers = Object.fromEntries(
    form.headers.filter((e) => e.key).map((e) => [e.key, e.value]),
  );
  const env = Object.fromEntries(
    form.env.filter((e) => e.key).map((e) => [e.key, e.value]),
  );
  const secrets = Object.fromEntries(
    form.secrets.filter((e) => e.key && e.value).map((e) => [e.key, e.value]),
  );

  return {
    name:        form.name.trim(),
    description: form.description.trim() || undefined,
    transport:   form.transport,
    url:         form.url.trim() || undefined,
    command:     form.command.trim() || undefined,
    args:        form.args.trim() ? form.args.trim().split(/\s+/) : undefined,
    headers:     Object.keys(headers).length ? headers : undefined,
    env:         Object.keys(env).length ? env : undefined,
    secrets:     Object.keys(secrets).length ? secrets : undefined,
    loadOnFirst: form.loadOnFirst,
  };
}

// ── Transport icons ───────────────────────────────────────────────────────

const TRANSPORT_META = {
  http:   { Icon: Globe,      label: 'HTTP',   color: 'text-blue-400',    bg: 'bg-blue-500/10'    },
  sse:    { Icon: Wifi,       label: 'SSE',    color: 'text-violet-400',  bg: 'bg-violet-500/10'  },
  local:  { Icon: HardDrive,  label: 'Local',  color: 'text-teal-400',    bg: 'bg-teal-500/10'    },
  remote: { Icon: Monitor,    label: 'Remote', color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
};

// ── Helper components ─────────────────────────────────────────────────────────

function Label({ children }: { children: React.ReactNode }) {
  return <label className="block text-xs font-medium text-gray-400 mb-1">{children}</label>;
}

function Input({ className = '', ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`w-full px-3 py-1.5 bg-gray-900 border border-gray-700 rounded-lg text-sm text-gray-100
        placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors ${className}`}
      {...props}
    />
  );
}

function Textarea({ className = '', ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={`w-full px-3 py-1.5 bg-gray-900 border border-gray-700 rounded-lg text-sm text-gray-100
        placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors resize-none ${className}`}
      {...props}
    />
  );
}

function KvEditor({
  entries,
  onChange,
  keyPlaceholder = 'key',
  valuePlaceholder = 'value',
  secret = false,
}: {
  entries: KvEntry[];
  onChange: (entries: KvEntry[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  secret?: boolean;
}) {
  const [showValues, setShowValues] = useState<Record<number, boolean>>({});

  const set = (idx: number, field: 'key' | 'value', val: string) => {
    onChange(entries.map((e, i) => (i === idx ? { ...e, [field]: val } : e)));
  };

  const remove = (idx: number) => onChange(entries.filter((_, i) => i !== idx));

  const add = () => onChange([...entries, { key: '', value: '' }]);

  return (
    <div className="space-y-1.5">
      {entries.map((entry, idx) => (
        <div key={idx} className="flex gap-1.5 items-center">
          <Input
            placeholder={keyPlaceholder}
            value={entry.key}
            onChange={(e) => set(idx, 'key', e.target.value)}
            className="flex-1 font-mono text-xs"
          />
          <div className="flex-1 relative">
            <Input
              placeholder={entry.key ? valuePlaceholder : ''}
              type={secret && !showValues[idx] ? 'password' : 'text'}
              value={entry.value}
              onChange={(e) => set(idx, 'value', e.target.value)}
              className="font-mono text-xs pr-8"
            />
            {secret && (
              <button
                type="button"
                onClick={() => setShowValues((p) => ({ ...p, [idx]: !p[idx] }))}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
              >
                {showValues[idx] ? <EyeOff size={12} /> : <Eye size={12} />}
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={() => remove(idx)}
            className="text-gray-600 hover:text-red-400 p-1 transition-colors"
          >
            <X size={13} />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={add}
        className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
      >
        + Aggiungi
      </button>
    </div>
  );
}

// ── Helper: copy to clipboard ───────────────────────────────────────────────

function CopyButton({ value, label }: { value: string; label?: string }) {
  const { t } = useTranslation('mcp');
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
    }
  };

  return (
    <button
      onClick={copy}
      title={t('copy')}
      className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 transition-colors"
    >
      {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
      {label && <span>{copied ? t('copied') : label}</span>}
    </button>
  );
}

// ── Bridge configuration panel ───────────────────────────────────────────────

function BridgeSetupPanel() {
  const { t } = useTranslation('mcp');
  const token = useStore((s) => s.token);
  const [showToken, setShowToken] = useState(false);

  /**
   * Backend WebSocket URL for the Electron bridge.
   *
   * Priority:
   *   1. VITE_WS_URL          → explicit override (e.g. "ws://localhost:3000")
   *   2. VITE_BACKEND_URL     → automatically derived (http→ws, https→wss)
   *   3. window.location.host → production / same host
   */
  const wsUrl = (() => {
    const wsExplicit  = (import.meta as any).env?.VITE_WS_URL     as string | undefined;
    const backendUrl  = (import.meta as any).env?.VITE_BACKEND_URL as string | undefined;

    if (wsExplicit) return wsExplicit;

    if (backendUrl) {
      try {
        const u = new URL(backendUrl);
        return `${u.protocol === 'https:' ? 'wss' : 'ws'}://${u.host}`;
      } catch { /* fallback */ }
    }

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${window.location.host}`;
  })();

  const maskedToken = token
    ? token.slice(0, 20) + '…' + token.slice(-8)
    : '—';

  return (
    <div className="mb-5 rounded-xl border border-gray-800 bg-gray-900/60 p-4">
      <div className="flex items-center gap-2 mb-1">
        <Link2 size={14} className="text-blue-400" />
        <h3 className="text-sm font-semibold text-gray-200">{t('bridge.title')}</h3>
      </div>
      <p className="text-xs text-gray-500 mb-3">
        {t('bridge.intro')}
      </p>

      <div className="space-y-3">
        {/* Server URL */}
        <div>
          <p className="text-xs font-medium text-gray-500 mb-1">{t('bridge.serverUrl')}</p>
          <div className="flex items-center gap-2 bg-gray-800 rounded-lg px-3 py-2">
            <code className="flex-1 text-xs text-blue-300 font-mono truncate">{wsUrl}</code>
            <CopyButton value={wsUrl} />
          </div>
          <p className="text-xs text-gray-600 mt-1">
            {t('bridge.urlHintPre')} <code className="text-gray-500">wss://</code> {t('bridge.urlHintMid')}{' '}
            <code className="text-gray-500">ws://</code> {t('bridge.urlHintPost')}
          </p>
        </div>

        {/* JWT Token */}
        <div>
          <p className="text-xs font-medium text-gray-500 mb-1">
            {t('bridge.jwtTitle')}
            <span className="ml-1.5 text-gray-600 font-normal">{t('bridge.jwtHint')}</span>
          </p>
          <div className="flex items-center gap-2 bg-gray-800 rounded-lg px-3 py-2">
            <code className="flex-1 text-xs text-amber-300 font-mono truncate">
              {showToken ? token : maskedToken}
            </code>
            <button
              onClick={() => setShowToken((p) => !p)}
              className="text-gray-500 hover:text-gray-300 transition-colors"
              title={showToken ? t('bridge.hide') : t('bridge.show')}
            >
              {showToken ? <EyeOff size={12} /> : <Eye size={12} />}
            </button>
            {token && <CopyButton value={token} />}
          </div>
          <p className="text-xs text-gray-600 mt-1">
            {t('bridge.jwtNote')}
          </p>
        </div>

        {/* macOS Gatekeeper note — the bridge is ad-hoc signed (not notarized),
            so the first launch needs a one-time unblock. Shown only on macOS. */}
        {detectBridgeOS() === 'mac' && (
          <div className="rounded-lg border border-amber-900/40 bg-amber-950/20 px-3 py-2.5">
            <p className="text-xs font-medium text-amber-300/90 mb-1">{t('bridge.macGatekeeperTitle')}</p>
            <p className="text-xs text-gray-400 leading-relaxed mb-1.5">{t('bridge.macGatekeeperBody')}</p>
            <div className="flex items-center gap-2 bg-gray-800 rounded-lg px-3 py-2">
              <code className="flex-1 text-[11px] text-gray-300 font-mono truncate">{MAC_UNQUARANTINE_CMD}</code>
              <CopyButton value={MAC_UNQUARANTINE_CMD} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// One-time Gatekeeper unblock for the ad-hoc-signed macOS bridge (productName in electron-builder.yml).
const MAC_UNQUARANTINE_CMD = 'xattr -dr com.apple.quarantine "/Applications/Arkimede Bridge.app"';

// ── Exported main section ──────────────────────────────────────────────

export function McpSection() {
  const { t } = useTranslation('mcp');
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<McpServer | null>(null);

  const qc = useQueryClient();

  const { data: servers = [], isLoading } = useQuery({
    queryKey: ['mcp-servers'],
    queryFn:  mcpServersApi.list,
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      mcpServersApi.toggle(id, enabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mcp-servers'] }),
  });

  const openCreate = () => { setEditing(null); setShowModal(true); };
  const openEdit   = (s: McpServer) => { setEditing(s); setShowModal(true); };
  const closeModal = () => { setShowModal(false); setEditing(null); };

  // 'remote' = uses the Electron bridge; 'local' = backend spawns directly (no bridge)
  const hasRemoteServers  = servers.some((s) => s.transport === 'remote');
  const remoteEnabledCount = servers.filter((s) => s.transport === 'remote' && s.enabled).length;

  // Editor replaces the list in-place (Flows-style) instead of a centered modal.
  if (showModal) {
    return (
      <ServerEditor
        server={editing}
        onClose={closeModal}
        onSaved={() => {
          qc.invalidateQueries({ queryKey: ['mcp-servers'] });
          closeModal();
        }}
      />
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-semibold text-gray-100">{t('title')}</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            {t('subtitle')}
          </p>
        </div>
        <button
          onClick={openCreate}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500
            text-white text-sm rounded-lg transition-colors"
        >
          <Plus size={14} /> {t('add')}
        </button>
      </div>

      {/* Bridge configuration panel — visible only if there are 'remote' servers */}
      {hasRemoteServers && <BridgeSetupPanel />}

      {/* Bridge banner (only if there are remote servers) */}
      {hasRemoteServers && (
        <BridgeBanner remoteCount={remoteEnabledCount} />
      )}

      {/* Server list */}
      {isLoading ? (
        <div className="flex items-center justify-center h-32">
          <Loader2 className="animate-spin text-gray-500" size={20} />
        </div>
      ) : servers.length === 0 ? (
        <div className="text-center py-12 text-gray-500 border border-dashed border-gray-800 rounded-xl">
          <p className="text-sm">{t('empty.title')}</p>
          <p className="text-xs mt-1">{t('empty.subtitle')}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {servers.map((server) => (
            <ServerCard
              key={server.id}
              server={server}
              onEdit={() => openEdit(server)}
              onToggle={(enabled) => toggleMutation.mutate({ id: server.id, enabled })}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Bridge banner ─────────────────────────────────────────────────────────────

function BridgeBanner({
  remoteCount,
}: {
  remoteCount: number;
}) {
  const { t } = useTranslation('mcp');
  const qc = useQueryClient();

  // Bridge status as a query (not one-shot state) so it re-checks on refresh,
  // window focus and a light interval — instead of only on a full page reload.
  const statusQ = useQuery({
    queryKey: ['bridge-status'],
    queryFn: async (): Promise<'connected' | 'disconnected'> => {
      // The first enabled 'remote' server is the reference for the bridge status.
      const servers = await mcpServersApi.list();
      const remote = servers.find((s) => s.transport === 'remote' && s.enabled);
      if (!remote) return 'disconnected';
      try {
        const { connected } = await mcpServersApi.getBridgeStatus(remote.id);
        return connected ? 'connected' : 'disconnected';
      } catch {
        return 'disconnected';
      }
    },
    refetchInterval: 20_000,
  });
  const bridgeStatus = statusQ.isLoading ? 'checking' : (statusQ.data ?? 'disconnected');

  // Ask the backend to re-probe the bridge, then re-read the status.
  const refreshMutation = useMutation({
    mutationFn: mcpServersApi.refreshBridge,
    onSettled: () => qc.invalidateQueries({ queryKey: ['bridge-status'] }),
  });
  const onRefresh = () => refreshMutation.mutate();
  const refreshing = refreshMutation.isPending || statusQ.isFetching;

  return (
    <div className={`mb-5 rounded-xl border p-4 flex items-start gap-3
      ${bridgeStatus === 'connected'
        ? 'border-emerald-800/50 bg-emerald-900/10'
        : 'border-amber-800/50 bg-amber-900/10'}`}
    >
      {bridgeStatus === 'checking' ? (
        <Loader2 className="animate-spin text-gray-400 mt-0.5" size={16} />
      ) : bridgeStatus === 'connected' ? (
        <CheckCircle2 className="text-emerald-400 mt-0.5" size={16} />
      ) : (
        <AlertCircle className="text-amber-400 mt-0.5" size={16} />
      )}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-200">
          {bridgeStatus === 'connected'
            ? t('banner.connected', { count: remoteCount })
            : t('banner.disconnected')}
        </p>
        <p className="text-xs text-gray-500 mt-0.5">
          {bridgeStatus === 'connected'
            ? t('banner.connectedDesc')
            : t('banner.disconnectedDesc')}
        </p>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {bridgeStatus !== 'connected' && (() => {
          const osLabel = bridgeOSLabel(detectBridgeOS());
          return (
            <a
              href={bridgeReleasesUrl()}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors"
            >
              <Download size={12} />{' '}
              {osLabel ? t('banner.downloadFor', { os: osLabel }) : t('banner.download')}
            </a>
          );
        })()}
        <button
          onClick={onRefresh}
          disabled={refreshing}
          className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-300 transition-colors disabled:opacity-50"
        >
          <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
          {t('banner.refresh')}
        </button>
      </div>
    </div>
  );
}

// ── Server card ───────────────────────────────────────────────────────────────

function ServerCard({
  server,
  onEdit,
  onToggle,
}: {
  server:    McpServer;
  onEdit:    () => void;
  onToggle:  (enabled: boolean) => void;
}) {
  const { t } = useTranslation('mcp');
  const meta = TRANSPORT_META[server.transport];
  const { Icon, label, color, bg } = meta;

  return (
    <div
      onClick={onEdit}
      className={`rounded-xl border border-gray-800 bg-gray-900/50 p-4 transition-opacity cursor-pointer
        hover:border-gray-700 ${!server.enabled ? 'opacity-50' : ''}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          {/* Transport badge */}
          <div className={`mt-0.5 p-1.5 rounded-lg ${bg} flex-shrink-0`}>
            <Icon size={14} className={color} />
          </div>

          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium text-gray-100 truncate">{server.name}</p>
              <span className={`text-xs px-1.5 py-0.5 rounded-md ${bg} ${color} font-medium`}>
                {label}
              </span>
            </div>
            {server.description && (
              <p className="text-xs text-gray-500 mt-0.5 truncate">{server.description}</p>
            )}
            <p className="text-xs text-gray-600 mt-0.5 font-mono truncate">
              {server.url ?? server.command ?? '—'}
            </p>
            {(server.secrets?.length ?? 0) > 0 && (
              <p className="text-xs text-gray-600 mt-1">
                {t('card.secret', { count: server.secrets!.length })}
              </p>
            )}
          </div>
        </div>

        {/* Enable toggle — right side, skills-style pill */}
        <button
          role="switch"
          aria-checked={server.enabled}
          onClick={(e) => { e.stopPropagation(); onToggle(!server.enabled); }}
          title={server.enabled ? t('card.disable') : t('card.enable')}
          className={`relative inline-flex h-6 w-10 flex-shrink-0 cursor-pointer items-center rounded-full
            border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none
            ${server.enabled ? 'bg-blue-600' : 'bg-gray-700'}`}
        >
          <span
            className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow
              transition-transform duration-200 ease-in-out
              ${server.enabled ? 'translate-x-4' : 'translate-x-0'}`}
          />
        </button>
      </div>
    </div>
  );
}

// ── Create/edit editor (inline, replaces the list) ───────────────────────────

function ServerEditor({
  server,
  onClose,
  onSaved,
}: {
  server:  McpServer | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation('mcp');
  const [form, setForm] = useState<FormState>(server ? serverToForm(server) : emptyForm());
  const [error, setError] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const isEditing = !!server;

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((p) => ({ ...p, [key]: value }));

  /** Changes the transport and clears the incompatible fields. */
  const handleTransportChange = (t: FormState['transport']) => {
    setForm((prev) => {
      const next = { ...prev, transport: t };
      if (t === 'local' || t === 'remote') {
        // These transports do not use URL or HTTP headers
        next.url     = '';
        next.headers = [];
      } else {
        // http / sse do not use command, args or env
        next.command = '';
        next.args    = '';
        next.env     = [];
      }
      return next;
    });
  };

  const createMutation = useMutation({
    mutationFn: (payload: CreateMcpServerPayload) => mcpServersApi.create(payload),
    onSuccess: onSaved,
    onError: (e: any) => setError(e?.response?.data?.message ?? e.message),
  });

  const updateMutation = useMutation({
    mutationFn: (payload: CreateMcpServerPayload) =>
      mcpServersApi.update(server!.id, payload),
    onSuccess: onSaved,
    onError: (e: any) => setError(e?.response?.data?.message ?? e.message),
  });

  const deleteMutation = useMutation({
    mutationFn: () => mcpServersApi.remove(server!.id),
    onSuccess: onSaved, // invalidate + back to the list
    onError: (e: any) => setError(e?.response?.data?.message ?? e.message),
  });

  const isPending = createMutation.isPending || updateMutation.isPending;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) { setError(t('modal.errNameRequired')); return; }
    if ((form.transport === 'http' || form.transport === 'sse') && !form.url.trim()) {
      setError(t('modal.errUrlRequired')); return;
    }
    if ((form.transport === 'local' || form.transport === 'remote') && !form.command.trim()) {
      setError(t('modal.errCommandRequired')); return;
    }
    setError('');
    const payload = formToPayload(form);
    if (isEditing) { updateMutation.mutate(payload); }
    else           { createMutation.mutate(payload); }
  };

  return (
    <div>
      <form onSubmit={handleSubmit}>
        {/* Header with back button — replaces the section content (Flows-style) */}
        <div className="flex items-center gap-3 mb-5">
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-white flex items-center gap-1 text-sm flex-shrink-0"
          >
            <ArrowLeft size={16} /> {t('title')}
          </button>
          <h3 className="text-base font-semibold text-gray-100 truncate">
            {isEditing ? t('modal.editTitle') : t('modal.newTitle')}
          </h3>
        </div>

        <div className="space-y-4">
            {/* Name */}
            <div>
              <Label>{t('modal.name')}</Label>
              <Input
                value={form.name}
                onChange={(e) => set('name', e.target.value)}
                placeholder={t('modal.namePlaceholder')}
                disabled={isPending}
              />
            </div>

            {/* Description */}
            <div>
              <Label>{t('modal.description')}</Label>
              <Input
                value={form.description}
                onChange={(e) => set('description', e.target.value)}
                placeholder={t('modal.descriptionPlaceholder')}
                disabled={isPending}
              />
            </div>

            {/* loadOnFirst: if off, the server's tools are not loaded into the chat */}
            <div>
              <Label>{t('modal.loadOnFirstLabel')}</Label>
              <label className="flex items-center gap-2 text-sm text-gray-300" title={t('modal.loadOnFirstTitle')}>
                <input
                  type="checkbox"
                  checked={form.loadOnFirst}
                  onChange={(e) => set('loadOnFirst', e.target.checked)}
                  disabled={isPending}
                />
                {t('modal.loadOnFirstText')} <span className="text-gray-500">{t('modal.loadOnFirstHint')}</span>
              </label>
            </div>

            {/* Transport */}
            <div>
              <Label>{t('modal.transport')}</Label>
              <div className="grid grid-cols-2 gap-2">
                {(['http', 'sse', 'local', 'remote'] as const).map((t) => {
                  const { Icon, label, color, bg } = TRANSPORT_META[t];
                  const active = form.transport === t;
                  return (
                    <button
                      key={t}
                      type="button"
                      disabled={isPending}
                      onClick={() => handleTransportChange(t)}
                      className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl border transition-all
                        ${active
                          ? `border-blue-600 ${bg}`
                          : 'border-gray-800 hover:border-gray-700'}`}
                    >
                      <Icon size={16} className={active ? color : 'text-gray-500'} />
                      <span className={`text-xs font-medium ${active ? color : 'text-gray-500'}`}>
                        {label}
                      </span>
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-gray-600 mt-1.5">
                {form.transport === 'http'   && t('modal.transportHttp')}
                {form.transport === 'sse'    && t('modal.transportSse')}
                {form.transport === 'local'  && t('modal.transportLocal')}
                {form.transport === 'remote' && t('modal.transportRemote')}
              </p>
            </div>

            {/* URL (http/sse) */}
            {(form.transport === 'http' || form.transport === 'sse') && (
              <div>
                <Label>{t('modal.urlEndpoint')}</Label>
                <Input
                  value={form.url}
                  onChange={(e) => set('url', e.target.value)}
                  placeholder={t('modal.urlPlaceholder')}
                  disabled={isPending}
                />
                <p className="text-xs text-gray-600 mt-1">
                  {t('modal.urlTemplateHint')} {'{{secret.API_KEY}}'}, {'{{env.MY_VAR}}'}
                </p>
              </div>
            )}

            {/* Command (local / remote) */}
            {(form.transport === 'local' || form.transport === 'remote') && (
              <>
                <div>
                  <Label>{t('modal.command')}</Label>
                  <Input
                    value={form.command}
                    onChange={(e) => set('command', e.target.value)}
                    placeholder={t('modal.commandPlaceholder')}
                    className="font-mono text-xs"
                    disabled={isPending}
                  />
                  <p className="text-xs text-gray-600 mt-1">
                    {t('modal.commandHintPre')} <code className="text-gray-500">uvx freecad-mcp</code>,{' '}
                    <code className="text-gray-500">npx -y tavily-mcp</code>
                    {form.transport === 'local' && (
                      <> {t('modal.commandHintLocal')}</>
                    )}
                    {form.transport === 'remote' && (
                      <> {t('modal.commandHintRemote')}</>
                    )}
                  </p>
                </div>
                <div>
                  <Label>{t('modal.argsLabel')}</Label>
                  <Input
                    value={form.args}
                    onChange={(e) => set('args', e.target.value)}
                    placeholder={t('modal.argsPlaceholder')}
                    className="font-mono text-xs"
                    disabled={isPending}
                  />
                  <p className="text-xs text-gray-600 mt-1">{t('modal.argsHint')}</p>
                </div>
              </>
            )}

            {/* Secrets */}
            <div>
              <Label>{t('modal.secretsLabel')}</Label>
              <KvEditor
                entries={form.secrets}
                onChange={(v) => set('secrets', v)}
                keyPlaceholder={t('modal.secretKeyPlaceholder')}
                valuePlaceholder={t('modal.secretValuePlaceholder')}
                secret
              />
              <p className="text-xs text-gray-600 mt-1">
                {t('modal.secretsHintPre')} <code className="text-gray-500">{'{{secret.KEY_NAME}}'}</code> {t('modal.secretsHintPost')}
              </p>
            </div>

            {/* Advanced section */}
            <button
              type="button"
              onClick={() => setShowAdvanced((p) => !p)}
              className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 transition-colors"
            >
              {showAdvanced ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
              {t('modal.advanced')}
            </button>

            {showAdvanced && (
              <div className="space-y-4 pt-1">
                {/* Headers (http/sse) */}
                {(form.transport === 'http' || form.transport === 'sse') && (
                  <div>
                    <Label>{t('modal.headersLabel')}</Label>
                    <KvEditor
                      entries={form.headers}
                      onChange={(v) => set('headers', v)}
                      keyPlaceholder="Header-Name"
                      valuePlaceholder="{{secret.TOKEN}}"
                    />
                  </div>
                )}

                {/* Env (local / remote) */}
                {(form.transport === 'local' || form.transport === 'remote') && (
                  <div>
                    <Label>{t('modal.envLabel')}</Label>
                    <KvEditor
                      entries={form.env}
                      onChange={(v) => set('env', v)}
                      keyPlaceholder="VAR_NAME"
                      valuePlaceholder="{{secret.KEY}}"
                    />
                  </div>
                )}
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="flex items-start gap-2 p-3 bg-red-900/20 border border-red-800/50 rounded-lg">
                <XCircle size={14} className="text-red-400 mt-0.5 flex-shrink-0" />
                <p className="text-xs text-red-300">{error}</p>
              </div>
            )}
          </div>

        {/* Footer */}
        <div className="flex items-center gap-2 mt-6 pt-4 border-t border-gray-800">
          {/* Delete — existing server only */}
          {isEditing && (
            confirmDelete ? (
              <div className="flex items-center gap-2 flex-shrink-0">
                <span className="text-xs text-gray-400">{t('card.deleteConfirm')}</span>
                <button
                  type="button"
                  onClick={() => deleteMutation.mutate()}
                  disabled={deleteMutation.isPending}
                  className="px-2 py-1 text-xs bg-red-600 hover:bg-red-500 text-white rounded transition-colors"
                >
                  {deleteMutation.isPending ? <Loader2 size={12} className="animate-spin" /> : t('card.delete')}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="px-2 py-1 text-xs text-gray-400 hover:text-gray-200 rounded"
                >
                  {t('card.no')}
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                title={t('card.delete')}
                className="flex items-center gap-1.5 px-2.5 py-2 text-sm text-gray-400 hover:text-red-400 rounded-lg transition-colors flex-shrink-0"
              >
                <Trash2 size={15} /> {t('card.delete')}
              </button>
            )
          )}
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            disabled={isPending}
            className="px-4 py-1.5 text-sm text-gray-400 hover:text-gray-200 transition-colors disabled:opacity-50"
          >
            {t('common:actions.cancel')}
          </button>
          <button
            type="submit"
            disabled={isPending}
            className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 hover:bg-blue-500
              text-white text-sm rounded-lg transition-colors disabled:opacity-50"
          >
            {isPending ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            {isEditing ? t('common:actions.save') : t('modal.create')}
          </button>
        </div>
      </form>
    </div>
  );
}
