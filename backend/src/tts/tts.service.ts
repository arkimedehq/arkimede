// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file tts.service.ts
 *
 * Text-to-speech via the OpenAI-compatible endpoint `/v1/audio/speech`.
 * The same code serves OpenAI cloud and any self-hosted TTS (the bundled
 * piper-service): only provider/baseUrl/apiKey/model/voice change, configured
 * in app_config by the admin (env fallback TTS_PROVIDER/TTS_BASE_URL/TTS_API_KEY
 * while unset). The `ttsEnabled` toggle gates every synthesis.
 *
 * The audio is transient: it is synthesized on demand, returned to the caller
 * and discarded — it is never persisted to disk.
 *
 * Cache: the OpenAI client is built lazily and invalidated with
 * invalidateCache() when the admin saves a new configuration.
 *
 * Tracing: every synthesis runs in a `speech {model}` OTel span (opt-in,
 * metadata only — never the text to speak nor the audio).
 */
import { Injectable, Logger, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { AppConfigService } from '../app-config/app-config.service';
import { TtsProvider } from '../app-config/app-config.entity';
import { isInternalServiceAvailable } from '../common/internal-service-probe.util';
import { wavDurationSeconds, withVoiceSpan } from '../observability/genai-tracing';

/** Output formats accepted by the route (v1: piper only produces wav). */
export type TtsFormat = 'wav' | 'mp3';

interface TtsRuntimeConfig {
  enabled:  boolean;
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

/** Provider → gen_ai.provider.name on the trace span (openai-compatible: real backend unknown). */
const TRACE_PROVIDER: Partial<Record<TtsProvider, string>> = {
  internal: 'piper',
  openai:   'openai',
};

@Injectable()
export class TtsService {
  private readonly logger = new Logger(TtsService.name);

  /** Cached OpenAI client + associated model/voice. Reset by invalidateCache(). */
  private cached: { client: OpenAI; model: string; voice: string | null; provider: TtsProvider } | null = null;

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
    // DB null = never saved from the admin UI → env fallback.
    const envProvider = this.env.get<string>('TTS_PROVIDER');
    const provider: TtsProvider =
      cfg.ttsProvider ??
      (TTS_PROVIDERS.includes(envProvider as TtsProvider) ? (envProvider as TtsProvider) : 'internal');

    // ── Provider 'internal': piper-service bundled with the app ───────────────
    // URL from the deployment (env), voice defaulted by the service. Zero config.
    if (provider === 'internal') {
      return {
        enabled: cfg.ttsEnabled,
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
      enabled: cfg.ttsEnabled,
      provider,
      model:   cfg.ttsModel || MODEL_DEFAULTS[provider],
      voice:   cfg.ttsVoice || VOICE_DEFAULTS[provider],
      apiKey,
      baseUrl: cfg.ttsBaseUrl || this.env.get<string>('TTS_BASE_URL') || DEFAULT_BASE_URLS[provider] || null,
    };
  }

  /**
   * Describes the active provider/model/voice (for capability advertisement, e.g.
   * the Wyoming `info` event). For the internal Piper the default voice is not
   * known to the backend (PIPER_VOICE lives in the service): it is probed from
   * `/v1/models`, which lists the voices already downloaded. Never throws.
   */
  async describe(): Promise<{ provider: TtsProvider; model: string; voice: string | null; voices: string[]; enabled: boolean }> {
    try {
      const cfg = await this.loadConfig();
      let voices: string[] = [];
      if (cfg.provider === 'internal' && cfg.baseUrl) {
        voices = await this.probeInternalVoices(cfg.baseUrl);
      }
      const voice = cfg.voice || voices[0] || (cfg.provider === 'internal' ? null : VOICE_DEFAULTS[cfg.provider]);
      const enabled = await this.isUsable(cfg.enabled, cfg.provider);
      return { provider: cfg.provider, model: cfg.model, voice, voices, enabled };
    } catch {
      return { provider: 'internal', model: MODEL_DEFAULTS.internal, voice: null, voices: [], enabled: false };
    }
  }

  /**
   * True if read-aloud should be offered: enabled by the admin and, for the
   * internal provider, the bundled piper-service is deployed.
   */
  async isEnabled(): Promise<boolean> {
    const cfg = await this.loadConfig();
    return this.isUsable(cfg.enabled, cfg.provider);
  }

  /** True if the bundled piper-service is deployed (reachable). */
  isInternalAvailable(): Promise<boolean> {
    return isInternalServiceAvailable(
      this.env.get<string>('TTS_BASE_URL', DEFAULT_BASE_URLS.internal!),
    );
  }

  private async isUsable(enabled: boolean, provider: TtsProvider): Promise<boolean> {
    if (!enabled) return false;
    return provider !== 'internal' || this.isInternalAvailable();
  }

  /** Lists the voices of the internal piper-service (best-effort, 3s timeout). */
  private async probeInternalVoices(baseUrl: string): Promise<string[]> {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) return [];
      const json: any = await res.json();
      return (json?.data ?? []).map((m: any) => String(m.id)).filter(Boolean);
    } catch {
      return [];
    }
  }

  /** Builds (or reuses) the OpenAI client for speech synthesis. */
  private async getClient(): Promise<{ client: OpenAI; model: string; voice: string | null; provider: TtsProvider }> {
    if (this.cached) return this.cached;
    const config = await this.loadConfig();

    const client = new OpenAI({
      // Self-hosted providers may not require a key: placeholder for the SDK.
      apiKey: config.apiKey ?? 'not-needed',
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    });
    this.cached = { client, model: config.model, voice: config.voice, provider: config.provider };
    return this.cached;
  }

  /**
   * Synthesizes text into audio.
   * @param text    the utterance to synthesize
   * @param voice   voice id override (default: configured/provider default)
   * @param format  output format (default 'wav'; the internal Piper only does wav)
   */
  async synthesize(text: string, voice?: string, format: TtsFormat = 'wav'): Promise<Buffer> {
    if (!(await this.appConfig.getTtsConfig()).ttsEnabled) {
      throw new ServiceUnavailableException('tts.disabled');
    }
    return this.doSynthesize(text, voice, format);
  }

  /** Synthesis without the enabled gate (the admin test works before enabling). */
  private async doSynthesize(text: string, voice?: string, format: TtsFormat = 'wav'): Promise<Buffer> {
    if (!text?.trim()) {
      throw new BadRequestException('tts.emptyInput');
    }
    const { client, model, voice: defaultVoice, provider } = await this.getClient();
    const effectiveVoice = voice ?? defaultVoice ?? '';

    return withVoiceSpan(
      () => ({
        operation: 'speech',
        // Piper's "model" is a placeholder: the voice id is the real model there.
        model: provider === 'internal' ? effectiveVoice || model : model,
        provider: TRACE_PROVIDER[provider], remote: true,
        characters: text.length,
      }),
      async () => {
        try {
          const res = await client.audio.speech.create({
            model,
            input: text,
            // Empty string → the internal piper-service falls back to its own default voice.
            voice: effectiveVoice as any,
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
      },
      (audio) => (format === 'wav' ? wavDurationSeconds(audio) : undefined),
    );
  }

  /**
   * Checks reachability of the configured endpoint by doing a micro-synthesis
   * of a short string. Used by the admin "Test" button.
   */
  async testConnection(): Promise<{ ok: boolean; error?: string; model?: string }> {
    try {
      const { model } = await this.getClient();
      await this.doSynthesize('ok');
      return { ok: true, model };
    } catch (err: any) {
      const detail = err?.response?.data?.error?.message ?? err?.message ?? 'unknown error';
      return { ok: false, error: detail };
    }
  }
}
