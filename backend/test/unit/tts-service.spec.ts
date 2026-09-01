// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * TtsService: provider selection (DB value > env fallback > 'internal'
 * default), base URL / API key resolution and OpenAI client caching.
 * The OpenAI client is never used against the network here — only its
 * construction parameters and identity are asserted.
 */
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { TtsService } from '../../src/tts/tts.service';

const DB_DEFAULTS = {
  ttsProvider: null,
  ttsModel: null,
  hasTtsApiKey: false,
  ttsBaseUrl: null,
  ttsVoice: null,
};

function makeService(opts: {
  db?: Partial<typeof DB_DEFAULTS> & { ttsProvider?: any };
  rawApiKey?: string | null;
  env?: Record<string, string>;
} = {}) {
  const appConfig = {
    getTtsConfig: async () => ({ ...DB_DEFAULTS, ...(opts.db ?? {}) }),
    getRawTtsApiKey: async () => opts.rawApiKey ?? null,
  };
  const env = {
    get: (key: string, def?: string) => opts.env?.[key] ?? def,
  };
  return new TtsService(appConfig as any, env as any);
}

/** Reaches the private client builder without hitting the network. */
async function getClient(svc: TtsService) {
  return (svc as any).getClient() as Promise<{ client: any; model: string; voice: string | null }>;
}

describe('TtsService provider selection', () => {
  it('defaults to the internal piper-service when DB and env are unset', async () => {
    const { client, model, voice } = await getClient(makeService());
    expect(model).toBe('piper');
    expect(voice).toBeNull();
    expect(client.baseURL).toBe('http://localhost:9100/v1');
  });

  it('internal provider takes the base URL from TTS_BASE_URL', async () => {
    const { client } = await getClient(makeService({ env: { TTS_BASE_URL: 'http://piper:9100/v1' } }));
    expect(client.baseURL).toBe('http://piper:9100/v1');
  });

  it('falls back to env TTS_PROVIDER when the DB value is unset', async () => {
    const svc = makeService({
      env: { TTS_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test' },
    });
    const { client, model, voice } = await getClient(svc);
    expect(model).toBe('gpt-4o-mini-tts');
    expect(voice).toBe('alloy');
    expect(client.apiKey).toBe('sk-test');
  });

  it('ignores an invalid env TTS_PROVIDER (falls back to internal)', async () => {
    const { model } = await getClient(makeService({ env: { TTS_PROVIDER: 'bogus' } }));
    expect(model).toBe('piper');
  });

  it('DB provider/baseUrl/model/voice win over env', async () => {
    const svc = makeService({
      db: {
        ttsProvider: 'openai-compatible',
        ttsBaseUrl: 'http://tts.local/v1',
        ttsModel: 'my-model',
        ttsVoice: 'my-voice',
      },
      rawApiKey: 'db-key',
      env: { TTS_PROVIDER: 'internal', TTS_BASE_URL: 'http://ignored:9100/v1' },
    });
    const { client, model, voice } = await getClient(svc);
    expect(model).toBe('my-model');
    expect(voice).toBe('my-voice');
    expect(client.baseURL).toBe('http://tts.local/v1');
    expect(client.apiKey).toBe('db-key');
  });

  it('non-internal providers fall back to env TTS_API_KEY', async () => {
    const svc = makeService({
      db: { ttsProvider: 'openai-compatible', ttsBaseUrl: 'http://tts.local/v1' },
      env: { TTS_API_KEY: 'env-key' },
    });
    const { client } = await getClient(svc);
    expect(client.apiKey).toBe('env-key');
  });
});

describe('TtsService client caching', () => {
  it('reuses the client across calls and rebuilds it after invalidateCache()', async () => {
    const svc = makeService();
    const first = await getClient(svc);
    const second = await getClient(svc);
    expect(second.client).toBe(first.client);

    svc.invalidateCache();
    const third = await getClient(svc);
    expect(third.client).not.toBe(first.client);
  });
});

describe('TtsService input validation', () => {
  it('rejects empty input with a 400 before touching the provider', async () => {
    await expect(makeService().synthesize('   ')).rejects.toBeInstanceOf(BadRequestException);
  });
});
