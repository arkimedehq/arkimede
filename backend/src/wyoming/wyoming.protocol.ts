// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file wyoming.protocol.ts
 *
 * Pure helpers for the Wyoming voice protocol (https://github.com/rhasspy/wyoming):
 * event framing (encode/decode) and the PCM ⇄ WAV conversions the server needs.
 * No I/O here — everything is unit-testable in isolation.
 *
 * Wire format — one event is:
 *   {"type": "...", "data": {...}, "data_length": N?, "payload_length": M?}\n
 *   <N bytes of extra UTF-8 JSON, merged into data>   (optional)
 *   <M bytes of binary payload, typically PCM audio>   (optional)
 */

export interface WyomingEvent {
  type: string;
  data: Record<string, any>;
  payload?: Buffer;
}

/** Serializes an event into its wire representation. */
export function encodeEvent(ev: WyomingEvent): Buffer {
  const header: Record<string, any> = { type: ev.type, data: ev.data ?? {} };
  if (ev.payload?.length) header.payload_length = ev.payload.length;
  const head = Buffer.from(JSON.stringify(header) + '\n', 'utf8');
  return ev.payload?.length ? Buffer.concat([head, ev.payload]) : head;
}

/**
 * Incremental decoder: feed it raw socket chunks, drain complete events with
 * `next()`. Keeps partial frames between calls.
 */
export class WyomingDecoder {
  private buf: Buffer = Buffer.alloc(0);

  /** Upper bound of a single frame (header + data + payload) to keep memory bounded. */
  static readonly MAX_FRAME_BYTES = 16 * 1024 * 1024;

  feed(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    if (this.buf.length > WyomingDecoder.MAX_FRAME_BYTES) {
      throw new Error('wyoming: frame too large');
    }
  }

  /** Returns the next complete event, or null if more bytes are needed. */
  next(): WyomingEvent | null {
    const nl = this.buf.indexOf(0x0a);
    if (nl < 0) return null;
    const headerText = this.buf.subarray(0, nl).toString('utf8').trim();
    if (!headerText) {            // tolerate blank lines
      this.buf = this.buf.subarray(nl + 1);
      return this.next();
    }
    let header: any;
    try {
      header = JSON.parse(headerText);
    } catch {
      throw new Error('wyoming: invalid event header');
    }
    const dataLen    = Number(header.data_length ?? 0) || 0;
    const payloadLen = Number(header.payload_length ?? 0) || 0;
    const total = nl + 1 + dataLen + payloadLen;
    if (this.buf.length < total) return null;

    let data: Record<string, any> = header.data && typeof header.data === 'object' ? header.data : {};
    if (dataLen > 0) {
      const extra = this.buf.subarray(nl + 1, nl + 1 + dataLen).toString('utf8');
      try { data = { ...data, ...JSON.parse(extra) }; } catch { /* ignore malformed extra data */ }
    }
    const payload = payloadLen > 0
      ? Buffer.from(this.buf.subarray(nl + 1 + dataLen, total))
      : undefined;
    this.buf = this.buf.subarray(total);
    return { type: String(header.type ?? ''), data, payload };
  }
}

// ── WAV helpers ──────────────────────────────────────────────────────────────

export interface PcmFormat { rate: number; width: number; channels: number }

/** Wraps raw PCM samples in a minimal RIFF/WAVE container. */
export function pcmToWav(pcm: Buffer, fmt: PcmFormat): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = fmt.rate * fmt.channels * fmt.width;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);                     // PCM fmt chunk size
  header.writeUInt16LE(1, 20);                      // audio format: PCM
  header.writeUInt16LE(fmt.channels, 22);
  header.writeUInt32LE(fmt.rate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(fmt.channels * fmt.width, 32);
  header.writeUInt16LE(fmt.width * 8, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Extracts format + raw samples from a WAV buffer (walks the RIFF chunks, so
 * extra chunks such as LIST/INFO before `data` are fine). Throws on non-PCM.
 */
export function parseWav(wav: Buffer): { fmt: PcmFormat; pcm: Buffer } {
  if (wav.length < 12 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let pos = 12;
  let fmt: PcmFormat | null = null;
  while (pos + 8 <= wav.length) {
    const id   = wav.toString('ascii', pos, pos + 4);
    const size = wav.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      const audioFormat = wav.readUInt16LE(body);
      // 1 = PCM, 0xFFFE = WAVE_FORMAT_EXTENSIBLE (PCM sub-format is the common case)
      if (audioFormat !== 1 && audioFormat !== 0xfffe) throw new Error(`unsupported WAV format ${audioFormat}`);
      fmt = {
        channels: wav.readUInt16LE(body + 2),
        rate:     wav.readUInt32LE(body + 4),
        width:    wav.readUInt16LE(body + 14) / 8,
      };
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV data chunk before fmt chunk');
      // Some encoders write 0/0xFFFFFFFF for streamed output: take what is there.
      const end = size === 0 || size === 0xffffffff ? wav.length : Math.min(wav.length, body + size);
      return { fmt, pcm: Buffer.from(wav.subarray(body, end)) };
    }
    pos = body + size + (size % 2); // chunks are word-aligned
  }
  throw new Error('WAV data chunk not found');
}

/** Splits PCM into frame-aligned chunks of ~`samplesPerChunk` samples. */
export function chunkPcm(pcm: Buffer, fmt: PcmFormat, samplesPerChunk = 1024): Buffer[] {
  const frame = fmt.width * fmt.channels;
  const size  = Math.max(frame, samplesPerChunk * frame);
  const out: Buffer[] = [];
  for (let i = 0; i < pcm.length; i += size) out.push(pcm.subarray(i, Math.min(pcm.length, i + size)));
  return out;
}
