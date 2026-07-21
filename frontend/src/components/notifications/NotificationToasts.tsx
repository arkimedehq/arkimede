/**
 * @file NotificationToasts.tsx
 *
 * Shows toasts for real-time notifications received from skill daemons.
 * Mounts in DashboardPage and stays visible across all views.
 *
 * Each toast:
 *   - Appears at the bottom right
 *   - Auto-closes after AUTO_DISMISS_MS
 *   - Shows icon, event type, and relevant data from the payload
 *   - Clicking "×" closes it manually
 */
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Mail, AlertTriangle, Bell, Clock, X, Workflow } from 'lucide-react';
import { useStore, type SkillNotification } from '../../store/useStore';
import { useNotifications }  from '../../hooks/useNotifications';
import { notificationsApi }  from '../../api/notifications';
import i18n from '../../i18n';

const AUTO_DISMISS_MS = 8_000;

// ── Icon by event type ────────────────────────────────────────────────────────

function EventIcon({ eventType }: { eventType: string }) {
  if (eventType === 'new_emails')  return <Mail size={16} className="text-blue-400 flex-shrink-0" />;
  if (eventType === 'daemon_exit') return <AlertTriangle size={16} className="text-amber-400 flex-shrink-0" />;
  if (eventType === 'auth_error')  return <AlertTriangle size={16} className="text-red-400 flex-shrink-0" />;
  if (eventType === 'scheduled_task_disabled') return <AlertTriangle size={16} className="text-amber-400 flex-shrink-0" />;
  if (eventType === 'scheduled_task') return <Clock size={16} className="text-emerald-400 flex-shrink-0" />;
  if (eventType === 'flow_run') return <Workflow size={16} className="text-emerald-400 flex-shrink-0" />;
  return <Bell size={16} className="text-indigo-400 flex-shrink-0" />;
}

// ── Readable text by event type ───────────────────────────────────────────────

function eventSummary(n: SkillNotification): { title: string; body: string } {
  switch (n.eventType) {
    case 'new_emails': {
      const count  = (n.payload.count as number) ?? 0;
      const emails = (n.payload.emails as any[]) ?? [];
      const first  = emails[0];
      return {
        title: i18n.t('notifications:event.emails', { count }),
        body:  first
          ? `Da: ${first.from?.replace(/<.*>/, '').trim() || first.from}\n${first.subject}`
          : '',
      };
    }
    case 'daemon_exit':
      return {
        title: i18n.t('notifications:event.daemonExit'),
        body:  i18n.t('notifications:event.daemonExitBody', { code: n.payload.exit_code ?? '?' }),
      };
    case 'auth_error':
      return {
        title: i18n.t('notifications:event.authError'),
        body:  String(n.payload.error ?? i18n.t('notifications:event.authErrorFallback')),
      };
    case 'scheduled_task':
    case 'scheduled_task_disabled': {
      const raw = String(n.payload.result ?? '').replace(/[#*`>]/g, '').replace(/\s+/g, ' ').trim();
      return {
        title: `${n.eventType === 'scheduled_task_disabled' ? '⚠️' : '⏰'} ${n.payload.title ?? i18n.t('notifications:event.task')}`,
        body:  raw.length > 120 ? raw.slice(0, 120) + '…' : raw,
      };
    }
    case 'flow_run': {
      const ok = n.payload.status === 'completed';
      const name = (n.payload.flowName as string) ?? i18n.t('notifications:event.flowFallbackName');
      const err = String(n.payload.error ?? '').trim();
      return {
        title: ok ? i18n.t('notifications:event.flowOk', { name }) : i18n.t('notifications:event.flowError', { name }),
        body:  ok ? (n.payload.chatId ? i18n.t('notifications:event.flowDelivered') : '') : (err || i18n.t('notifications:event.flowFailed')),
      };
    }
    default:
      // Generic events (e.g. embed_ingest_done/failed): use title/message from the payload.
      return {
        title: String(n.payload.title ?? n.eventType.replace(/_/g, ' ')),
        body:  String(n.payload.message ?? ''),
      };
  }
}

// ── Single toast ──────────────────────────────────────────────────────────────

function Toast({ notification }: { notification: SkillNotification }) {
  const { i18n: i18nInstance } = useTranslation('notifications'); // subscribes to language changes
  const markReadLocal = useStore((s) => s.markNotificationRead);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Marks as read (local + API).
   * The toast disappears (the !n.read filter excludes it), but the notification
   * stays in the history panel as already seen.
   */
  const markRead = () => {
    markReadLocal(notification.id);
    notificationsApi.markRead(notification.id).catch(() => {/* best-effort */});
  };

  useEffect(() => {
    timerRef.current = setTimeout(markRead, AUTO_DISMISS_MS);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notification.id]);

  const { title, body } = eventSummary(notification);
  const isError = notification.eventType === 'daemon_exit' || notification.eventType === 'auth_error';

  return (
    <div
      className={`flex items-start gap-3 p-3.5 rounded-xl border shadow-xl
        backdrop-blur-sm animate-in slide-in-from-right-4 duration-300
        ${isError
          ? 'bg-amber-950/90 border-amber-800/60'
          : 'bg-gray-900/95 border-gray-700/80'}`}
      style={{ minWidth: 280, maxWidth: 340 }}
    >
      {/* Icon */}
      <div className="mt-0.5">
        <EventIcon eventType={notification.eventType} />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-100 leading-tight">{title}</p>
        {body && (
          <p className="text-xs text-gray-400 mt-0.5 leading-relaxed whitespace-pre-line line-clamp-2">
            {body}
          </p>
        )}
        <p className="text-[10px] text-gray-600 mt-1">
          {new Date(notification.timestamp).toLocaleTimeString(i18nInstance.language, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
        </p>
      </div>

      {/* Close — marks as read (does not delete) */}
      <button
        onClick={markRead}
        className="flex-shrink-0 text-gray-600 hover:text-gray-300 transition-colors mt-0.5"
      >
        <X size={13} />
      </button>
    </div>
  );
}

// ── Main container ────────────────────────────────────────────────────────────

export function NotificationToasts() {
  // Start the Socket.IO connection (side-effect hook)
  useNotifications();

  const notifications = useStore((s) => s.notifications);
  // Show only the latest 5 unread as toasts
  const visible = notifications.filter((n) => !n.read).slice(0, 5);

  if (visible.length === 0) return null;

  return (
    <div
      className="fixed bottom-6 right-6 z-50 flex flex-col gap-2.5 pointer-events-none"
      aria-live="polite"
    >
      {visible.map((n) => (
        <div key={n.id} className="pointer-events-auto">
          <Toast notification={n} />
        </div>
      ))}
    </div>
  );
}

// ── Unread notifications counter badge ────────────────────────────────────────

export function NotificationBadge() {
  const unread = useStore((s) => s.notifications.filter((n) => !n.read).length);
  if (unread === 0) return null;
  return (
    <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 flex items-center justify-center
      text-[9px] font-bold bg-blue-600 text-white rounded-full leading-none">
      {unread > 9 ? '9+' : unread}
    </span>
  );
}
