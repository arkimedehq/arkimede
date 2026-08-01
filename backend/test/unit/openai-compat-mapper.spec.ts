// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * OpenAI-compat translation layer: request splitting (system prompt discarded,
 * tool turns skipped, content-part arrays flattened), agent slugs, SSE frame
 * shape and usage mapping. Pure functions — no Nest wiring involved.
 */
import { describe, expect, it } from 'vitest';
import {
  agentSlug, chunkFrame, completionBody, contentToText, errorBody,
  mapOpenAiMessages, toOpenAiUsage, usageFrame,
} from '../../src/openai-compat/openai-mapper';

describe('mapOpenAiMessages', () => {
  it('uses the last user message as input and prior turns as history', () => {
    const { userInput, history } = mapOpenAiMessages([
      { role: 'system', content: 'external template — must be discarded' },
      { role: 'user', content: 'accendi la luce' },
      { role: 'assistant', content: 'Fatto.' },
      { role: 'user', content: 'e ora spegnila' },
    ]);
    expect(userInput).toBe('e ora spegnila');
    expect(history).toEqual([
      { role: 'user', content: 'accendi la luce' },
      { role: 'assistant', content: 'Fatto.' },
    ]);
  });

  it('discards system/developer/tool messages entirely', () => {
    const { userInput, history } = mapOpenAiMessages([
      { role: 'developer', content: 'dev prompt' },
      { role: 'tool', content: '{"result":42}' },
      { role: 'user', content: 'ciao' },
    ]);
    expect(userInput).toBe('ciao');
    expect(history).toEqual([]);
  });

  it('flattens content-part arrays to text', () => {
    const { userInput } = mapOpenAiMessages([
      { role: 'user', content: [{ type: 'text', text: 'riga 1' }, { type: 'text', text: 'riga 2' }] },
    ]);
    expect(userInput).toBe('riga 1\nriga 2');
  });

  it('returns an empty input when the last turn is not from the user', () => {
    const { userInput } = mapOpenAiMessages([
      { role: 'user', content: 'ciao' },
      { role: 'assistant', content: 'ciao!' },
    ]);
    expect(userInput).toBe('');
  });

  it('contentToText tolerates null and unknown part types', () => {
    expect(contentToText(null)).toBe('');
    expect(contentToText([{ type: 'image_url' }, { type: 'text', text: 'ok' }])).toBe('ok');
  });
});

describe('agentSlug', () => {
  it('slugifies names with spaces, case and accents', () => {
    expect(agentSlug('Voce Casa')).toBe('voce-casa');
    expect(agentSlug('Città  &  Meteo!')).toBe('citta-meteo');
  });
});

describe('SSE frames and bodies', () => {
  it('chunkFrame emits a valid chat.completion.chunk with delta', () => {
    const frame = chunkFrame('chatcmpl-1', 123, 'arkimede', { content: 'ciao' });
    expect(frame.startsWith('data: ')).toBe(true);
    expect(frame.endsWith('\n\n')).toBe(true);
    const parsed = JSON.parse(frame.slice(6));
    expect(parsed.object).toBe('chat.completion.chunk');
    expect(parsed.choices[0].delta.content).toBe('ciao');
    expect(parsed.choices[0].finish_reason).toBeNull();
  });

  it('finish frame carries finish_reason stop and empty delta', () => {
    const parsed = JSON.parse(chunkFrame('c', 1, 'm', {}, 'stop').slice(6));
    expect(parsed.choices[0].finish_reason).toBe('stop');
    expect(parsed.choices[0].delta).toEqual({});
  });

  it('usageFrame has empty choices and the usage object', () => {
    const parsed = JSON.parse(usageFrame('c', 1, 'm', toOpenAiUsage({ inputTokens: 10, outputTokens: 5 })).slice(6));
    expect(parsed.choices).toEqual([]);
    expect(parsed.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });

  it('completionBody shapes the non-streaming response', () => {
    const body = completionBody('c', 1, 'arkimede', 'risposta', toOpenAiUsage(null));
    expect(body.choices[0].message).toEqual({ role: 'assistant', content: 'risposta' });
    expect(body.choices[0].finish_reason).toBe('stop');
    expect(body.usage.total_tokens).toBe(0);
  });

  it('errorBody follows the OpenAI error envelope', () => {
    expect(errorBody('boom', 'server_error')).toEqual({
      error: { message: 'boom', type: 'server_error', param: null, code: null },
    });
  });
});
