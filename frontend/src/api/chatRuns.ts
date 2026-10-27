// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * The agent run in progress in a chat: what the agent is doing (step, phase, tool),
 * read once with GET when the chat opens and then followed on the notifications
 * socket (`chat_run` events of the room the page watches). A run goes on when the
 * page that sent the message reloads or closes; `run: null` = it ended.
 */
import type { Socket } from 'socket.io-client';
import api from './client';

export type ChatRunPhase = 'starting' | 'model' | 'preparing' | 'tool' | 'writing' | 'team';

export interface ChatRunState {
  chatId: string;
  runId: string;
  startedAt: string;
  step: number;
  phase: ChatRunPhase;
  phaseSince: string;
  tool: string | null;
  argsChars: number;
  recent: { at: string; tool: string; ok: boolean; durationMs?: number }[];
  /** Files produced so far (downloaded by id; attached to the answer at the end). */
  files: { name: string; fileId: string; downloadUrl: string }[];
}

export interface ChatRunEvent {
  chatId: string;
  run: ChatRunState | null;
  messageId?: string | null;
}

export const chatRunsApi = {
  get: (chatId: string) =>
    api.get<{ run: ChatRunState | null }>(`/chats/${chatId}/run`).then((r) => r.data.run),
  cancel: (chatId: string) =>
    api.post<{ cancelled: boolean }>(`/chats/${chatId}/run/cancel`).then((r) => r.data.cancelled),
};

// ── Socket: watch a chat's run ───────────────────────────────────────────────
// The socket belongs to useNotifications (one per page); a chat window may mount
// before or after it connects, so the watched chats are kept here and watched
// again on every (re)connection (rooms do not survive a reconnection).

let socket: Socket | null = null;
const listeners = new Map<string, Set<(event: ChatRunEvent) => void>>();
const memoryListeners = new Map<string, Set<(proposals: { id: string; content: string }[]) => void>>();

const watch = (chatId: string) => socket?.connected && socket.emit('watch', { kind: 'chat', id: chatId });

function onConnect() {
  for (const chatId of listeners.keys()) watch(chatId);
}

function onRun(event: ChatRunEvent) {
  listeners.get(event?.chatId)?.forEach((cb) => cb(event));
}

/** Memory proposals arrive to the user (not to a chat room): routed by their chat. */
function onMemory(event: { chatId: string; proposals: { id: string; content: string }[] }) {
  memoryListeners.get(event?.chatId)?.forEach((cb) => cb(event.proposals ?? []));
}

export function attachChatRunSocket(s: Socket): () => void {
  socket = s;
  s.on('connect', onConnect);
  s.on('chat_run', onRun);
  s.on('memory_proposal', onMemory);
  if (s.connected) onConnect();
  return () => {
    s.off('connect', onConnect);
    s.off('chat_run', onRun);
    s.off('memory_proposal', onMemory);
    if (socket === s) socket = null;
  };
}

/** Follows the run of CHAT_ID; returns the function that stops following it. */
export function watchChatRun(chatId: string, cb: (event: ChatRunEvent) => void): () => void {
  let set = listeners.get(chatId);
  if (!set) {
    set = new Set();
    listeners.set(chatId, set);
    watch(chatId);
  }
  set.add(cb);
  return () => {
    set!.delete(cb);
    if (set!.size === 0) {
      listeners.delete(chatId);
      if (socket?.connected) socket.emit('unwatch', { kind: 'chat', id: chatId });
    }
  };
}

/** Receives the memory proposals extracted from CHAT_ID (the user's own, from any of their pages). */
export function watchChatMemory(chatId: string, cb: (proposals: { id: string; content: string }[]) => void): () => void {
  let set = memoryListeners.get(chatId);
  if (!set) {
    set = new Set();
    memoryListeners.set(chatId, set);
  }
  set.add(cb);
  return () => {
    set!.delete(cb);
    if (set!.size === 0) memoryListeners.delete(chatId);
  };
}
