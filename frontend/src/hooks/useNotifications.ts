/**
 * @file useNotifications.ts
 *
 * Hook to:
 *   1. Load the notifications persisted in the DB at boot (when the user is authenticated)
 *   2. Keep the Socket.IO /notifications connection to receive notifications in real-time
 *
 * At boot: calls notificationsApi.list() and populates the store with setNotifications().
 * In real-time: every skill_event received via socket is added at the top of the store
 *   with the DB id included (so subsequent actions — dismiss, mark read — use the correct id).
 *
 * Socket event format received from the server:
 *   { id, daemon_id, skill_id, event_type, payload, timestamp }
 *   (id = UUID from the DB; may be null if the DB save failed)
 */
import { useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { useQueryClient } from '@tanstack/react-query';
import { useStore } from '../store/useStore';
import { notificationsApi } from '../api/notifications';

/** Derives the Socket.IO backend URL from the env or the current origin. */
function getSocketUrl(): string {
  const env = (import.meta as any).env;
  if (env?.VITE_BACKEND_URL) {
    return env.VITE_BACKEND_URL.replace(/\/$/, '');
  }
  return window.location.origin;
}

export function useNotifications() {
  const token            = useStore((s) => s.token);
  const addNote          = useStore((s) => s.addNotification);
  const setNotifications = useStore((s) => s.setNotifications);
  const socketRef        = useRef<Socket | null>(null);
  const qc               = useQueryClient();

  // ── 1. Load from the DB at boot ─────────────────────────────────────────────
  useEffect(() => {
    if (!token) return;

    notificationsApi.list()
      .then(setNotifications)
      .catch((err) => console.warn('[notifications] initial load error:', err));
  }, [token, setNotifications]);

  // ── 2. Socket.IO connection for real-time ──────────────────────────────────
  useEffect(() => {
    if (!token) return;

    const socket = io(`${getSocketUrl()}/notifications`, {
      transports: ['websocket', 'polling'],
      query:      { token },
      reconnection:           true,
      reconnectionDelay:      2_000,
      reconnectionDelayMax:   10_000,
      reconnectionAttempts:   Infinity,   // never give up: real-time must stay alive
    });

    socketRef.current = socket;

    socket.on('connect_error', (err) => {
      console.warn('[notifications] connection error:', err.message);
    });

    // On every (re)connection, reconcile with the DB: Socket.IO does NOT replay the events
    // emitted while the socket was disconnected, so we fetch them via HTTP. This way
    // toasts (unread) + bell stay aligned even after a network gap.
    socket.on('connect', () => {
      notificationsApi.list().then(setNotifications).catch(() => undefined);
    });

    /** All daemon events arrive as 'skill_event' */
    socket.on('skill_event', (data: {
      id?:        string | null;  // UUID from the DB (null if save failed)
      daemon_id:  string;
      skill_id:   string;
      event_type: string;
      payload:    Record<string, unknown>;
      timestamp:  string;
    }) => {
      addNote({
        // Use the DB id if available, otherwise generate a local UUID (fallback)
        id:        data.id ?? crypto.randomUUID(),
        daemonId:  data.daemon_id,
        skillId:   data.skill_id,
        eventType: data.event_type,
        payload:   data.payload,
        timestamp: data.timestamp ?? new Date().toISOString(),
        read:      false,
      });
    });

    /**
     * Automation outcomes (Auto-Scheduling) arrive as 'notification'.
     * Payload: { id, eventType, taskId, title, result, chatId, tokens, ... }.
     * The delivery chat is also marked unread by the backend → we invalidate
     * the chat list so the sidebar shows the badge right away.
     */
    socket.on('notification', (data: {
      id?:        string | null;
      eventType:  string;
      payload?:   Record<string, unknown>;
      [k: string]: unknown;
    }) => {
      addNote({
        id:        data.id ?? crypto.randomUUID(),
        eventType: data.eventType,
        payload:   data,   // title/result/chatId are at the top of the object
        timestamp: new Date().toISOString(),
        read:      false,
      });
      if (data.chatId) {
        qc.invalidateQueries({ queryKey: ['chats'] });
        // If the delivery chat is open, make the new message appear right away.
        qc.invalidateQueries({ queryKey: ['messages', data.chatId] });
      }
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [token, addNote, qc, setNotifications]);

  return socketRef;
}
