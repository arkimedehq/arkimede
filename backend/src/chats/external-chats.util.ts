// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Pure grouping rules for external conversations (see ExternalChatsService).
 *
 * A new turn continues the latest chat with the same source/key when:
 *   1. the chat is not idle (last activity within the source's idle window), and
 *   2. when the source has no conversation id of its own, the history resent by the
 *      client is coherent with the chat: the chat's last user message is among the
 *      most recent user messages of that history.
 *
 * Only user messages are compared: clients may rewrite assistant replies before
 * storing them (e.g. stripping markdown for TTS), never the user's own words.
 * Looking at the tail of the history keeps working when the client slides its
 * window (oldest messages dropped).
 */

/** How many trailing user messages of the incoming history are searched. */
export const COHERENCE_TAIL = 3;

/** Comparison form of a message: case-insensitive, whitespace-collapsed. */
export function normalizeTurnText(text: string): string {
  return (text ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * True when an incoming history can continue a chat whose last user message is
 * `lastStoredUserText`. An empty history always qualifies (single-message
 * clients: the idle window alone decides); a chat without user messages never does.
 */
export function isCoherentContinuation(
  lastStoredUserText: string | null,
  priorUserTexts: string[],
): boolean {
  if (!priorUserTexts.length) return true;
  if (!lastStoredUserText) return false;
  const wanted = normalizeTurnText(lastStoredUserText);
  return priorUserTexts.slice(-COHERENCE_TAIL).some((t) => normalizeTurnText(t) === wanted);
}

/** True when the chat's last activity is within the idle window. */
export function isWithinIdleWindow(lastActivity: Date, idleMs: number, now = Date.now()): boolean {
  return now - new Date(lastActivity).getTime() <= idleMs;
}
