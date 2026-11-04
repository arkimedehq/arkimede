// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

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
 *
 * Tracing: every transcription runs in a `transcription {model}` OTel span
 * (opt-in, metadata only — never the audio nor the transcript).
 *
 * Vocabulary (opt-in, admin): the expected words — the admin's own (places,
 * rooms, devices) and the names the user's memory knows (Recordare contacts) —
 * go to the model as its `prompt`, so proper names come out right.
 *
 * Fallback (opt-in, admin): when a cloud provider fails (down, rate-limited,
 * slow), the turn is transcribed by a model of the bundled whisper-service —
 * only while that model is downloaded there.
 */
import { Injectable, Logger, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import OpenAI, { toFile } from 'openai';
import { AppConfigService } from '../app-config/app-config.service';
import { TranscriptionProvider } from '../app-config/app-config.entity';
import { isInternalServiceAvailable } from '../common/internal-service-probe.util';
import { wavDurationSeconds, withVoiceSpan } from '../observability/genai-tracing';
import { User } from '../users/users.entity';
import { recordareClient } from '../recordare/recordare.config';

interface TranscriptionRuntimeConfig {
  enabled:  boolean;
  provider: TranscriptionProvider;
  model:    string;
  apiKey:   string | null;
  baseUrl:  string | null;
  vocabularyEnabled: boolean;
  vocabulary:        string | null;
  /** Model of the bundled service used when a cloud provider fails; null = none. */
  fallbackModel:     string | null;
}

/** A model the bundled whisper-service has downloaded. */
export interface LocalModel { id: string; engine: string }

/** Whisper reads at most 224 prompt tokens: keep the vocabulary well within it. */
const MAX_VOCABULARY_CHARS = 500;
/** With a fallback, a cloud provider gets this long (and no retry) before the local model takes the turn. */
const PRIMARY_TIMEOUT_MS = 8_000;
/** How long the names from the user's memory and the list of local models are reused. */
const NAMES_TTL_MS = 10 * 60_000;
const LOCAL_MODELS_TTL_MS = 60_000;
/** Bound on fetching the names (the turn never waits longer for them). */
const NAMES_TIMEOUT_MS = 1_000;

/**
 * The model prompt for a vocabulary: the admin's words first, then the names, de-duplicated
 * (case-insensitive), cut at MAX_VOCABULARY_CHARS on a whole word; null when empty.
 */
export function buildVocabularyPrompt(words: string | null | undefined, names: string[] = []): string | null {
  const seen = new Set<string>();
  const kept: string[] = [];
  let length = 0;
  for (const raw of [...(words ?? '').split(/[\n,;]+/), ...names]) {
    const word = raw.trim().replace(/\s+/g, ' ');
    const key = word.toLowerCase();
    if (!word || seen.has(key)) continue;
    if (length + word.length + 2 > MAX_VOCABULARY_CHARS) break;
    seen.add(key);
    kept.push(word);
    length += word.length + 2;
  }
  return kept.length ? `${kept.join(', ')}.` : null;
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

/** Provider → gen_ai.provider.name on the trace span (openai-compatible: real backend unknown). */
const TRACE_PROVIDER: Partial<Record<TranscriptionProvider, string>> = {
  internal: 'whisper',
  openai:   'openai',
  groq:     'groq',
};

@Injectable()
export class TranscriptionService {
  private readonly logger = new Logger(TranscriptionService.name);

  /** Cached OpenAI client + associated model. Reset by invalidateCache(). */
  private cached: { client: OpenAI; model: string; provider: TranscriptionProvider } | null = null;
  private localClient: OpenAI | null = null;
  private localModels: { at: number; list: LocalModel[] } | null = null;
  private names = new Map<string, { at: number; list: string[] }>();

  constructor(
    private readonly appConfig: AppConfigService,
    private readonly env: ConfigService,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
  ) {}

  /** Invalidates the client cache (called after every config change). */
  invalidateCache(): void {
    this.cached = null;
    this.localModels = null;
  }

  private get internalBaseUrl(): string {
    return this.env.get<string>('TRANSCRIPTION_BASE_URL', DEFAULT_BASE_URLS.internal!);
  }

  /** Reads the runtime configuration (DB + env fallback), with the key decrypted. */
  private async loadConfig(): Promise<TranscriptionRuntimeConfig> {
    const cfg = await this.appConfig.getTranscriptionConfig();
    const provider = cfg.transcriptionProvider;
    const extras = {
      vocabularyEnabled: cfg.transcriptionVocabularyEnabled,
      vocabulary:        cfg.transcriptionVocabulary,
      fallbackModel:     provider === 'internal' ? null : cfg.transcriptionFallbackModel,
    };

    // ── Provider 'internal': whisper-service bundled with the app ─────────────────
    // URL from the deployment (env). Model: the size chosen by the admin (the service
    // switches at runtime, downloading on first use), else the one currently loaded.
    if (provider === 'internal') {
      const baseUrl = this.internalBaseUrl;
      const chosen = cfg.transcriptionModel?.trim() || null;
      const probed = chosen ? null : await this.probeInternal(baseUrl);
      return {
        enabled:  cfg.transcriptionEnabled,
        provider,
        model:    chosen ?? probed ?? MODEL_DEFAULTS.internal,
        apiKey:   null,
        baseUrl,
        ...extras,
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
      ...extras,
    };
  }

  /**
   * Probes the internal whisper-service for the model currently loaded (data[0]).
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
  private async getClient(): Promise<{ client: OpenAI; model: string; provider: TranscriptionProvider; enabled: boolean; config: TranscriptionRuntimeConfig }> {
    const config = await this.loadConfig();
    if (this.cached) return { ...this.cached, enabled: config.enabled, config };

    const client = new OpenAI({
      // Self-hosted providers may not require a key: placeholder for the SDK.
      apiKey: config.apiKey ?? 'not-needed',
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
      // With a fallback, a failing provider gives way at once instead of retrying.
      ...(config.fallbackModel ? { timeout: PRIMARY_TIMEOUT_MS, maxRetries: 0 } : {}),
    });
    this.cached = { client, model: config.model, provider: config.provider };
    return { ...this.cached, enabled: config.enabled, config };
  }

  /**
   * The models the bundled whisper-service has downloaded (cached briefly); [] when it
   * is not deployed or does not answer.
   */
  async listLocalModels(): Promise<LocalModel[]> {
    if (this.localModels && Date.now() - this.localModels.at < LOCAL_MODELS_TTL_MS) return this.localModels.list;
    let list: LocalModel[] = [];
    try {
      const res = await fetch(`${this.internalBaseUrl.replace(/\/$/, '')}/models`, { signal: AbortSignal.timeout(3_000) });
      if (res.ok) {
        const json: any = await res.json();
        list = (json?.data ?? [])
          .filter((m: any) => m?.downloaded && typeof m.id === 'string')
          .map((m: any) => ({ id: m.id, engine: String(m.engine ?? 'whisper') }));
      }
    } catch { /* not deployed or not answering: no local models */ }
    this.localModels = { at: Date.now(), list };
    return list;
  }

  /** The fallback model when one is configured and downloaded in the bundled service; else null. */
  private async usableFallback(config: TranscriptionRuntimeConfig): Promise<string | null> {
    if (!config.fallbackModel) return null;
    return (await this.listLocalModels()).some((m) => m.id === config.fallbackModel) ? config.fallbackModel : null;
  }

  private local(): OpenAI {
    this.localClient ??= new OpenAI({ apiKey: 'not-needed', baseURL: this.internalBaseUrl });
    return this.localClient;
  }

  /**
   * Loads the fallback model in the bundled service (one model in RAM there), so a fallback
   * answers at once. Best-effort, after the admin saves the configuration.
   */
  async warmFallback(): Promise<void> {
    try {
      const model = await this.usableFallback(await this.loadConfig());
      if (!model) return;
      await this.local().audio.transcriptions.create({ file: await toFile(buildSilentWav(), 'warm.wav'), model });
      this.logger.log(`Transcription fallback ${model} loaded in the bundled service`);
    } catch (err: any) {
      this.logger.warn(`Loading the transcription fallback failed: ${err?.message ?? err}`);
    }
  }

  /** The vocabulary prompt for a turn of `userId`, when the vocabulary is on. */
  private async vocabularyPrompt(config: TranscriptionRuntimeConfig, userId?: string): Promise<string | null> {
    if (!config.vocabularyEnabled) return null;
    return buildVocabularyPrompt(config.vocabulary, userId ? await this.memoryNames(userId) : []);
  }

  /**
   * Names of the people the user's memory knows (Recordare: who I am + contacts, most
   * recently mentioned first, with their aliases). Cached per user; [] when Recordare is
   * off for the user, slow or down.
   */
  private async memoryNames(userId: string): Promise<string[]> {
    const cached = this.names.get(userId);
    if (cached && Date.now() - cached.at < NAMES_TTL_MS) return cached.list;
    const client = recordareClient();
    let list: string[] = [];
    if (client) {
      try {
        const user = await this.userRepo.findOne({ where: { id: userId }, select: { id: true, episodicMemoryEnabled: true } });
        if (user?.episodicMemoryEnabled) {
          const cards = await Promise.race([
            client.cards(userId),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), NAMES_TIMEOUT_MS)),
          ]);
          const contacts = [...cards.contacts].sort((a, b) => (b.lastMentioned ?? '').localeCompare(a.lastMentioned ?? ''));
          list = [cards.self, ...contacts].flatMap((c) => [c.name, ...(c.aliases ?? [])]).filter(Boolean);
        }
      } catch (err: any) {
        this.logger.debug(`Vocabulary: names from memory unavailable (user ${userId}): ${err?.message ?? err}`);
        if (cached) return cached.list;
      }
    }
    this.names.set(userId, { at: Date.now(), list });
    return list;
  }

  /**
   * Describes the active provider/model (for capability advertisement, e.g. the
   * Wyoming `info` event). Never throws: on error it falls back to the defaults.
   */
  async describe(): Promise<{ provider: TranscriptionProvider; model: string; enabled: boolean }> {
    try {
      const cfg = await this.loadConfig();
      return { provider: cfg.provider, model: cfg.model, enabled: await this.isUsable(cfg.enabled, cfg.provider) };
    } catch {
      return { provider: 'internal', model: MODEL_DEFAULTS.internal, enabled: false };
    }
  }

  /**
   * True if the microphone button should be shown: enabled by the admin and,
   * for the internal provider, the bundled whisper-service is deployed.
   */
  async isEnabled(): Promise<boolean> {
    const cfg = await this.appConfig.getTranscriptionConfig();
    return this.isUsable(cfg.transcriptionEnabled, cfg.transcriptionProvider);
  }

  /** True if the bundled whisper-service is deployed (reachable). */
  isInternalAvailable(): Promise<boolean> {
    return isInternalServiceAvailable(this.internalBaseUrl);
  }

  private async isUsable(enabled: boolean, provider: TranscriptionProvider): Promise<boolean> {
    if (!enabled) return false;
    return provider !== 'internal' || this.isInternalAvailable();
  }

  /**
   * Transcribes an audio buffer into text.
   * @param buffer    audio file content (webm/ogg/mp3/wav/m4a)
   * @param filename  name with the correct extension (the SDK uses it for the mime)
   * @param language  ISO-639-1 language hint (e.g. 'it'); improves accuracy
   * @param opts.userId whose voice it is: the names their memory knows join the vocabulary
   */
  async transcribe(buffer: Buffer, filename: string, language?: string, opts: { userId?: string } = {}): Promise<string> {
    const { client, model, provider, enabled, config } = await this.getClient();
    if (!enabled) {
      throw new ServiceUnavailableException('transcription.disabled');
    }
    if (!buffer?.length) {
      throw new BadRequestException('transcription.emptyAudio');
    }

    return withVoiceSpan(
      () => ({
        operation: 'transcription', model, provider: TRACE_PROVIDER[provider], remote: true,
        audioSeconds: wavDurationSeconds(buffer),
      }),
      async () => {
        const prompt = await this.vocabularyPrompt(config, opts.userId);
        const run = async (c: OpenAI, m: string) => {
          const res = await c.audio.transcriptions.create({
            file: await toFile(buffer, filename),
            model: m,
            ...(language ? { language } : {}),
            ...(prompt ? { prompt } : {}),
          });
          return (res.text ?? '').trim();
        };
        try {
          return await run(client, model);
        } catch (err: any) {
          const detail = err?.response?.data?.error?.message ?? err?.message ?? 'unknown error';
          const fallback = await this.usableFallback(config);
          if (!fallback) {
            this.logger.error(`Transcription failed: ${detail}`);
            throw new ServiceUnavailableException('transcription.failed');
          }
          this.logger.warn(`Transcription failed on ${provider} (${detail}): local fallback ${fallback}`);
          try {
            return await run(this.local(), fallback);
          } catch (fbErr: any) {
            this.logger.error(`Transcription fallback ${fallback} failed: ${fbErr?.message ?? fbErr}`);
            throw new ServiceUnavailableException('transcription.failed');
          }
        }
      },
    );
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
