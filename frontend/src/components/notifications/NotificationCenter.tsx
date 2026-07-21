/**
 * @file NotificationCenter.tsx
 *
 * Notification Center: bell with badge + history panel on the right.
 *
 * The panel opens from the right in FilePanel style, is fixed to the full
 * viewport height and closes when clicking outside or on the X.
 *
 * Each notification has a "Start chat" button that:
 *   1. Shows an inline project selector
 *   2. Creates the chat with a title generated from the notification content
 *   3. Navigates to the new chat and closes the panel
 *
 * Exported component:
 *   NotificationBell — button with badge, to use in the GlobalHeader
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Bell, X, Trash2, CheckCheck, Mail, AlertTriangle,
  Clock, Check, MessageSquare, Loader2,
} from 'lucide-react';
import { useStore, type SkillNotification } from '../../store/useStore';
import { projectsApi } from '../../api/projects';
import { chatsApi } from '../../api/chats';
import { notificationsApi } from '../../api/notifications';
import i18n from '../../i18n';

// ── Helpers ───────────────────────────────────────────────────────────────────

function EventIcon({ eventType }: { eventType: string }) {
  if (eventType === 'new_emails')
    return <Mail size={13} className="text-blue-400 flex-shrink-0 mt-0.5" />;
  if (eventType === 'daemon_exit' || eventType === 'auth_error' || eventType === 'scheduled_task_disabled')
    return <AlertTriangle size={13} className="text-amber-400 flex-shrink-0 mt-0.5" />;
  if (eventType === 'scheduled_task')
    return <Clock size={13} className="text-emerald-400 flex-shrink-0 mt-0.5" />;
  return <Bell size={13} className="text-indigo-400 flex-shrink-0 mt-0.5" />;
}

/** Extracts a short text snippet from an automation result. */
function resultSnippet(payload: Record<string, unknown>): string {
  const raw = String(payload.result ?? '').replace(/[#*`>]/g, '').replace(/\s+/g, ' ').trim();
  return raw.length > 140 ? raw.slice(0, 140) + '…' : raw;
}

function notifSummary(n: SkillNotification): { title: string; body: string } {
  switch (n.eventType) {
    case 'new_emails': {
      const count  = (n.payload.count as number) ?? 0;
      const emails = (n.payload.emails as any[]) ?? [];
      const first  = emails[0];
      return {
        title: i18n.t('notifications:event.emails', { count }),
        body:  first
          ? `${first.from?.replace(/<.*>/, '').trim() || first.from} — ${first.subject}`
          : '',
      };
    }
    case 'daemon_exit':
      return { title: i18n.t('notifications:event.daemonExit'), body: i18n.t('notifications:event.daemonExitBody', { code: n.payload.exit_code ?? '?' }) };
    case 'auth_error':
      return { title: i18n.t('notifications:event.authError'), body: String(n.payload.error ?? '') };
    case 'scheduled_task':
      return { title: `⏰ ${n.payload.title ?? i18n.t('notifications:event.taskDone')}`, body: resultSnippet(n.payload) };
    case 'scheduled_task_disabled':
      return { title: `⚠️ ${n.payload.title ?? i18n.t('notifications:event.task')} ${i18n.t('notifications:event.disabledSuffix')}`, body: resultSnippet(n.payload) };
    case 'compile_suggested':
      return {
        title: i18n.t('notifications:event.compileSuggested', { name: String(n.payload.skillName ?? '') }),
        body:  i18n.t('notifications:event.compileSuggestedBody', { count: Number(n.payload.runs ?? 0) }),
      };
    default:
      // Generic events (e.g. embed_ingest_done/failed): use title/message from the payload.
      return { title: String(n.payload.title ?? n.eventType.replace(/_/g, ' ')), body: String(n.payload.message ?? '') };
  }
}

function generateChatTitle(n: SkillNotification): string {
  switch (n.eventType) {
    case 'new_emails': {
      const emails = (n.payload.emails as any[]) ?? [];
      const subject = emails[0]?.subject?.trim();
      return subject ? `📧 ${subject}` : `📧 ${i18n.t('notifications:event.newEmailsTitle')}`;
    }
    case 'daemon_exit':  return `⚠ ${i18n.t('notifications:event.daemonExit')}`;
    case 'auth_error':   return `🔐 ${i18n.t('notifications:event.authShort')}`;
    default: return `🔔 ${n.eventType.replace(/_/g, ' ')}`;
  }
}

function relTime(ts: string): string {
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60)    return i18n.t('notifications:relTime.seconds', { n: s });
  if (s < 3600)  return i18n.t('notifications:relTime.minutes', { n: Math.floor(s / 60) });
  if (s < 86400) return i18n.t('notifications:relTime.hours', { n: Math.floor(s / 3600) });
  return new Date(ts).toLocaleDateString(i18n.language, { day: '2-digit', month: 'short' });
}

// ── Project selector + start chat ─────────────────────────────────────────────

function StartChatButton({
  notification,
  onChatStarted,
}: {
  notification:  SkillNotification;
  onChatStarted: () => void;
}) {
  const { t }        = useTranslation('notifications');
  const qc           = useQueryClient();
  const setActiveChat = useStore((s) => s.setActiveChat);
  const [open, setOpen] = useState(false);

  const { data: projects = [] } = useQuery({
    queryKey: ['projects'],
    queryFn:  projectsApi.list,
    staleTime: 60_000,
    enabled:   open,   // load only when the selector is open
  });

  const createChat = useMutation({
    mutationFn: (projectId: string | null) =>
      chatsApi.create({
        title:     generateChatTitle(notification),
        projectId: projectId ?? undefined,
      }),
    onSuccess: (chat) => {
      qc.invalidateQueries({ queryKey: ['chats'] });
      setActiveChat(chat.id);
      onChatStarted();
    },
  });

  if (!open) {
    return (
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        className="flex items-center gap-1 px-2 py-1 text-[11px]
          text-indigo-600 dark:text-indigo-400
          hover:text-indigo-700 dark:hover:text-indigo-300
          border border-indigo-200 dark:border-indigo-800/50
          hover:border-indigo-400 dark:hover:border-indigo-600
          rounded-lg transition-colors"
      >
        <MessageSquare size={10} />
        {t('actions.startChat')}
      </button>
    );
  }

  return (
    <div
      className="mt-2 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden"
      onClick={(e) => e.stopPropagation()}
    >
      {/* Selector header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-200 dark:border-gray-700">
        <span className="text-[11px] text-gray-500 dark:text-gray-400">{t('actions.selectProject')}</span>
        <button onClick={() => setOpen(false)} className="text-gray-400 dark:text-gray-600 hover:text-gray-600 dark:hover:text-gray-400">
          <X size={11} />
        </button>
      </div>

      {/* "No project" option */}
      <button
        onClick={() => createChat.mutate(null)}
        disabled={createChat.isPending}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs
          text-gray-600 dark:text-gray-400
          hover:bg-gray-100 dark:hover:bg-gray-700
          hover:text-gray-900 dark:hover:text-gray-200
          transition-colors text-left"
      >
        {createChat.isPending
          ? <Loader2 size={11} className="animate-spin" />
          : <MessageSquare size={11} />
        }
        {t('actions.noProject')}
      </button>

      {/* Project list */}
      {projects.map((p) => (
        <button
          key={p.id}
          onClick={() => createChat.mutate(p.id)}
          disabled={createChat.isPending}
          className="w-full flex items-center gap-2 px-3 py-2 text-xs
            text-gray-700 dark:text-gray-300
            hover:bg-gray-100 dark:hover:bg-gray-700
            hover:text-gray-900 dark:hover:text-white
            transition-colors text-left disabled:opacity-50"
        >
          {createChat.isPending
            ? <Loader2 size={11} className="animate-spin flex-shrink-0" />
            : (
              <span
                className="w-2 h-2 rounded-full flex-shrink-0"
                style={{ backgroundColor: p.color || '#3b82f6' }}
              />
            )
          }
          <span className="truncate">{p.name}</span>
        </button>
      ))}
    </div>
  );
}

// ── Open an existing chat (automation result) ─────────────────────────────────

function OpenChatButton({ chatId, onOpened }: { chatId: string; onOpened: () => void }) {
  const { t } = useTranslation('notifications');
  const setActiveChat = useStore((s) => s.setActiveChat);
  const setActiveView = useStore((s) => s.setActiveView);
  const qc = useQueryClient();
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        setActiveView?.('chat');
        setActiveChat(chatId);
        chatsApi.markRead(chatId)
          .then(() => qc.invalidateQueries({ queryKey: ['chats'] }))
          .catch(() => undefined);
        onOpened();
      }}
      className="flex items-center gap-1 px-2 py-1 text-[11px]
        text-indigo-600 dark:text-indigo-400
        hover:text-indigo-700 dark:hover:text-indigo-300
        border border-indigo-200 dark:border-indigo-800/50
        hover:border-indigo-400 dark:hover:border-indigo-600
        rounded-lg transition-colors"
    >
      <MessageSquare size={10} />
      {t('actions.openChat')}
    </button>
  );
}

// ── Single notification row ───────────────────────────────────────────────────

function NotificationItem({
  notification: n,
  onDismiss,
  onRead,
  onChatStarted,
}: {
  notification:  SkillNotification;
  onDismiss:     () => void;
  onRead:        () => void;
  onChatStarted: () => void;
}) {
  const { t } = useTranslation('notifications');
  const { title, body } = notifSummary(n);

  return (
    <div
      className={`px-4 py-3 border-b transition-colors
        border-gray-100 dark:border-gray-800/50
        hover:bg-gray-50 dark:hover:bg-gray-800/30
        ${!n.read ? 'bg-blue-50/60 dark:bg-blue-950/10' : ''}`}
    >
      {/* Main row */}
      <div className="flex items-start gap-2.5">
        {/* Dot unread */}
        <div className="mt-1.5 flex-shrink-0 w-1.5">
          {!n.read && <div className="w-1.5 h-1.5 rounded-full bg-blue-500" />}
        </div>

        {/* Event icon */}
        <EventIcon eventType={n.eventType} />

        {/* Content */}
        <div className="flex-1 min-w-0">
          <p className={`text-xs font-medium leading-snug
            ${n.read
              ? 'text-gray-500 dark:text-gray-400'
              : 'text-gray-800 dark:text-gray-100'}`}>
            {title}
          </p>
          {body && (
            <p className="text-[11px] text-gray-500 dark:text-gray-500 mt-0.5 leading-relaxed line-clamp-2">{body}</p>
          )}
          <div className="flex items-center gap-3 mt-1.5">
            <p className="text-[10px] text-gray-400 dark:text-gray-600 flex items-center gap-1">
              <Clock size={9} />{relTime(n.timestamp)}
            </p>
            {/* Automation result → open the delivery chat; otherwise start a new chat */}
            {n.payload.chatId
              ? <OpenChatButton chatId={String(n.payload.chatId)} onOpened={onChatStarted} />
              : <StartChatButton notification={n} onChatStarted={onChatStarted} />}
          </div>
        </div>

        {/* Quick actions */}
        <div className="flex items-center gap-0.5 flex-shrink-0 mt-0.5">
          {!n.read && (
            <button
              onClick={onRead}
              title={t('actions.markRead')}
              className="p-1 text-gray-400 dark:text-gray-600 hover:text-blue-500 dark:hover:text-blue-400 rounded transition-colors"
            >
              <Check size={11} />
            </button>
          )}
          <button
            onClick={onDismiss}
            title={t('actions.dismiss')}
            className="p-1 text-gray-400 dark:text-gray-600 hover:text-red-500 dark:hover:text-red-400 rounded transition-colors"
          >
            <X size={11} />
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Right side panel ──────────────────────────────────────────────────────────

function NotificationPanel({ onClose }: { onClose: () => void }) {
  const { t }                  = useTranslation('notifications');
  const notifications          = useStore((s) => s.notifications);
  const dismissLocal           = useStore((s) => s.dismissNotification);
  const markReadLocal          = useStore((s) => s.markNotificationRead);
  const markAllReadLocal       = useStore((s) => s.markAllNotificationsRead);
  const clearLocal             = useStore((s) => s.clearNotifications);

  const unreadCount = notifications.filter((n) => !n.read).length;

  // ── Actions with API persistence ─────────────────────────────────────────────

  const handleDismiss = async (id: string) => {
    dismissLocal(id);
    try { await notificationsApi.delete(id); } catch { /* best-effort */ }
  };

  const handleRead = async (id: string) => {
    markReadLocal(id);
    try { await notificationsApi.markRead(id); } catch { /* best-effort */ }
  };

  const handleMarkAllRead = async () => {
    markAllReadLocal();
    try { await notificationsApi.markAllRead(); } catch { /* best-effort */ }
  };

  const handleClear = async () => {
    clearLocal();
    try { await notificationsApi.deleteAll(); } catch { /* best-effort */ }
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/20 backdrop-blur-[1px]"
        onClick={onClose}
      />

      {/* Panel — fixed to the right, full height */}
      <div className="fixed inset-y-0 right-0 z-50 w-80 h-screen
        bg-white dark:bg-gray-900
        border-l border-gray-200 dark:border-gray-800
        flex flex-col shadow-2xl animate-in slide-in-from-right-4 duration-200">

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3
          border-b border-gray-200 dark:border-gray-800 flex-shrink-0">
          <div className="flex items-center gap-2">
            <Bell size={14} className="text-gray-500 dark:text-gray-400" />
            <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('panel.title')}</span>
            {unreadCount > 0 && (
              <span className="px-1.5 py-0.5 text-[10px] font-bold bg-blue-600 text-white rounded-full leading-none">
                {unreadCount}
              </span>
            )}
          </div>
          <div className="flex items-center gap-0.5">
            {unreadCount > 0 && (
              <button
                onClick={handleMarkAllRead}
                title={t('panel.markAllRead')}
                className="p-1.5 text-gray-400 dark:text-gray-500 hover:text-blue-500 dark:hover:text-blue-400 rounded-lg transition-colors"
              >
                <CheckCheck size={14} />
              </button>
            )}
            {notifications.length > 0 && (
              <button
                onClick={handleClear}
                title={t('panel.clearAll')}
                className="p-1.5 text-gray-400 dark:text-gray-500 hover:text-red-500 dark:hover:text-red-400 rounded-lg transition-colors"
              >
                <Trash2 size={14} />
              </button>
            )}
            <button
              onClick={onClose}
              className="p-1.5 text-gray-400 dark:text-gray-600 hover:text-gray-700 dark:hover:text-gray-300 rounded-lg transition-colors"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Notification list — flex-1 + min-h-0 to allow shrink and scroll */}
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
          {notifications.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3
              text-gray-400 dark:text-gray-600">
              <Bell size={28} className="opacity-30" />
              <div className="text-center">
                <p className="text-sm text-gray-500 dark:text-gray-500">{t('panel.empty')}</p>
                <p className="text-xs text-gray-400 dark:text-gray-600 mt-1">
                  {t('panel.emptyHint')}
                </p>
              </div>
            </div>
          ) : (
            notifications.map((n) => (
              <NotificationItem
                key={n.id}
                notification={n}
                onDismiss={() => handleDismiss(n.id)}
                onRead={() => handleRead(n.id)}
                onChatStarted={onClose}
              />
            ))
          )}
        </div>

        {/* Footer */}
        {notifications.length > 0 && (
          <div className="px-4 py-2.5 border-t border-gray-200/60 dark:border-gray-800/60 flex-shrink-0">
            <p className="text-[10px] text-gray-400 dark:text-gray-600 text-center">
              {t('panel.footer', { count: notifications.length })}
            </p>
          </div>
        )}
      </div>
    </>
  );
}

// ── NotificationBell — main export ────────────────────────────────────────────

export function NotificationBell() {
  const { t }             = useTranslation('notifications');
  const [open, setOpen]   = useState(false);
  const notifications     = useStore((s) => s.notifications);
  const unread            = notifications.filter((n) => !n.read).length;

  return (
    <>
      <button
        onClick={() => setOpen((o) => !o)}
        title={t('panel.title')}
        className={`relative p-1.5 rounded-lg transition-colors
          ${open
            ? 'text-blue-400 bg-blue-900/30'
            : 'btn-ghost'}`}
      >
        <Bell size={16} />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-0.5 flex items-center
            justify-center text-[9px] font-bold bg-blue-600 text-white rounded-full leading-none">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && <NotificationPanel onClose={() => setOpen(false)} />}
    </>
  );
}
