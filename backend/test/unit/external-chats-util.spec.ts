// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Grouping rules of persisted external conversations: when a turn continues
 * the open chat and when it starts a new one. Covers the client shapes seen in
 * practice — full history, sliding window, single-message, rewritten replies,
 * client restart.
 */
import { describe, expect, it } from 'vitest';
import {
  COHERENCE_TAIL, isCoherentContinuation, isWithinIdleWindow, normalizeTurnText,
} from '../../src/chats/external-chats.util';

describe('normalizeTurnText', () => {
  it('ignores case and collapses whitespace', () => {
    expect(normalizeTurnText('  Turn ON\n the   light ')).toBe('turn on the light');
  });
});

describe('isCoherentContinuation', () => {
  it('continues when the last stored user message is the last one resent', () => {
    expect(isCoherentContinuation('second question', ['first question', 'second question'])).toBe(true);
  });

  it('tolerates whitespace/case differences in the resent text', () => {
    expect(isCoherentContinuation('Second  question', ['second question '])).toBe(true);
  });

  it('keeps matching when the client slides its window (oldest messages dropped)', () => {
    const window = ['q7', 'q8', 'q9'];   // q1..q6 already dropped by the client
    expect(isCoherentContinuation('q9', window)).toBe(true);
  });

  it('only searches the recent tail of the resent history', () => {
    const history = ['old', ...Array.from({ length: COHERENCE_TAIL }, (_, i) => `recent ${i}`)];
    expect(isCoherentContinuation('old', history)).toBe(false);
  });

  it('starts a new chat when the resent history belongs to another conversation', () => {
    expect(isCoherentContinuation('weather tomorrow?', ['turn on the kitchen light'])).toBe(false);
  });

  it('continues single-message clients (no history): the idle window decides', () => {
    expect(isCoherentContinuation('anything', [])).toBe(true);
  });

  it('never continues a chat without user messages when a history is resent', () => {
    expect(isCoherentContinuation(null, ['q1'])).toBe(false);
  });
});

describe('isWithinIdleWindow', () => {
  const now = Date.parse('2026-10-05T10:00:00Z');
  it('is open inside the window and closed after it', () => {
    expect(isWithinIdleWindow(new Date(now - 5 * 60_000), 10 * 60_000, now)).toBe(true);
    expect(isWithinIdleWindow(new Date(now - 11 * 60_000), 10 * 60_000, now)).toBe(false);
  });
});
