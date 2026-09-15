// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Wyoming protocol helpers: event framing (header line + optional data/payload),
 * incremental decoding across fragmented socket chunks, and the WAV ⇄ PCM
 * conversions used by the STT/TTS bridge. Pure functions — no Nest wiring.
 */
import { describe, expect, it } from 'vitest';
import {
  WyomingDecoder, chunkPcm, encodeEvent, parseWav, pcmToWav,
} from '../../src/wyoming/wyoming.protocol';

describe('encodeEvent / WyomingDecoder', () => {
  it('round-trips an event without payload', () => {
    const dec = new WyomingDecoder();
    dec.feed(encodeEvent({ type: 'describe', data: {} }));
    expect(dec.next()).toEqual({ type: 'describe', data: {}, payload: undefined });
    expect(dec.next()).toBeNull();
  });

  it('round-trips an event with a binary payload and keeps payload_length exact', () => {
    const payload = Buffer.from([1, 2, 3, 0x0a, 5, 6]);   // contains a newline byte on purpose
    const wire = encodeEvent({ type: 'audio-chunk', data: { rate: 16000, width: 2, channels: 1 }, payload });
    expect(JSON.parse(wire.subarray(0, wire.indexOf(0x0a)).toString()).payload_length).toBe(6);
    const dec = new WyomingDecoder();
    dec.feed(wire);
    const ev = dec.next()!;
    expect(ev.type).toBe('audio-chunk');
    expect(ev.data).toEqual({ rate: 16000, width: 2, channels: 1 });
    expect(Buffer.compare(ev.payload!, payload)).toBe(0);
  });

  it('reassembles events split across arbitrary chunk boundaries', () => {
    const payload = Buffer.alloc(1000, 7);
    const wire = Buffer.concat([
      encodeEvent({ type: 'audio-start', data: { rate: 16000, width: 2, channels: 1 } }),
      encodeEvent({ type: 'audio-chunk', data: { rate: 16000, width: 2, channels: 1 }, payload }),
      encodeEvent({ type: 'audio-stop', data: {} }),
    ]);
    const dec = new WyomingDecoder();
    const types: string[] = [];
    for (let i = 0; i < wire.length; i += 33) {          // deliberately odd fragment size
      dec.feed(wire.subarray(i, Math.min(wire.length, i + 33)));
      let ev; while ((ev = dec.next())) types.push(ev.type);
    }
    expect(types).toEqual(['audio-start', 'audio-chunk', 'audio-stop']);
  });

  it('merges the optional extra data block (data_length) into data', () => {
    const extra = Buffer.from(JSON.stringify({ language: 'it' }));
    const head = Buffer.from(JSON.stringify({ type: 'transcribe', data: { name: 'm' }, data_length: extra.length }) + '\n');
    const dec = new WyomingDecoder();
    dec.feed(Buffer.concat([head, extra]));
    expect(dec.next()!.data).toEqual({ name: 'm', language: 'it' });
  });

  it('rejects a malformed header', () => {
    const dec = new WyomingDecoder();
    dec.feed(Buffer.from('not json\n'));
    expect(() => dec.next()).toThrow(/invalid event header/);
  });
});

describe('pcmToWav / parseWav', () => {
  it('produces a 44-byte PCM header that parseWav reads back', () => {
    const pcm = Buffer.from([0, 0, 0xff, 0x7f, 0, 0x80]);
    const wav = pcmToWav(pcm, { rate: 16000, width: 2, channels: 1 });
    expect(wav.length).toBe(44 + pcm.length);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    const parsed = parseWav(wav);
    expect(parsed.fmt).toEqual({ rate: 16000, width: 2, channels: 1 });
    expect(Buffer.compare(parsed.pcm, pcm)).toBe(0);
  });

  it('skips extra RIFF chunks before data (e.g. LIST) and honors word alignment', () => {
    const pcm = Buffer.from([1, 2, 3, 4]);
    const base = pcmToWav(pcm, { rate: 22050, width: 2, channels: 1 });
    // 5-byte LIST body → 1 padding byte before the next chunk
    const listLen = Buffer.alloc(4); listLen.writeUInt32LE(5, 0);
    const listChunk = Buffer.concat([Buffer.from('LIST'), listLen, Buffer.from('INFOx'), Buffer.alloc(1)]);
    const wav = Buffer.concat([base.subarray(0, 36), listChunk, base.subarray(36)]);
    const parsed = parseWav(wav);
    expect(parsed.fmt.rate).toBe(22050);
    expect(Buffer.compare(parsed.pcm, pcm)).toBe(0);
  });

  it('rejects non-WAV input', () => {
    expect(() => parseWav(Buffer.from('hello world, not audio'))).toThrow(/RIFF/);
  });
});

describe('chunkPcm', () => {
  it('splits on frame boundaries and preserves every byte', () => {
    const fmt = { rate: 16000, width: 2, channels: 2 };   // 4-byte frames
    const pcm = Buffer.alloc(4 * 1024 * 2 + 4 * 10, 1);    // 2 full chunks + 10 frames
    const chunks = chunkPcm(pcm, fmt, 1024);
    expect(chunks.map((c) => c.length)).toEqual([4096, 4096, 40]);
    expect(Buffer.compare(Buffer.concat(chunks), pcm)).toBe(0);
  });
});
