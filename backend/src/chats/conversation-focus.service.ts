// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file conversation-focus.service.ts
 *
 * Conversation focus of external satellites: a client that shows the
 * conversation (e.g. a wall screen next to a voice satellite) can say "the
 * turns of satellite S go into chat C". While a focus is set, the external
 * entry points (Wyoming conversation agent, OpenAI-compatible endpoint) run the
 * satellite's turns inside that chat, with its stored history as context, and
 * append them there; without one they keep their usual grouping.
 *
 * Kept in memory with an expiry: the client refreshes the focus while it holds
 * it, so a client that disappears (or a backend restart) never leaves a
 * satellite talking into an old chat. Clearing (or expiring) marks the moment:
 * the satellite's next unfocused turn starts a new conversation even inside the
 * entry point's idle window.
 *
 * A satellite is the name its entry point reports: Wyoming
 * `context.satellite_id` (the hub's satellite entity), the OpenAI `user` field.
 * Focus and names are per user (the user the entry point runs as).
 */
import { Injectable } from '@nestjs/common';

export const FOCUS_DEFAULT_TTL_MS = 15 * 60 * 1000;
export const FOCUS_MAX_TTL_MS = 60 * 60 * 1000;
export const SATELLITE_MAX = 200;
/** Messages of the focused chat given to the agent as history. */
export const FOCUS_HISTORY_MESSAGES = 40;

interface Focus {
  chatId: string;
  expiresAt: number;
}

export interface FocusView {
  satellite: string;
  chatId: string;
  expiresAt: string;
}

@Injectable()
export class ConversationFocusService {
  private readonly focus = new Map<string, Focus>();
  /** When the satellite's last focus ended: unfocused turns start fresh after it. */
  private readonly endedAt = new Map<string, number>();

  set(userId: string, satellite: string, chatId: string, ttlMs = FOCUS_DEFAULT_TTL_MS, now = Date.now()): FocusView {
    const ttl = Math.min(Math.max(ttlMs, 1000), FOCUS_MAX_TTL_MS);
    const k = key(userId, satellite);
    this.focus.set(k, { chatId, expiresAt: now + ttl });
    return view(satellite, this.focus.get(k)!);
  }

  clear(userId: string, satellite: string, now = Date.now()): void {
    const k = key(userId, satellite);
    if (this.focus.delete(k)) this.endedAt.set(k, now);
  }

  /** The satellite's focused chat, if a focus is set and not expired. */
  get(userId: string, satellite: string | null, now = Date.now()): string | null {
    if (!satellite) return null;
    const k = key(userId, satellite);
    const f = this.focus.get(k);
    if (!f) return null;
    if (f.expiresAt <= now) {
      this.focus.delete(k);
      this.endedAt.set(k, f.expiresAt);
      return null;
    }
    return f.chatId;
  }

  /**
   * When the satellite's last focus ended (cleared or expired), if it had one:
   * an unfocused turn must not continue a conversation older than this.
   */
  freshSince(userId: string, satellite: string | null, now = Date.now()): number | null {
    if (!satellite) return null;
    this.get(userId, satellite, now);   // turns an expired focus into an end
    return this.endedAt.get(key(userId, satellite)) ?? null;
  }

  list(userId: string, now = Date.now()): FocusView[] {
    const prefix = `${userId}\n`;
    return [...this.focus.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length))
      .filter((s) => this.get(userId, s, now))
      .map((s) => view(s, this.focus.get(key(userId, s))!));
  }
}

/** A satellite name as reported by an entry point: trimmed, capped, null when empty. */
export function satelliteName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim().slice(0, SATELLITE_MAX);
  return name || null;
}

function key(userId: string, satellite: string): string {
  return `${userId}\n${satellite}`;
}

function view(satellite: string, f: Focus): FocusView {
  return { satellite, chatId: f.chatId, expiresAt: new Date(f.expiresAt).toISOString() };
}
