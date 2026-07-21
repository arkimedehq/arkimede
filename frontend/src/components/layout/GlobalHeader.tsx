/**
 * @file GlobalHeader.tsx
 *
 * Global header always visible in the right column of the layout.
 * Updates based on the current navigation without being
 * encapsulated in a specific component (ChatWindow, SettingsPage, etc.).
 *
 * Layout:
 *   [Left: contextual title]   [Right: contextual actions + 🔔]
 *
 * Views:
 *   settings  → "Settings"
 *   chat      → current chat title + message count
 *   welcome   → app name
 *
 * Right actions:
 *   Always:    NotificationBell
 *   Chat only: File (toggle FilePanel) + Stop (during streaming)
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderOpen, Square, Settings, MessageSquare, Pencil, Check, X } from 'lucide-react';
import { useStore } from '../../store/useStore';
import { chatsApi } from '../../api/chats';
import { NotificationBell } from '../notifications/NotificationCenter';
import { APP_NAME } from '../../config/app.config';

// ── Contextual left title ─────────────────────────────────────────────────────

function HeaderTitle() {
  const { t } = useTranslation();
  const activeView   = useStore((s) => s.activeView);
  const activeChatId = useStore((s) => s.activeChatId);

  if (activeView === 'settings') {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-400">
        <Settings size={14} className="flex-shrink-0" />
        <span>{t('nav.settings')}</span>
      </div>
    );
  }

  if (activeChatId) {
    return <ChatTitle chatId={activeChatId} />;
  }

  // Welcome screen
  return (
    <div className="flex items-center gap-2 text-sm text-gray-500">
      <MessageSquare size={14} className="flex-shrink-0" />
      <span>{APP_NAME}</span>
    </div>
  );
}

/** Shows (and allows renaming) the title of the active chat. */
function ChatTitle({ chatId }: { chatId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: chats = [] } = useQuery({
    queryKey: ['chats'],
    queryFn:  () => chatsApi.list(),
    staleTime: 30_000,
  });

  const showTokenCount = useStore((s) => (s.user as any)?.showTokenCount ?? false);
  const currentUserId  = useStore((s) => s.user?.id);
  const chat = chats.find((c) => c.id === chatId);
  const inTok  = chat?.totalInputTokens  ?? 0;
  const outTok = chat?.totalOutputTokens ?? 0;

  // Renamable only if the chat belongs to the current user (the backend requires
  // being its author: findOneAsAuthor). Colleagues' chats stay read-only.
  const canRename = !!chat && (!chat.authorId || chat.authorId === currentUserId);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft]     = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const rename = useMutation({
    mutationFn: (title: string) => chatsApi.updateTitle(chatId, title),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['chats'] });
      qc.invalidateQueries({ queryKey: ['chat-meta', chatId] });
    },
  });

  // Exits edit mode if the active chat changes.
  useEffect(() => { setEditing(false); }, [chatId]);
  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);

  const startEdit = () => {
    if (!canRename) return;
    setDraft(chat?.title ?? '');
    setEditing(true);
  };

  const commit = () => {
    const next = draft.trim();
    if (next && next !== chat?.title) rename.mutate(next);
    setEditing(false);
  };

  const fmt = (n: number) =>
    n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000   ? `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`
    : String(n);

  if (editing) {
    return (
      <div className="flex items-center gap-1.5 min-w-0">
        <MessageSquare size={14} className="text-gray-500 flex-shrink-0" />
        <input
          ref={inputRef}
          value={draft}
          autoFocus
          maxLength={120}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') setEditing(false);
          }}
          className="text-sm bg-gray-800 text-gray-100 rounded px-2 py-0.5 border border-gray-700 focus:border-blue-500 outline-none w-64"
        />
        <button onClick={commit} className="p-1 rounded text-emerald-400 hover:bg-emerald-500/15" title={t('actions.save')}>
          <Check size={14} />
        </button>
        <button onClick={() => setEditing(false)} className="p-1 rounded text-gray-400 hover:bg-red-500/15 hover:text-red-400" title={t('actions.cancel')}>
          <X size={14} />
        </button>
      </div>
    );
  }

  return (
    <div className="group flex items-center gap-2 min-w-0">
      <MessageSquare size={14} className="text-gray-500 flex-shrink-0" />
      <span
        className={`text-sm text-gray-300 truncate max-w-xs ${canRename ? 'cursor-text' : ''}`}
        onDoubleClick={startEdit}
        title={canRename ? t('header.dblToRename') : undefined}
      >
        {chat?.title ?? '…'}
      </span>
      {canRename && (
        <button
          onClick={startEdit}
          className="hidden group-hover:block text-gray-600 hover:text-gray-300 p-0.5 flex-shrink-0"
          title={t('header.rename')}
        >
          <Pencil size={12} />
        </button>
      )}
      {showTokenCount && (inTok > 0 || outTok > 0) && (
        <span
          className="flex-shrink-0 text-[11px] font-mono text-gray-500 tabular-nums"
          title={`Total tokens — input: ${inTok.toLocaleString()} · output: ${outTok.toLocaleString()}`}
        >
          ↑{fmt(inTok)} ↓{fmt(outTok)}
        </span>
      )}
    </div>
  );
}

// ── Main header ───────────────────────────────────────────────────────────────

export default function GlobalHeader() {
  const { t } = useTranslation();
  const activeView      = useStore((s) => s.activeView);
  const activeChatId    = useStore((s) => s.activeChatId);
  const isStreaming     = useStore((s) => s.isStreaming);
  const stopStreamingFn = useStore((s) => s.stopStreamingFn);
  const filesPanelOpen  = useStore((s) => s.filesPanelOpen);
  const setFilesPanelOpen = useStore((s) => s.setFilesPanelOpen);

  const inChat = activeView === 'chat' && !!activeChatId;

  return (
    <header className="flex items-center justify-between px-4 py-2.5 border-b border-gray-800 bg-gray-900/50 backdrop-blur-sm flex-shrink-0" style={{ borderColor: 'var(--border-1)', backgroundColor: 'color-mix(in srgb, var(--bg-surface-1) 80%, transparent)' }}>
      {/* Contextual title */}
      <HeaderTitle />

      {/* Right actions */}
      <div className="flex items-center gap-1.5">

        {/* Chat-specific actions */}
        {inChat && (
          <>
            {isStreaming && (
              <button
                onClick={() => stopStreamingFn?.()}
                className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg
                  bg-red-600/20 hover:bg-red-600/40 text-red-400 hover:text-red-300
                  border border-red-800/50 hover:border-red-600 transition-all animate-pulse"
                title={t('header.stop')}
              >
                <Square size={13} fill="currentColor" />
                {t('header.stopShort')}
              </button>
            )}
            <button
              onClick={() => setFilesPanelOpen(!filesPanelOpen)}
              className={`flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg transition-colors
                ${filesPanelOpen ? 'bg-blue-600 text-white' : 'btn-ghost'}`}
              title={t('header.filePanel')}
            >
              <FolderOpen size={15} />
              {t('header.filesLabel')}
            </button>
          </>
        )}

        {/* Notification bell — always visible */}
        <NotificationBell />

      </div>
    </header>
  );
}
