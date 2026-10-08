// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * OpenTelemetry voice spans: speech-to-text and text-to-speech produce
 * `transcription {model}` / `speech {model}` spans with metadata only (never the
 * transcript, the text to speak or audio), nest under an active agent span, carry
 * the user when one is known, set ERROR on failures, and nothing is recorded
 * (results unchanged) when tracing is off.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { InMemorySpanExporter, ReadableSpan, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import {
  initGenAiTracing, shutdownGenAiTracing, withAgentSpan, withTraceUser, wavDurationSeconds,
} from '../../src/observability/genai-tracing';
import { setRecordareOwnerResolver } from '../../src/observability/genai-trace.handler';
import { TranscriptionService } from '../../src/transcription/transcription.service';
import { TtsService } from '../../src/tts/tts.service';
import { WyomingService } from '../../src/wyoming/wyoming.service';
import { pcmToWav } from '../../src/wyoming/wyoming.protocol';

const SECRET_TRANSCRIPT = 'planted secret transcript words';
const SECRET_SPEECH = 'planted secret text to speak';

/** 1 s of 16 kHz / 16-bit / mono silence as WAV. */
const oneSecondWav = () => pcmToWav(Buffer.alloc(32000), { rate: 16000, width: 2, channels: 1 });
/** 0.5 s of 22.05 kHz / 16-bit / mono silence as WAV (what Piper returns). */
const halfSecondWav = () => pcmToWav(Buffer.alloc(22050), { rate: 22050, width: 2, channels: 1 });

const env = { get: (_k: string, d?: unknown) => d } as any;

function makeStt(opts: { fail?: boolean } = {}) {
  const calls: any[] = [];
  const appConfig = {
    getTranscriptionConfig: async () => ({ transcriptionEnabled: true, transcriptionProvider: 'internal', transcriptionModel: 'small' }),
  } as any;
  const svc = new TranscriptionService(appConfig, env);
  const client = {
    audio: {
      transcriptions: {
        create: async (req: any) => {
          calls.push(req);
          if (opts.fail) throw new Error(`upstream echoed: ${SECRET_TRANSCRIPT}`);
          return { text: ` ${SECRET_TRANSCRIPT} ` };
        },
      },
    },
  };
  (svc as any).cached = { client, model: 'small', provider: 'internal' };
  return { svc, calls };
}

function makeTts(opts: { fail?: boolean } = {}) {
  const appConfig = { getTtsConfig: async () => ({ ttsEnabled: true }) } as any;
  const svc = new TtsService(appConfig, env);
  const client = {
    audio: {
      speech: {
        create: async () => {
          if (opts.fail) throw Object.assign(new Error(`bad voice for ${SECRET_SPEECH}`), { status: 500 });
          const wav = halfSecondWav();
          return { arrayBuffer: async () => wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) };
        },
      },
    },
  };
  (svc as any).cached = { client, model: 'piper', voice: 'it_IT-paola-medium', provider: 'internal' };
  return svc;
}

function assertNoContent(spans: ReadableSpan[]): void {
  for (const s of spans) {
    const dump = JSON.stringify({ name: s.name, attributes: s.attributes, events: s.events, status: s.status, links: s.links });
    expect(dump).not.toContain('planted secret');
    expect(s.events).toHaveLength(0);
  }
}

const byOp = (spans: ReadableSpan[], op: string) => spans.filter((s) => s.attributes['voice.operation'] === op);

describe('voice spans — tracing on', () => {
  let exporter: InMemorySpanExporter;

  beforeEach(() => {
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'http://127.0.0.1:9/v1/traces'; // never contacted
    exporter = new InMemorySpanExporter();
    expect(initGenAiTracing({ spanProcessor: new SimpleSpanProcessor(exporter) })).toBe(true);
  });

  afterEach(async () => {
    await shutdownGenAiTracing();
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    setRecordareOwnerResolver(null);
  });

  it('speech-to-text: one transcription span with model, provider, audio length and user; no transcript', async () => {
    setRecordareOwnerResolver((u) => (u === 'u1' ? 'owner-1' : undefined));
    const { svc } = makeStt();
    const text = await withTraceUser('u1', () => svc.transcribe(oneSecondWav(), 'audio.wav', 'it'));
    expect(text).toBe(SECRET_TRANSCRIPT);

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const [s] = spans;
    expect(s.name).toBe('transcription small');
    expect(s.kind).toBe(SpanKind.CLIENT);
    expect(s.attributes).toEqual({
      'voice.operation': 'transcription',
      'gen_ai.request.model': 'small',
      'gen_ai.provider.name': 'whisper',
      'voice.audio_seconds': 1,
      'user.id': 'u1',
      'recordare.owner_id': 'owner-1',
    });
    assertNoContent(spans);
  });

  it('text-to-speech: one speech span with voice, characters and output length; no text, no audio', async () => {
    const svc = makeTts();
    const audio = await withTraceUser('u2', () => svc.synthesize(SECRET_SPEECH, undefined, 'wav'));
    expect(audio.equals(halfSecondWav())).toBe(true);

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const [s] = spans;
    expect(s.name).toBe('speech it_IT-paola-medium');
    expect(s.kind).toBe(SpanKind.CLIENT);
    expect(s.attributes).toEqual({
      'voice.operation': 'speech',
      'gen_ai.request.model': 'it_IT-paola-medium',
      'gen_ai.provider.name': 'piper',
      'voice.characters': SECRET_SPEECH.length,
      'voice.audio_seconds': 0.5,
      'user.id': 'u2',
    });
    assertNoContent(spans);
  });

  it('nests under the active span (agent turn: transcription → agent → speech in one trace)', async () => {
    const { svc: stt } = makeStt();
    const tts = makeTts();
    await withAgentSpan({ name: 'Arkimede', userId: 'u3' }, async () => {
      await stt.transcribe(oneSecondWav(), 'audio.wav');
      await tts.synthesize(SECRET_SPEECH);
    });
    const spans = exporter.getFinishedSpans();
    const agent = spans.find((s) => s.name === 'invoke_agent Arkimede')!;
    const voice = [...byOp(spans, 'transcription'), ...byOp(spans, 'speech')];
    expect(voice).toHaveLength(2);
    for (const v of voice) {
      expect(v.spanContext().traceId).toBe(agent.spanContext().traceId);
      expect(v.parentSpanContext?.spanId).toBe(agent.spanContext().spanId);
      expect(v.attributes['user.id']).toBe('u3'); // inherited from the agent context
    }
    assertNoContent(spans);
  });

  it('errors: span status ERROR with the error type only; the voice error is rethrown unchanged', async () => {
    const { svc: stt } = makeStt({ fail: true });
    await expect(stt.transcribe(oneSecondWav(), 'audio.wav')).rejects.toThrow('transcription.failed');
    const tts = makeTts({ fail: true });
    await expect(tts.synthesize(SECRET_SPEECH)).rejects.toThrow('tts.failed');

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(2);
    for (const s of spans) {
      expect(s.status.code).toBe(SpanStatusCode.ERROR);
      expect(s.status.message).toBeUndefined();
      expect(s.attributes['error.type']).toBe('ServiceUnavailableException');
    }
    assertNoContent(spans);
  });

  /** Drives a real WyomingService through one asr request and one tts request. */
  async function wyomingAsrAndTts(handleUserId: string | null): Promise<ReadableSpan[]> {
    const { svc: stt } = makeStt();
    const tts = makeTts();
    const wy = new WyomingService({} as any, stt, tts, env, {} as any);
    (wy as any).handle = handleUserId
      ? { userId: handleUserId, userEmail: 'ha@example.test', agentId: null, agentName: null, model: 'arkimede' }
      : null;
    const sent: any[] = [];
    const socket = { destroyed: false, write: (b: Buffer) => { sent.push(b); return true; } } as any;
    const asr = { active: false, language: undefined, fmt: { rate: 16000, width: 2, channels: 1 }, chunks: [] as Buffer[], bytes: 0 };
    const handle = (ev: any) => (wy as any).handleEvent(socket, ev, asr, '127.0.0.1');

    await handle({ type: 'transcribe', data: { language: 'it' } });
    await handle({ type: 'audio-start', data: { rate: 16000, width: 2, channels: 1 } });
    await handle({ type: 'audio-chunk', data: { rate: 16000, width: 2, channels: 1 }, payload: Buffer.alloc(16000) });
    await handle({ type: 'audio-stop', data: {} });
    await handle({ type: 'synthesize', data: { text: SECRET_SPEECH } });
    expect(Buffer.concat(sent).toString('utf8')).toContain(SECRET_TRANSCRIPT); // the hub still gets it

    const spans = exporter.getFinishedSpans();
    const [t] = byOp(spans, 'transcription');
    const [s] = byOp(spans, 'speech');
    expect(t.attributes['voice.audio_seconds']).toBe(0.5);
    expect(s.attributes['voice.characters']).toBe(SECRET_SPEECH.length);
    for (const v of [t, s]) expect(v.parentSpanContext).toBeUndefined(); // one request per connection: own traces
    expect(t.spanContext().traceId).not.toBe(s.spanContext().traceId);
    assertNoContent(spans);
    return [t, s];
  }

  it('Wyoming asr / tts with a conversation user configured: spans act for that user', async () => {
    setRecordareOwnerResolver((u) => (u === 'ha-user' ? 'owner-ha' : undefined));
    for (const v of await wyomingAsrAndTts('ha-user')) {
      expect(v.attributes['user.id']).toBe('ha-user');
      expect(v.attributes['recordare.owner_id']).toBe('owner-ha');
    }
  });

  it('Wyoming asr / tts without a conversation user: spans without user', async () => {
    for (const v of await wyomingAsrAndTts(null)) {
      expect(v.attributes['user.id']).toBeUndefined();
      expect(v.attributes['recordare.owner_id']).toBeUndefined();
    }
  });

  it('non-WAV input: no audio length, still a span', async () => {
    const { svc } = makeStt();
    await svc.transcribe(Buffer.from('webm-bytes-not-a-wav'), 'audio.webm');
    const [s] = exporter.getFinishedSpans();
    expect(s.attributes['voice.audio_seconds']).toBeUndefined();
    expect(s.attributes['voice.operation']).toBe('transcription');
  });
});

describe('voice spans — tracing off', () => {
  it('no spans, same results, user helper is a pass-through', async () => {
    const saved = { a: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, b: process.env.OTEL_EXPORTER_OTLP_ENDPOINT };
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    try {
      const exporter = new InMemorySpanExporter();
      expect(initGenAiTracing({ spanProcessor: new SimpleSpanProcessor(exporter) })).toBe(false);
      const { svc: stt, calls } = makeStt();
      expect(await withTraceUser('u1', () => stt.transcribe(oneSecondWav(), 'audio.wav', 'it'))).toBe(SECRET_TRANSCRIPT);
      expect(calls[0]).toMatchObject({ model: 'small', language: 'it' });
      expect((await makeTts().synthesize(SECRET_SPEECH)).equals(halfSecondWav())).toBe(true);
      expect(exporter.getFinishedSpans()).toHaveLength(0);
    } finally {
      if (saved.a !== undefined) process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = saved.a;
      if (saved.b !== undefined) process.env.OTEL_EXPORTER_OTLP_ENDPOINT = saved.b;
    }
  });
});

describe('wavDurationSeconds', () => {
  it('reads the length from the header; undefined for anything else', () => {
    expect(wavDurationSeconds(oneSecondWav())).toBe(1);
    expect(wavDurationSeconds(Buffer.from('ID3 mp3 data'))).toBeUndefined();
    expect(wavDurationSeconds(Buffer.from('RIFF\0\0\0\0WAVE'))).toBeUndefined();
    expect(wavDurationSeconds(undefined)).toBeUndefined();
  });
});
