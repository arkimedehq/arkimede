// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * SpeechRequestDto: the global ValidationPipe enforces these rules on
 * POST /api/openai/v1/audio/speech (empty input → 400, format whitelist,
 * 4096-char cap like the OpenAI API).
 */
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { SpeechRequestDto } from '../../src/openai-compat/openai-audio.dto';

function build(body: Partial<SpeechRequestDto>): SpeechRequestDto {
  return Object.assign(new SpeechRequestDto(), body);
}

describe('SpeechRequestDto', () => {
  it('accepts a minimal valid body', () => {
    expect(validateSync(build({ input: 'Ciao, sono Arkimede' }))).toHaveLength(0);
  });

  it('accepts the full OpenAI-shaped body', () => {
    const dto = build({
      model: 'piper',
      voice: 'it_IT-paola-medium',
      input: 'Ciao',
      response_format: 'wav',
    });
    expect(validateSync(dto)).toHaveLength(0);
  });

  it('rejects a missing or empty input', () => {
    expect(validateSync(build({}))).not.toHaveLength(0);
    expect(validateSync(build({ input: '' }))).not.toHaveLength(0);
  });

  it('rejects input beyond the 4096-char cap', () => {
    expect(validateSync(build({ input: 'a'.repeat(4097) }))).not.toHaveLength(0);
  });

  it('rejects unsupported response formats', () => {
    expect(validateSync(build({ input: 'ok', response_format: 'ogg' as any }))).not.toHaveLength(0);
  });
});
