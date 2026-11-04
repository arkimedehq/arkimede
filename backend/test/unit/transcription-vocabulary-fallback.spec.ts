// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Voice transcription: the vocabulary prompt (the admin's words + the names the user's memory knows) and
 * the local fallback (a model of the bundled whisper-service, only while it is downloaded there), against
 * a fake cloud provider and a fake bundled service (local HTTP stubs).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { TranscriptionService, buildVocabularyPrompt } from '../../src/transcription/transcription.service';

interface Seen { server: 'cloud' | 'local'; path: string; body: string }
const seen: Seen[] = [];
let cloudStatus = 200;
let downloaded = ['small'];

function stub(name: 'cloud' | 'local') {
  return (req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (c) => { raw += c.toString('latin1'); });
    req.on('end', () => {
      seen.push({ server: name, path: req.url!, body: raw });
      res.setHeader('content-type', 'application/json');
      if (req.url!.endsWith('/models')) {
        res.end(JSON.stringify({ data: ['small', 'medium', 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8'].map((id) => ({
          id, engine: id.startsWith('sherpa') ? 'parakeet' : 'whisper', downloaded: downloaded.includes(id) })) }));
        return;
      }
      if (name === 'cloud' && cloudStatus !== 200) { res.statusCode = cloudStatus; res.end(JSON.stringify({ error: { message: 'rate limited' } })); return; }
      res.end(JSON.stringify({ text: `${name} text` }));
    });
  };
}

let cloud: Server, local: Server, cloudUrl: string, localUrl: string;
beforeAll(async () => {
  cloud = createServer(stub('cloud')); local = createServer(stub('local'));
  await Promise.all([cloud, local].map((s) => new Promise<void>((r) => s.listen(0, '127.0.0.1', r))));
  cloudUrl = `http://127.0.0.1:${(cloud.address() as AddressInfo).port}/v1`;
  localUrl = `http://127.0.0.1:${(local.address() as AddressInfo).port}/v1`;
});
afterAll(() => Promise.all([cloud, local].map((s) => new Promise<void>((r) => s.close(() => r())))));
beforeEach(() => { seen.length = 0; cloudStatus = 200; downloaded = ['small']; });

const field = (body: string, name: string) => body.match(new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`))?.[1];

function service(cfg: Record<string, unknown>) {
  const appConfig = {
    getTranscriptionConfig: async () => ({
      transcriptionEnabled: true, transcriptionProvider: 'groq', transcriptionModel: 'whisper-large-v3',
      transcriptionBaseUrl: cloudUrl, transcriptionVocabularyEnabled: false, transcriptionVocabulary: null,
      transcriptionFallbackModel: null, ...cfg,
    }),
    getRawTranscriptionApiKey: async () => 'gsk_test',
  } as any;
  const env = { get: (k: string, d?: unknown) => (k === 'TRANSCRIPTION_BASE_URL' ? localUrl : d) } as any;
  return new TranscriptionService(appConfig, env, { findOne: async () => null } as any);
}
const wav = Buffer.from('RIFF....WAVEfmt ');

describe('vocabulary prompt', () => {
  it('the admin\'s words first, then the names; de-duplicated; null when empty', () => {
    expect(buildVocabularyPrompt('Ispica, zona giorno\nTokyo; ispica', ['Chloè', 'Eriona', 'tokyo'])).toBe('Ispica, zona giorno, Tokyo, Chloè, Eriona.');
    expect(buildVocabularyPrompt('  ', [])).toBeNull();
    expect(buildVocabularyPrompt(null)).toBeNull();
  });

  it('stays within the model\'s prompt budget, on whole words', () => {
    const prompt = buildVocabularyPrompt(null, Array.from({ length: 200 }, (_, i) => `Nome${i}`))!;
    expect(prompt.length).toBeLessThanOrEqual(501);
    expect(prompt.endsWith('.')).toBe(true);
    expect(prompt).not.toMatch(/Nome\d*[^\d,.]/);
  });

  it('goes to the model only when it is on', async () => {
    await service({ transcriptionVocabulary: 'Ispica' }).transcribe(wav, 'a.wav', 'it');
    expect(field(seen.at(-1)!.body, 'prompt')).toBeUndefined();
    await service({ transcriptionVocabularyEnabled: true, transcriptionVocabulary: 'Ispica, Chloè' }).transcribe(wav, 'a.wav', 'it', { userId: 'u1' });
    const sent = seen.at(-1)!;
    expect(sent.server).toBe('cloud');
    expect(Buffer.from(field(sent.body, 'prompt')!, 'latin1').toString('utf8')).toBe('Ispica, Chloè.');
    expect(field(sent.body, 'language')).toBe('it');
  });
});

describe('local fallback', () => {
  it('the cloud provider fails → the downloaded local model takes the turn, with the same vocabulary', async () => {
    cloudStatus = 429;
    const text = await service({ transcriptionFallbackModel: 'small', transcriptionVocabularyEnabled: true, transcriptionVocabulary: 'Ispica' })
      .transcribe(wav, 'a.wav', 'it');
    expect(text).toBe('local text');
    const call = seen.find((s) => s.server === 'local' && s.path.endsWith('/audio/transcriptions'))!;
    expect(field(call.body, 'model')).toBe('small');
    expect(field(call.body, 'prompt')).toBe('Ispica.');
    expect(seen.filter((s) => s.server === 'cloud' && s.path.endsWith('/audio/transcriptions'))).toHaveLength(1); // no retry
  });

  it('never without a fallback configured, nor with one that is not downloaded', async () => {
    cloudStatus = 503;
    await expect(service({}).transcribe(wav, 'a.wav')).rejects.toThrow('transcription.failed');
    downloaded = [];
    await expect(service({ transcriptionFallbackModel: 'small' }).transcribe(wav, 'a.wav')).rejects.toThrow('transcription.failed');
    expect(seen.filter((s) => s.server === 'local' && s.path.endsWith('/audio/transcriptions'))).toHaveLength(0);
  });

  it('the cloud answering: the local service is never called', async () => {
    expect(await service({ transcriptionFallbackModel: 'small' }).transcribe(wav, 'a.wav')).toBe('cloud text');
    expect(seen.filter((s) => s.server === 'local')).toHaveLength(0);
  });

  it('lists only the downloaded local models', async () => {
    downloaded = ['small', 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8'];
    expect(await service({}).listLocalModels()).toEqual([
      { id: 'small', engine: 'whisper' }, { id: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8', engine: 'parakeet' },
    ]);
  });
});
