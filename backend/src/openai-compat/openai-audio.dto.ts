// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { TtsFormat } from '../tts/tts.service';

/**
 * OpenAI-compatible `POST /v1/audio/speech` request body.
 * Field names follow the OpenAI wire format (snake_case for response_format).
 */
export class SpeechRequestDto {
  /** Accepted for OpenAI compatibility; the configured TTS provider decides. */
  @IsOptional()
  @IsString()
  model?: string;

  /** Voice id (e.g. a Piper voice like en_US-lessac-medium, or 'alloy' for OpenAI). */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  voice?: string;

  /** The text to synthesize. Length-capped like the OpenAI API. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  input: string;

  /** Output format. v1: 'wav' (internal Piper) or 'mp3' (cloud providers). */
  @IsOptional()
  @IsIn(['wav', 'mp3'])
  response_format?: TtsFormat;
}
