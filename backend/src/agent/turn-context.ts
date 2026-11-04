// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Per-request context (current date/time, conversation summary, feedback
 * corrections, retrieved memories, Recordare context) carried by the turn's user
 * message instead of the system message.
 *
 * Providers with an automatic prefix cache (OpenAI, DeepSeek, Gemini, local
 * servers) reuse a request's tokens only up to the first one that differs from
 * the previous request. The request reads: system message → tool definitions →
 * conversation. With the per-request blocks at the end of the system message, the
 * cache stopped right there and the tool definitions (often most of the prompt)
 * were never reused; in the user message they come after the stable system prompt
 * and tools, so the whole stable part is cached. (Anthropic keeps them in the
 * system message, after its explicit cache marker.)
 */
import { BaseMessage, HumanMessage } from '@langchain/core/messages';

/** Heading that separates the context blocks from the user's own words. */
export const TURN_MESSAGE_HEADING = "## The user's message";

/**
 * Copy of `messages` whose last user message — the current turn's — starts with
 * `context`. Earlier user messages stay as they were, so the conversation prefix
 * of the next turn matches. Without a user message the context is added as one.
 */
export function withTurnContext(messages: BaseMessage[], context: string): BaseMessage[] {
  if (!context.trim()) return messages;
  const at = messages.map((m) => m._getType()).lastIndexOf('human');
  if (at < 0) return [...messages, new HumanMessage(context)];

  const turn = messages[at];
  const content = typeof turn.content === 'string'
    ? `${context}\n\n${TURN_MESSAGE_HEADING}\n${turn.content}`
    : [{ type: 'text', text: `${context}\n\n${TURN_MESSAGE_HEADING}` }, ...turn.content];
  const out = [...messages];
  out[at] = new HumanMessage({
    content: content as any,
    additional_kwargs: turn.additional_kwargs,
    response_metadata: turn.response_metadata,
    ...(turn.id ? { id: turn.id } : {}),
    ...(turn.name ? { name: turn.name } : {}),
  });
  return out;
}
