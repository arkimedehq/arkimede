// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file tts.service.ts
 *
 * Text-to-speech via the OpenAI-compatible endpoint `/v1/audio/speech`.
 * The same code serves OpenAI cloud and any self-hosted TTS (the bundled
 * piper-service): only provider/baseUrl/apiKey/model/voice change, configured
 * in app_config (env fallback TTS_PROVIDER/TTS_BASE_URL/TTS_API_KEY until an
 * admin UI exists).
 *
 * The audio is transient: it is synthesized on demand, returned to the caller
 * and discarded — it is never persisted to disk.
 *
 * Cache: the OpenAI client is built lazily and invalidated with
 * invalidateCache() when the admin saves a new configuration.
 */
import { Injectable, Logger, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { AppConfigService } from '../app-config/app-config.service';
import { TtsProvider } from '../app-config/app-config.entity';

/** Output formats accepted by the route (v1: piper only produces wav). */
export type TtsFormat = 'wav' | 'mp3';

interface TtsRuntimeConfig {
  provider: TtsProvider;
  model:    string;
  voice:    string | null;
  apiKey:   string | null;
  baseUrl:  string | null;
}

/** Default model when not specified in the DB. */
const MODEL_DEFAULTS: Record<TtsProvider, string> = {
  internal:            'piper',
  openai:              'gpt-4o-mini-tts',
  'openai-compatible': 'tts-1',
};

/** Default voice per provider (internal: empty → piper-service uses PIPER_VOICE). */
const VOICE_DEFAULTS: Record<TtsProvider, string> = {
  internal:            '',
  openai:              'alloy',
  'openai-compatible': 'alloy',
};

/** Default base URL for providers with a known endpoint. */
const DEFAULT_BASE_URLS: Partial<Record<TtsProvider, string>> = {
  internal: 'http://localhost:9100/v1',
};

const TTS_PROVIDERS: TtsProvider[] = ['internal', 'openai', 'openai-compatible'];

@Injectable()
export class TtsService {
  private readonly logger = new Logger(TtsService.name);

  /** Cached OpenAI client + associated model/voice. Reset by invalidateCache(). */
  private cached: { client: OpenAI; model: string; voice: string | null } | null = null;

  constructor(
    private readonly appConfig: AppConfigService,
    private readonly env: ConfigService,
  ) {}

  /** Invalidates the client cache (called after every config change). */
  invalidateCache(): void {
    this.cached = null;
  }

  /** Reads the runtime configuration (DB + env fallback), with the key decrypted. */
  private async loadConfig(): Promise<TtsRuntimeConfig> {
    const cfg = await this.appConfig.getTtsConfig();
    // DB null = unset → env fallback (v1 has no admin UI for TTS yet).
    const envProvider = this.env.get<string>('TTS_PROVIDER');
    const provider: TtsProvider =
      cfg.ttsProvider ??
      (TTS_PROVIDERS.includes(envProvider as TtsProvider) ? (envProvider as TtsProvider) : 'internal');

    // ── Provider 'internal': piper-service bundled with the app ───────────────
    // URL from the deployment (env), voice defaulted by the service. Zero config.
    if (provider === 'internal') {
      return {
        provider,
        model:   cfg.ttsModel ?? MODEL_DEFAULTS.internal,
        voice:   cfg.ttsVoice ?? null,
        apiKey:  null,
        baseUrl: this.env.get<string>('TTS_BASE_URL', DEFAULT_BASE_URLS.internal!),
      };
    }

    const apiKey =
      (await this.appConfig.getRawTtsApiKey()) ??
      this.env.get<string>('TTS_API_KEY') ??
      (provider === 'openai' ? this.env.get<string>('OPENAI_API_KEY') ?? null : null);

    return {
      provider,
      model:   cfg.ttsModel || MODEL_DEFAULTS[provider],
      voice:   cfg.ttsVoice || VOICE_DEFAULTS[provider],
      apiKey,
      baseUrl: cfg.ttsBaseUrl || this.env.get<string>('TTS_BASE_URL') || DEFAULT_BASE_URLS[provider] || null,
    };
  }

  /** Builds (or reuses) the OpenAI client for speech synthesis. */
  private async getClient(): Promise<{ client: OpenAI; model: string; voice: string | null }> {
    if (this.cached) return this.cached;
    const config = await this.loadConfig();

    const client = new OpenAI({
      // Self-hosted providers may not require a key: placeholder for the SDK.
      apiKey: config.apiKey ?? 'not-needed',
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    });
    this.cached = { client, model: config.model, voice: config.voice };
    return this.cached;
  }

  /**
   * Synthesizes text into audio.
   * @param text    the utterance to synthesize
   * @param voice   voice id override (default: configured/provider default)
   * @param format  output format (default 'wav'; the internal Piper only does wav)
   */
  async synthesize(text: string, voice?: string, format: TtsFormat = 'wav'): Promise<Buffer> {
    if (!text?.trim()) {
      throw new BadRequestException('tts.emptyInput');
    }
    const { client, model, voice: defaultVoice } = await this.getClient();

    try {
      const res = await client.audio.speech.create({
        model,
        input: text,
        // Empty string → the internal piper-service falls back to its own default voice.
        voice: (voice ?? defaultVoice ?? '') as any,
        response_format: format,
      });
      return Buffer.from(await res.arrayBuffer());
    } catch (err: any) {
      const status = err?.status ?? err?.response?.status;
      const detail = err?.error?.detail ?? err?.response?.data?.error?.message ?? err?.message ?? 'unknown error';
      this.logger.error(`Speech synthesis failed: ${detail}`);
      // Surface provider-side rejections (unknown voice, unsupported format) as 400s.
      if (status === 400 || status === 404) {
        throw new BadRequestException(typeof detail === 'string' ? detail : 'tts.failed');
      }
      throw new ServiceUnavailableException('tts.failed');
    }
  }

  /**
   * Checks reachability of the configured endpoint by doing a micro-synthesis
   * of a short string. Used by a future admin "Test" button.
   */
  async testConnection(): Promise<{ ok: boolean; error?: string; model?: string }> {
    try {
      const { model } = await this.getClient();
      await this.synthesize('ok');
      return { ok: true, model };
    } catch (err: any) {
      const detail = err?.response?.data?.error?.message ?? err?.message ?? 'unknown error';
      return { ok: false, error: detail };
    }
  }
}
