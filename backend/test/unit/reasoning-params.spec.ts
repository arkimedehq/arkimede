// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { reasoningModelKwargs, supportedReasoningEfforts } from '../../src/llm-configs/reasoning-params';
import { describe, it, expect } from 'vitest';

describe('reasoningModelKwargs', () => {
  it('sends nothing without a setting', () => {
    expect(reasoningModelKwargs('deepseek', null)).toEqual({});
    expect(reasoningModelKwargs('openai-compatible', undefined)).toEqual({});
  });

  it('turns thinking off on DeepSeek', () => {
    expect(reasoningModelKwargs('deepseek', 'off')).toEqual({ thinking: { type: 'disabled' } });
  });

  it('sets the effort on OpenAI-style providers', () => {
    expect(reasoningModelKwargs('deepseek', 'low')).toEqual({ reasoning_effort: 'low' });
    expect(reasoningModelKwargs('openai-compatible', 'high')).toEqual({ reasoning_effort: 'high' });
  });

  it('ignores values a provider does not support', () => {
    expect(reasoningModelKwargs('openai-compatible', 'off')).toEqual({});
    expect(reasoningModelKwargs('anthropic', 'low')).toEqual({});
    expect(supportedReasoningEfforts('gemini')).toEqual([]);
  });
});
