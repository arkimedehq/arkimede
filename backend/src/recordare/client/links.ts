// GENERATED from recordare packages/client/src/links.ts @ 42a6729 — do not edit here: change the library and run
// packages/client/scripts/sync-to.sh again.
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * D51 — linking the holder's channel identity by one-time code. The holder makes a code (`RecordareClient.linkCode`),
 * sends it to the agent from the channel, then confirms the claim (`holderIdentities` / `confirmHolderClaim`). Recordare
 * never stores the code's message; a host that sees the message before its model can tell the model what it is.
 */

/** A message that is only a link code (dashes and a final dot optional, any case) — the service's own pattern. */
export const LINK_CODE = /^\s*RCD-?[0-9A-Z]{4}-?[0-9A-Z]{4}\.?\s*$/i;

export function isLinkCode(text: string): boolean {
  return LINK_CODE.test(text);
}

/** What a host adds for its model when the user's message is a link code (the model would otherwise try to answer it). */
export const LINK_CODE_INSTRUCTION = 'The user\'s last message is a one-time code that links their account on this channel to their '
  + 'memory (Recordare); it is handled automatically. Reply only, briefly and in the user\'s language, that the code was '
  + 'received and that they now confirm the link where they created the code. Do not repeat the code.';
