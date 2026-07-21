// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file useStore.ts
 *
 * Global application store with Zustand + localStorage persistence.
 *
 * The store manages three state areas:
 *
 *   Auth      — JWT token and current user data
 *   UI        — navigation state (sidebar, active project, active chat, view)
 *   Streaming — content and state of the in-progress AI response (SSE)
 *   Tool      — queue of active tool calls during the agent's reasoning
 *
 * Persistence (zustand/middleware persist):
 *   Only token, user and activeProjectId are saved to localStorage
 *   (`partialize` field). The ephemeral UI state (sidebar, streaming, tool calls)
 *   is reset on every reload to avoid inconsistent states.
 *
 *   The localStorage key is "arkimede-store".
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** Authenticated user data (subset of the backend User entity). */
export interface User {
  id:    string;
  email: string;
  name:  string;
  role:  string;
}

/** Project (used to group chats). */
export interface Project {
  id:            string;
  name:          string;
  description?:  string;
  color?:        string;
  systemPrompt?: string | null;
  /** Project owner (null if orphaned). Used to decide who can manage sharing. */
  userId?:       string | null;
  createdAt:     string;
  updatedAt:     string;
}

/** Chat (conversation with the agent). */
export interface Chat {
  id:        string;
  title:     string;
  projectId?: string;
  /** If set, the chat runs with an agent team (Multi-Agent). */
  agentTeamId?: string | null;
  /** Chat author (= userId). In a shared project distinguishes your own from others'. */
  userId?:    string;
  authorId?:  string;
  authorName?: string | null;
  /** True if the current user can write in this chat (author or project collaborator). */
  canWrite?:  boolean;
  /** Total input/output tokens summed over the chat's messages. */
  totalInputTokens?:  number;
  totalOutputTokens?: number;
  /** True if the chat has content not yet seen (e.g. automation outcome). */
  unread?:    boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Message in a chat.
 * Attachments have three modes:
 *   - embed:      indexed in the RAG (vectorized in Qdrant)
 *   - inline:     extracted text included directly in the message
 *   - attachment: sent as a multimodal content block (native images/PDF)
 */
export interface Message {
  id:      string;
  role:    'user' | 'assistant' | 'system';
  content: string;
  /** Author of the user message (shared threads). null for assistant/system. */
  authorId?:   string | null;
  authorName?: string | null;
  attachments?: {
    name:     string;
    fileId:   string;
    mimeType: string;
    mode?:    'embed' | 'inline' | 'attachment';
  }[];
  /** Input tokens (prompt+history) used to generate this message (assistant only). */
  inputTokens?:  number | null;
  /** Output tokens (generated text) of this message (assistant only). */
  outputTokens?: number | null;
  /** History/debug of the tool calls made for this message (assistant only). */
  toolCalls?: ToolCallRecord[] | null;
  createdAt: string;
}

/** A tool call executed during the generation of an assistant message. */
export interface ToolCallRecord {
  name:        string;
  input:       any;
  output?:     any;
  ok?:         boolean;
  startedAt?:  number;
  durationMs?: number;
}

/** Live tool call shown during streaming. ok === undefined = still running. */
export interface PendingToolCall {
  name:        string;
  input?:      any;
  ok?:         boolean;
  startedAt:   number;
  durationMs?: number;
}

// ── Notification type ─────────────────────────────────────────────────────────

export interface SkillNotification {
  id:        string;
  daemonId?:  string;                   // absent for non-daemon notifications (e.g. automations)
  skillId?:   string;
  eventType: string;                    // 'new_emails', 'daemon_exit', 'scheduled_task', etc.
  payload:   Record<string, unknown>;
  timestamp: string;
  read:      boolean;
}

interface AppStore {
  // ── Auth ────────────────────────────────────────────────────────────────────

  /** Current JWT token (null = not authenticated). */
  token: string | null;
  /** Authenticated user data. */
  user:  User | null;
  /** Sets token and user after login/register. */
  setAuth:  (token: string, user: User) => void;
  /** Clears token, user and active context (logout). */
  logout: () => void;

  // ── UI ──────────────────────────────────────────────────────────────────────

  sidebarOpen:     boolean;
  activeProjectId: string | null;
  activeChatId:    string | null;
  /** Current view: 'chat' (default) or 'settings'. */
  activeView:      'chat' | 'settings';
  /** Files panel open in the current chat. */
  filesPanelOpen:  boolean;

  setSidebarOpen:   (v: boolean) => void;
  setActiveProject: (id: string | null) => void;
  /** Opens a chat and forces the 'chat' view. */
  setActiveChat:    (id: string | null) => void;
  /**
   * Changes the view.
   * When switching to 'settings', activeChatId is cleared (no active chat).
   * When switching back to 'chat', activeChatId stays unchanged (undefined = no change).
   */
  setActiveView:      (v: 'chat' | 'settings') => void;
  setFilesPanelOpen:  (v: boolean) => void;

  // ── Chat control (GlobalHeader → ChatWindow) ─────────────────────────────────

  /**
   * Callback registered by ChatWindow to stop the streaming.
   * GlobalHeader calls it when clicking Stop. null when no chat is mounted.
   */
  stopStreamingFn: (() => void) | null;
  registerStopFn:  (fn: (() => void) | null) => void;

  // ── Streaming (risposta AI in tempo reale) ───────────────────────────────────

  /** Accumulated text of the AI response during SSE streaming. */
  streamingContent: string;
  /** True while the agent is generating the response. */
  isStreaming:      boolean;

  /** Replaces the entire streaming content (used for reset). */
  setStreamingContent:    (v: string) => void;
  /** Appends a chunk to the streaming content (called for each SSE event). */
  appendStreamingContent: (v: string) => void;
  setIsStreaming:         (v: boolean) => void;

  // ── Tool calls ───────────────────────────────────────────────────────────────

  /**
   * Queue of active tool calls during the agent's reasoning.
   * Shown in the UI as live indicators: running (spinner) → ✓/✗ once the result is received.
   */
  pendingToolCalls: PendingToolCall[];
  addToolCall:      (call: { name: string; input?: any }) => void;
  /** Marks the first call with that name still running as completed (✓/✗); backfills input. */
  resolveToolCall:  (name: string, ok: boolean, input?: any) => void;
  clearToolCalls:   () => void;

  // ── Daemon notifications ─────────────────────────────────────────────────────

  /** Notifications (loaded from the DB at startup + updated in real-time via Socket.IO). */
  notifications: SkillNotification[];
  /** Replaces the entire array (used at boot to load from the DB). */
  setNotifications:     (ns: SkillNotification[]) => void;
  /** Adds a new notification at the top (max 100 in memory). */
  addNotification:      (n: SkillNotification) => void;
  /** Marks a notification as read (local update; the API call is separate). */
  markNotificationRead:    (id: string) => void;
  /** Marks all notifications as read (local update). */
  markAllNotificationsRead: () => void;
  /** Removes a specific notification (local update; the API call is separate). */
  dismissNotification:  (id: string) => void;
  /** Removes all notifications (local update). */
  clearNotifications:   () => void;
}

export const useStore = create<AppStore>()(
  persist(
    (set) => ({
      // ── Auth ────────────────────────────────────────────────────────────────
      token:   null,
      user:    null,
      setAuth: (token, user) => set({ token, user }),
      logout:  () => set({ token: null, user: null, activeChatId: null, activeProjectId: null }),

      // ── UI ──────────────────────────────────────────────────────────────────
      sidebarOpen:     true,
      activeProjectId: null,
      activeChatId:    null,
      activeView:      'chat',
      filesPanelOpen:  false,

      setSidebarOpen:   (v)  => set({ sidebarOpen: v }),
      setActiveProject: (id) => set({ activeProjectId: id }),
      setActiveChat:    (id) => set({ activeChatId: id, activeView: 'chat', filesPanelOpen: false }),
      setActiveView:    (v)  => set({
        activeView:   v,
        // undefined = does not change activeChatId; null = clears activeChatId
        activeChatId: v === 'settings' ? null : undefined,
      }),
      setFilesPanelOpen: (v) => set({ filesPanelOpen: v }),

      // ── Chat control ────────────────────────────────────────────────────────
      stopStreamingFn: null,
      registerStopFn:  (fn) => set({ stopStreamingFn: fn }),

      // ── Streaming ───────────────────────────────────────────────────────────
      streamingContent:       '',
      isStreaming:            false,
      setStreamingContent:    (v) => set({ streamingContent: v }),
      appendStreamingContent: (v) => set((s) => ({ streamingContent: s.streamingContent + v })),
      setIsStreaming:         (v) => set({ isStreaming: v }),

      // ── Tool calls ─────────────────────────────────────────────────────────
      pendingToolCalls: [],
      addToolCall:      (call) => set((s) => ({
        pendingToolCalls: [...s.pendingToolCalls, { name: call.name, input: call.input, startedAt: Date.now() }],
      })),
      resolveToolCall:  (name, ok, input) => set((s) => {
        // Marks the first call with that name still running (ok === undefined)
        const idx = s.pendingToolCalls.findIndex((c) => c.name === name && c.ok === undefined);
        if (idx === -1) return {};
        const updated = [...s.pendingToolCalls];
        // The full tool args are only known at result time (they stream as deltas): backfill
        // input so the live indicator can label e.g. run_in_sandbox:<skill>.
        updated[idx] = {
          ...updated[idx],
          ok,
          durationMs: Date.now() - updated[idx].startedAt,
          ...(input !== undefined ? { input } : {}),
        };
        return { pendingToolCalls: updated };
      }),
      clearToolCalls:   ()     => set({ pendingToolCalls: [] }),

      // ── Daemon notifications ─────────────────────────────────────────────
      notifications: [],
      setNotifications: (ns) => set({ notifications: ns }),
      addNotification: (n) => set((s) => ({
        // Keep max 100 notifications in memory; most recent at the top
        // Avoid duplicates (same DB id already present)
        notifications: s.notifications.some((x) => x.id === n.id)
          ? s.notifications
          : [n, ...s.notifications].slice(0, 100),
      })),
      markNotificationRead: (id) => set((s) => ({
        notifications: s.notifications.map((n) => n.id === id ? { ...n, read: true } : n),
      })),
      markAllNotificationsRead: () => set((s) => ({
        notifications: s.notifications.map((n) => ({ ...n, read: true })),
      })),
      dismissNotification: (id) => set((s) => ({
        notifications: s.notifications.filter((n) => n.id !== id),
      })),
      clearNotifications: () => set({ notifications: [] }),
    }),
    {
      name: 'arkimede-store',
      /**
       * Persists only the minimal subset needed to reload without re-login:
       *   - token: keeps the authenticated session
       *   - user: avoids an API request at boot to fetch the user data
       *   - activeProjectId: remembers the project open in the last session
       *
       * Notifications are NOT persisted to localStorage: they are loaded
       * from the DB at boot via notificationsApi.list() (in useNotifications).
       * The ephemeral UI state (streaming, tool calls, activeChatId) is NOT
       * persisted to avoid inconsistent states after a reload during streaming.
       */
      partialize: (s) => ({
        token:           s.token,
        user:            s.user,
        activeProjectId: s.activeProjectId,
      }),
    },
  ),
);
