// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Conversation focus of external satellites: set, refresh, clear, expiry, the
 * per-user scope, and the "fresh since" mark that makes the next unfocused turn
 * start a new conversation.
 */
import { describe, expect, it } from 'vitest';
import {
  ConversationFocusService, FOCUS_DEFAULT_TTL_MS, FOCUS_MAX_TTL_MS, satelliteName,
} from '../../src/chats/conversation-focus.service';

const T0 = 1_000_000;

describe('ConversationFocusService', () => {
  it('sends a satellite into the focused chat until it is cleared', () => {
    const f = new ConversationFocusService();
    f.set('u1', 'sat.living', 'chat-a', FOCUS_DEFAULT_TTL_MS, T0);
    expect(f.get('u1', 'sat.living', T0 + 1)).toBe('chat-a');
    f.clear('u1', 'sat.living', T0 + 10);
    expect(f.get('u1', 'sat.living', T0 + 11)).toBeNull();
    expect(f.freshSince('u1', 'sat.living', T0 + 11)).toBe(T0 + 10);
  });

  it('is per satellite and per user', () => {
    const f = new ConversationFocusService();
    f.set('u1', 'sat.living', 'chat-a', FOCUS_DEFAULT_TTL_MS, T0);
    expect(f.get('u1', 'sat.kitchen', T0)).toBeNull();
    expect(f.get('u2', 'sat.living', T0)).toBeNull();
    expect(f.list('u1', T0).map((v) => v.satellite)).toEqual(['sat.living']);
    expect(f.list('u2', T0)).toEqual([]);
  });

  it('expires, and the expiry counts as the end of the focus', () => {
    const f = new ConversationFocusService();
    f.set('u1', 's', 'chat-a', 60_000, T0);
    expect(f.get('u1', 's', T0 + 59_999)).toBe('chat-a');
    expect(f.get('u1', 's', T0 + 60_000)).toBeNull();
    expect(f.freshSince('u1', 's', T0 + 70_000)).toBe(T0 + 60_000);
  });

  it('a refresh moves the expiry; the TTL is capped', () => {
    const f = new ConversationFocusService();
    f.set('u1', 's', 'chat-a', 60_000, T0);
    f.set('u1', 's', 'chat-a', 60_000, T0 + 50_000);
    expect(f.get('u1', 's', T0 + 100_000)).toBe('chat-a');
    const v = f.set('u1', 's', 'chat-a', 10 * FOCUS_MAX_TTL_MS, T0);
    expect(Date.parse(v.expiresAt)).toBe(T0 + FOCUS_MAX_TTL_MS);
  });

  it('a satellite never focused has no fresh mark; no satellite, no focus', () => {
    const f = new ConversationFocusService();
    expect(f.freshSince('u1', 's', T0)).toBeNull();
    expect(f.get('u1', null, T0)).toBeNull();
    f.clear('u1', 'never-set', T0);
    expect(f.freshSince('u1', 'never-set', T0)).toBeNull();
  });
});

describe('satelliteName', () => {
  it('trims, caps and drops empty or non-string values', () => {
    expect(satelliteName('  assist_satellite.living ')).toBe('assist_satellite.living');
    expect(satelliteName('')).toBeNull();
    expect(satelliteName('   ')).toBeNull();
    expect(satelliteName(42)).toBeNull();
    expect(satelliteName(undefined)).toBeNull();
    expect(satelliteName('x'.repeat(300))!.length).toBe(200);
  });
});
