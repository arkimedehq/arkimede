// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * OcrService: level resolution (request/default capped by the admin maximum,
 * degraded to the nearest available level) and the fallbacks that keep the
 * pre-OCR behavior when the ocr-service is missing or fails. `fetch` is stubbed:
 * no network, no ocr-service.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OcrService } from '../../src/ocr/ocr.service';

type Health = { fast: boolean; structured: boolean } | null;

function makeService(opts: {
  db?: { ocrDefaultLevel?: string; ocrMaxLevel?: string } | null;
  health?: Health;                                   // null = service not deployed
  extract?: (engine: string) => { text: string } | Error;
  vision?: boolean;                                  // a vision LLM is configured
  visionText?: string;
} = {}) {
  const health = opts.health === undefined ? { fast: true, structured: true } : opts.health;
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: any) => {
    calls.push(String(url));
    if (String(url).endsWith('/health')) {
      if (!health) throw new Error('ECONNREFUSED');
      return new Response(JSON.stringify({ status: 'ok', engines: health }));
    }
    if (String(url).endsWith('/v1/extract')) {
      const engine = (init.body as FormData).get('engine') as string;
      const r = opts.extract?.(engine) ?? { text: `${engine} text of the document` };
      if (r instanceof Error) return new Response(r.message, { status: 500 });
      return new Response(JSON.stringify({ engine, pages: 1, totalPages: 1, ocrPages: 1, ...r }));
    }
    if (String(url).endsWith('/v1/render')) {
      const first = Number((init.body as FormData).get('first_page'));
      const pages = first === 1 ? [{ index: 1, text: 'native p1', hasImages: true, png: 'AAAA' }] : [];
      return new Response(JSON.stringify({ pages, totalPages: 1 }));
    }
    throw new Error(`unexpected fetch ${url}`);
  });

  const repo = {
    findOne: async () => (opts.db === null ? null : { id: 1, ...(opts.db ?? {}) }),
    save: async (row: any) => row,
  };
  const model = { invoke: vi.fn(async () => ({ content: opts.visionText ?? 'vision transcription' })) };
  const llmConfigs = {
    getVision: async () => (opts.vision === false ? null : { id: 'v' }),
    buildModelForConfig: async () => model,
  };
  const env = { get: (key: string, def?: any) => ({ OCR_BASE_URL: 'http://ocr:9200' } as any)[key] ?? def };
  const svc = new OcrService(env as any, repo as any, llmConfigs as any);
  return { svc, calls, model };
}

afterEach(() => vi.unstubAllGlobals());

describe('OcrService level resolution', () => {
  it('uses the admin default (fast when unset)', async () => {
    const { svc } = makeService({ db: null });
    expect(await svc.resolveLevel()).toBe('fast');
  });

  it('honors the requested level when available', async () => {
    const { svc } = makeService();
    expect(await svc.resolveLevel('structured')).toBe('structured');
    expect(await svc.resolveLevel('vision')).toBe('vision');
    expect(await svc.resolveLevel('none')).toBe('none');
  });

  it('caps the requested level and the default with the admin maximum', async () => {
    const { svc } = makeService({ db: { ocrDefaultLevel: 'vision', ocrMaxLevel: 'fast' } });
    expect(await svc.resolveLevel('vision')).toBe('fast');
    expect(await svc.resolveLevel()).toBe('fast');
    expect((await svc.getSettings()).defaultLevel).toBe('fast');
  });

  it('degrades to the nearest available level', async () => {
    const light = makeService({ health: { fast: true, structured: false } });
    expect(await light.svc.resolveLevel('structured')).toBe('fast');
    const noVision = makeService({ vision: false });
    expect(await noVision.svc.resolveLevel('vision')).toBe('structured');
    const missing = makeService({ health: null });
    expect(await missing.svc.resolveLevel('vision')).toBe('none');
  });

  it('reports why a level is unavailable', async () => {
    const { svc } = makeService({ health: { fast: true, structured: false }, vision: false });
    const byLevel = Object.fromEntries((await svc.levelStatuses()).map((s) => [s.level, s]));
    expect(byLevel.none.available).toBe(true);
    expect(byLevel.fast.available).toBe(true);
    expect(byLevel.structured).toMatchObject({ available: false, reason: 'engine_missing' });
    expect(byLevel.vision).toMatchObject({ available: false, reason: 'no_vision_model' });
    const missing = makeService({ health: null });
    expect((await missing.svc.levelStatuses())[1]).toMatchObject({ available: false, reason: 'service_missing' });
  });
});

describe('OcrService PDF extraction', () => {
  it('runs the ocr-service engine matching the level', async () => {
    const { svc } = makeService();
    expect(await svc.extractPdf(Buffer.from('%PDF'), 'a.pdf', 'structured')).toBe('structured text of the document');
  });

  it('returns null (native text layer) for level none, a missing service or a failure', async () => {
    expect(await makeService().svc.extractPdf(Buffer.from('%PDF'), 'a.pdf', 'none')).toBeNull();
    expect(await makeService({ health: null }).svc.extractPdf(Buffer.from('%PDF'), 'a.pdf')).toBeNull();
    const failing = makeService({ extract: () => new Error('boom') });
    expect(await failing.svc.extractPdf(Buffer.from('%PDF'), 'a.pdf')).toBeNull();
  });

  it('vision level transcribes each rendered page with the native text as a hint', async () => {
    const { svc, model } = makeService({ visionText: 'page one markdown' });
    expect(await svc.extractPdf(Buffer.from('%PDF'), 'a.pdf', 'vision')).toBe('page one markdown');
    const msg: any = (model.invoke.mock.calls[0] as any[])[0][0];
    expect(msg.content[0].image_url.url).toBe('data:image/png;base64,AAAA');
    expect(msg.content[1].text).toContain('native p1');
  });

  it('vision level keeps the native text of a page whose transcription fails', async () => {
    const { svc, model } = makeService();
    model.invoke.mockRejectedValueOnce(new Error('not multimodal'));
    expect(await svc.extractPdf(Buffer.from('%PDF'), 'a.pdf', 'vision')).toBe('native p1');
  });
});

describe('OcrService image extraction', () => {
  it('uses the ocr-service text when it finds some', async () => {
    const { svc, model } = makeService();
    expect(await svc.extractImage(Buffer.from('img'), 'image/png', 'a.png')).toBe('fast text of the document');
    expect(model.invoke).not.toHaveBeenCalled();
  });

  it('falls back to the vision model for pictures without text or a missing service', async () => {
    const noText = makeService({ extract: () => ({ text: '  ' }), visionText: 'a photo of a cat' });
    expect(await noText.svc.extractImage(Buffer.from('img'), 'image/png', 'a.png')).toBe('a photo of a cat');
    const missing = makeService({ health: null, visionText: 'legacy vision ocr' });
    expect(await missing.svc.extractImage(Buffer.from('img'), 'image/png', 'a.png')).toBe('legacy vision ocr');
  });

  it('skips OCR entirely when level none is requested', async () => {
    const { svc, model, calls } = makeService();
    expect(await svc.extractImage(Buffer.from('img'), 'image/png', 'a.png', 'none')).toBe('');
    expect(model.invoke).not.toHaveBeenCalled();
    expect(calls.some((u) => u.endsWith('/v1/extract'))).toBe(false);
  });
});
