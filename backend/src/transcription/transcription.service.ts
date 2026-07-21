/**
 * @file transcription.service.ts
 *
 * Voice transcription (speech-to-text) via the OpenAI-compatible endpoint
 * `/v1/audio/transcriptions`. The same code serves OpenAI cloud, Groq and
 * any self-hosted whisper (faster-whisper / whisper.cpp server): only
 * provider/baseUrl/apiKey/model change, configured by the admin in app_config.
 *
 * The audio is transient: it arrives in RAM from the controller, is forwarded to
 * the provider and discarded — it is never persisted to disk (respects
 * per-tenant FS isolation).
 *
 * Cache: the OpenAI client is built lazily and invalidated with
 * invalidateCache() when the admin saves a new configuration.
 */
import { Injectable, Logger, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI, { toFile } from 'openai';
import { AppConfigService } from '../app-config/app-config.service';
import { TranscriptionProvider } from '../app-config/app-config.entity';

interface TranscriptionRuntimeConfig {
  enabled:  boolean;
  provider: TranscriptionProvider;
  model:    string;
  apiKey:   string | null;
  baseUrl:  string | null;
}

/** Default model when not specified in the DB. */
const MODEL_DEFAULTS: Record<TranscriptionProvider, string> = {
  internal:            'small',
  openai:              'whisper-1',
  groq:                'whisper-large-v3',
  'openai-compatible': 'whisper-1',
};

/** Default base URL for providers with a known endpoint. */
const DEFAULT_BASE_URLS: Partial<Record<TranscriptionProvider, string>> = {
  internal: 'http://localhost:9000/v1',
  groq:     'https://api.groq.com/openai/v1',
};

@Injectable()
export class TranscriptionService {
  private readonly logger = new Logger(TranscriptionService.name);

  /** Cached OpenAI client + associated model. Reset by invalidateCache(). */
  private cached: { client: OpenAI; model: string } | null = null;

  constructor(
    private readonly appConfig: AppConfigService,
    private readonly env: ConfigService,
  ) {}

  /** Invalidates the client cache (called after every config change). */
  invalidateCache(): void {
    this.cached = null;
  }

  /** Reads the runtime configuration (DB + env fallback), with the key decrypted. */
  private async loadConfig(): Promise<TranscriptionRuntimeConfig> {
    const cfg = await this.appConfig.getTranscriptionConfig();
    const provider = cfg.transcriptionProvider;

    // ── Provider 'internal': whisper-service bundled with the app ─────────────────
    // URL from the deployment (env), model auto-detected from the service. Zero config.
    if (provider === 'internal') {
      const baseUrl = this.env.get<string>('TRANSCRIPTION_BASE_URL', DEFAULT_BASE_URLS.internal!);
      const probed = await this.probeInternal(baseUrl);
      return {
        enabled:  cfg.transcriptionEnabled,
        provider,
        model:    probed ?? cfg.transcriptionModel ?? MODEL_DEFAULTS.internal,
        apiKey:   null,
        baseUrl,
      };
    }

    const apiKey =
      (await this.appConfig.getRawTranscriptionApiKey()) ??
      this.env.get<string>('TRANSCRIPTION_API_KEY') ??
      (provider === 'openai' ? this.env.get<string>('OPENAI_API_KEY') ?? null : null);

    return {
      enabled:  cfg.transcriptionEnabled,
      provider,
      model:    cfg.transcriptionModel || MODEL_DEFAULTS[provider],
      apiKey,
      baseUrl:  cfg.transcriptionBaseUrl || DEFAULT_BASE_URLS[provider] || null,
    };
  }

  /**
   * Probes the internal whisper-service to auto-detect the model name.
   * Best-effort: returns null on error/timeout (the caller uses the default).
   */
  private async probeInternal(baseUrl: string): Promise<string | null> {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) return null;
      const json: any = await res.json();
      return json?.data?.[0]?.id ?? null;
    } catch {
      return null;
    }
  }

  /** Builds (or reuses) the OpenAI client for transcription. */
  private async getClient(): Promise<{ client: OpenAI; model: string; enabled: boolean }> {
    const config = await this.loadConfig();
    if (this.cached) return { ...this.cached, enabled: config.enabled };

    const client = new OpenAI({
      // Self-hosted providers may not require a key: placeholder for the SDK.
      apiKey: config.apiKey ?? 'not-needed',
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    });
    this.cached = { client, model: config.model };
    return { client, model: config.model, enabled: config.enabled };
  }

  /** True if the microphone button is enabled by the admin. */
  async isEnabled(): Promise<boolean> {
    return (await this.appConfig.getTranscriptionConfig()).transcriptionEnabled;
  }

  /**
   * Transcribes an audio buffer into text.
   * @param buffer    audio file content (webm/ogg/mp3/wav/m4a)
   * @param filename  name with the correct extension (the SDK uses it for the mime)
   * @param language  ISO-639-1 language hint (e.g. 'it'); improves accuracy
   */
  async transcribe(buffer: Buffer, filename: string, language?: string): Promise<string> {
    const { client, model, enabled } = await this.getClient();
    if (!enabled) {
      throw new ServiceUnavailableException('transcription.disabled');
    }
    if (!buffer?.length) {
      throw new BadRequestException('transcription.emptyAudio');
    }

    try {
      const file = await toFile(buffer, filename);
      const res = await client.audio.transcriptions.create({
        file,
        model,
        ...(language ? { language } : {}),
      });
      return (res.text ?? '').trim();
    } catch (err: any) {
      const detail = err?.response?.data?.error?.message ?? err?.message ?? 'unknown error';
      this.logger.error(`Transcription failed: ${detail}`);
      throw new ServiceUnavailableException('transcription.failed');
    }
  }

  /**
   * Checks reachability/credentials of the configured endpoint by doing a
   * micro-transcription of a minimal silent WAV. Used by the "Test" button.
   */
  async testConnection(): Promise<{ ok: boolean; error?: string; model?: string }> {
    try {
      const { client, model } = await this.getClient();
      const file = await toFile(buildSilentWav(), 'test.wav');
      await client.audio.transcriptions.create({ file, model });
      return { ok: true, model };
    } catch (err: any) {
      const detail = err?.response?.data?.error?.message ?? err?.message ?? 'errore sconosciuto';
      return { ok: false, error: detail };
    }
  }
}

/** Generates a PCM WAV of ~0.1s of silence (44-byte header + data) for the test. */
function buildSilentWav(): Buffer {
  const sampleRate = 16000;
  const numSamples = Math.floor(sampleRate * 0.1);
  const dataSize = numSamples * 2; // 16-bit mono
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);            // PCM
  buf.writeUInt16LE(1, 22);            // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}
