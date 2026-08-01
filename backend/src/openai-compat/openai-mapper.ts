// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file openai-mapper.ts
 *
 * Pure mapping helpers between the OpenAI chat-completions wire format and the
 * agent pipeline. Kept side-effect free so the whole translation layer is
 * unit-testable without Nest wiring.
 *
 * Design notes (voice-first integration):
 *  - Incoming `role: system` messages are DISCARDED: external callers ship
 *    their own prompt template, but the pipeline already builds the layered
 *    system prompt. Keeping both would mean conflicting instructions and wasted
 *    tokens on every ReAct iteration.
 *  - Tool events never surface as OpenAI `tool_calls`: tools run inside the
 *    agent; only text leaves the endpoint.
 */

export interface OpenAiChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool' | 'developer';
  content: string | Array<{ type: string; text?: string }> | null;
}

export interface OpenAiChatRequest {
  model?: string;
  messages: OpenAiChatMessage[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
}

export interface OpenAiUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** Flattens an OpenAI message content (string or content-part array) to text. */
export function contentToText(content: OpenAiChatMessage['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p?.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n');
  }
  return '';
}

/**
 * Splits the OpenAI `messages[]` into the pipeline inputs: the last user
 * message becomes `userInput`, prior user/assistant turns become `history`.
 * System/developer messages are discarded (see file header); `tool` messages
 * are skipped (tool traffic never round-trips through this endpoint).
 */
export function mapOpenAiMessages(messages: OpenAiChatMessage[]): {
  userInput: string;
  history: { role: 'user' | 'assistant'; content: string }[];
} {
  const turns = (messages ?? [])
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: contentToText(m.content) }))
    .filter((m) => m.content.trim() !== '');

  const last = turns.at(-1);
  if (!last || last.role !== 'user') {
    // No trailing user turn: treat the whole thing as history-less empty input;
    // the controller rejects this as an invalid request.
    return { userInput: '', history: turns };
  }
  return { userInput: last.content, history: turns.slice(0, -1) };
}

/** Stable slug for exposing agents as OpenAI "models" (and resolving them back). */
export function agentSlug(name: string): string {
  return (name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** One SSE frame of a chat.completion.chunk. */
export function chunkFrame(
  id: string,
  created: number,
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): string {
  return `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

/** Trailing usage frame (sent when the client asked for stream_options.include_usage). */
export function usageFrame(id: string, created: number, model: string, usage: OpenAiUsage): string {
  return `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [],
    usage,
  })}\n\n`;
}

/** Non-streaming chat.completion response body. */
export function completionBody(
  id: string,
  created: number,
  model: string,
  text: string,
  usage: OpenAiUsage,
) {
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: 'stop',
      },
    ],
    usage,
  };
}

/** OpenAI-shaped error body. */
export function errorBody(message: string, type = 'invalid_request_error') {
  return { error: { message, type, param: null, code: null } };
}

export function toOpenAiUsage(u: { inputTokens: number; outputTokens: number } | null): OpenAiUsage {
  const prompt = u?.inputTokens ?? 0;
  const completion = u?.outputTokens ?? 0;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}
