// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file ocr.service.ts
 *
 * Document OCR with selectable levels (see {@link OcrLevel}).
 *
 *   fast / structured → bundled ocr-service (`POST /v1/extract`, engine = level)
 *   vision            → ocr-service renders each page (`POST /v1/render`), the
 *                       vision LLM transcribes it (native text layer as a hint)
 *   none              → no OCR: the caller keeps its native extraction
 *
 * The level of a request is the requested one (or the admin default), capped by
 * the admin maximum and degraded to the nearest level available on this
 * deployment (ocr-service not deployed, image built without the structured
 * engine, no vision model). Every failure degrades too: callers get `null` for
 * PDFs and fall back to the native text layer, as before this service existed.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { HumanMessage } from '@langchain/core/messages';
import { AppConfigEntity } from '../app-config/app-config.entity';
import { LlmConfigsService } from '../llm-configs/llm-configs.service';
import { AuditService } from '../audit/audit.service';
import { OCR_IMAGE_PROMPT, ocrPagePrompt } from '../prompts/prompts';
import {
  DEFAULT_OCR_LEVEL, DEFAULT_OCR_MAX_LEVEL, OCR_LEVELS, OcrLevel, OcrLevelStatus, isOcrLevel, ocrRank,
} from './ocr.types';

const CONFIG_ID = 1;
const HEALTH_TTL_MS = 30_000;
const HEALTH_TIMEOUT_MS = 2_000;
/** Pages rendered per /v1/render call (bounds the size of each JSON response). */
const RENDER_BATCH = 8;

interface Engines { fast: boolean; structured: boolean }

export interface OcrSettings {
  defaultLevel: OcrLevel;
  maxLevel:     OcrLevel;
}

@Injectable()
export class OcrService {
  private readonly logger = new Logger(OcrService.name);
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly visionMaxPages: number;
  private readonly visionConcurrency: number;
  private health: { engines: Engines | null; at: number } | null = null;

  constructor(
    @Inject(ConfigService) env: ConfigService,
    @InjectRepository(AppConfigEntity) private readonly configRepo: Repository<AppConfigEntity>,
    @Optional() @Inject(LlmConfigsService) private readonly llmConfigs: LlmConfigsService | null = null,
    @Optional() private readonly audit?: AuditService,
  ) {
    this.baseUrl           = env.get<string>('OCR_BASE_URL', 'http://ocr:9200').replace(/\/+$/, '');
    this.timeoutMs         = Number(env.get('OCR_TIMEOUT_MS', 30 * 60_000));
    this.visionMaxPages    = Number(env.get('OCR_VISION_MAX_PAGES', 100));
    this.visionConcurrency = Math.max(1, Number(env.get('OCR_VISION_CONCURRENCY', 2)));
  }

  // ── settings & availability ───────────────────────────────────────────────

  async getSettings(): Promise<OcrSettings> {
    const cfg = await this.configRepo.findOne({ where: { id: CONFIG_ID } });
    const maxLevel     = isOcrLevel(cfg?.ocrMaxLevel) ? cfg!.ocrMaxLevel : DEFAULT_OCR_MAX_LEVEL;
    const rawDefault   = isOcrLevel(cfg?.ocrDefaultLevel) ? cfg!.ocrDefaultLevel : DEFAULT_OCR_LEVEL;
    const defaultLevel = ocrRank(rawDefault) > ocrRank(maxLevel) ? maxLevel : rawDefault;
    return { defaultLevel, maxLevel };
  }

  async updateSettings(dto: OcrSettings, actorId?: string): Promise<OcrSettings> {
    const current = await this.configRepo.findOne({ where: { id: CONFIG_ID } });
    await this.configRepo.save({
      ...current,
      id: CONFIG_ID,
      ocrDefaultLevel: dto.defaultLevel,
      ocrMaxLevel:     dto.maxLevel,
    });
    this.logger.log(`OcrConfig: updated — default=${dto.defaultLevel} max=${dto.maxLevel}`);
    await this.audit?.record({
      actorId: actorId ?? null,
      action: 'appconfig.update',
      resource: 'ocr',
      outcome: 'ok',
      ctx: { section: 'ocr', defaultLevel: dto.defaultLevel, maxLevel: dto.maxLevel },
    });
    return this.getSettings();
  }

  /** Engines of the ocr-service (null = not deployed / unreachable), cached. */
  private async engines(): Promise<Engines | null> {
    if (this.health && Date.now() - this.health.at < HEALTH_TTL_MS) return this.health.engines;
    let engines: Engines | null = null;
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
      const json: any = res.ok ? await res.json() : null;
      // A deployed service still loading answers too: count it, engines unknown → fast only.
      engines = { fast: json?.engines?.fast ?? true, structured: !!json?.engines?.structured };
    } catch {
      engines = null;
    }
    this.health = { engines, at: Date.now() };
    return engines;
  }

  /** Availability of every level on this deployment (with the reason when not). */
  async levelStatuses(): Promise<OcrLevelStatus[]> {
    const engines = await this.engines();
    const vision  = await this.llmConfigs?.getVision().catch(() => null);
    return OCR_LEVELS.map((level): OcrLevelStatus => {
      if (level === 'none') return { level, available: true, reason: null };
      if (!engines) return { level, available: false, reason: 'service_missing' };
      if (level === 'fast' && !engines.fast) return { level, available: false, reason: 'engine_missing' };
      if (level === 'structured' && !engines.structured) return { level, available: false, reason: 'engine_missing' };
      if (level === 'vision' && !vision) return { level, available: false, reason: 'no_vision_model' };
      return { level, available: true, reason: null };
    });
  }

  /**
   * Effective level of a request: requested (or admin default), capped by the
   * admin maximum, then degraded to the highest available level below it.
   */
  async resolveLevel(requested?: OcrLevel | null): Promise<OcrLevel> {
    const { defaultLevel, maxLevel } = await this.getSettings();
    let rank = Math.min(ocrRank(requested ?? defaultLevel), ocrRank(maxLevel));
    const statuses = await this.levelStatuses();
    while (rank > 0 && !statuses[rank].available) rank--;
    return OCR_LEVELS[rank];
  }

  // ── extraction ────────────────────────────────────────────────────────────

  /**
   * Text of a PDF at the resolved level, or null when no OCR applies (level
   * `none`) or it failed: the caller then uses the native text layer.
   */
  async extractPdf(buf: Buffer, name: string, requested?: OcrLevel | null): Promise<string | null> {
    const level = await this.resolveLevel(requested);
    if (level === 'none') return null;
    try {
      if (level === 'vision') return await this.visionPdf(buf, name);
      return await this.serviceExtract(buf, 'application/pdf', name, level);
    } catch (err: any) {
      this.logger.warn(`PDF OCR (${level}) failed for ${name}, falling back to the native text: ${err?.message}`);
      return null;
    }
  }

  /**
   * Text of an image. `fast`/`structured` run the ocr-service; when they find no
   * text (a photo, a chart) or cannot run, the vision model reads or describes
   * the image, so pictures still get a searchable description. Level `none`
   * explicitly requested skips OCR entirely.
   */
  async extractImage(buf: Buffer, mimeType: string, name: string, requested?: OcrLevel | null): Promise<string> {
    const { defaultLevel } = await this.getSettings();
    if ((requested ?? defaultLevel) === 'none') return '';
    const level = await this.resolveLevel(requested);
    if (level === 'fast' || level === 'structured') {
      try {
        const text = await this.serviceExtract(buf, mimeType, name, level);
        if (text.replace(/\s+/g, '').length >= 20) return text;
      } catch (err: any) {
        this.logger.warn(`Image OCR (${level}) failed for ${name}: ${err?.message}`);
      }
    }
    try {
      return await this.visionTranscribe(buf.toString('base64'), mimeType, OCR_IMAGE_PROMPT, 1024);
    } catch (err: any) {
      this.logger.warn(`Image OCR via vision model failed for ${name}: ${err?.message}`);
      return '';
    }
  }

  private async serviceExtract(buf: Buffer, mimeType: string, name: string, engine: 'fast' | 'structured'): Promise<string> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(buf)], { type: mimeType }), name);
    form.append('engine', engine);
    const json = await this.post('/v1/extract', form);
    this.logger.log(
      `OCR ${engine} ${name}: ${json.pages}/${json.totalPages} pages` +
      `${json.ocrPages != null ? `, ${json.ocrPages} OCRed` : ''} → ${String(json.text ?? '').length} chars`,
    );
    if (json.totalPages > json.pages) {
      this.logger.warn(`OCR ${engine} ${name}: truncated at ${json.pages} of ${json.totalPages} pages`);
    }
    return String(json.text ?? '');
  }

  /** Renders the pages in batches and transcribes each with the vision model. */
  private async visionPdf(buf: Buffer, name: string): Promise<string> {
    const out: string[] = [];
    const blob = new Blob([new Uint8Array(buf)], { type: 'application/pdf' });
    let total = Infinity;
    for (let first = 1; first <= Math.min(total, this.visionMaxPages); first += RENDER_BATCH) {
      const form = new FormData();
      form.append('file', blob, name);
      form.append('first_page', String(first));
      form.append('max_pages', String(Math.min(RENDER_BATCH, this.visionMaxPages - first + 1)));
      const json = await this.post('/v1/render', form);
      total = json.totalPages;
      const pages: { index: number; text: string; png: string }[] = json.pages ?? [];
      out.push(...await this.mapLimit(pages, this.visionConcurrency, async (p) => {
        try {
          const text = await this.visionTranscribe(p.png, 'image/png', ocrPagePrompt(p.text), 4096);
          return text.trim() || p.text;
        } catch (err: any) {
          this.logger.warn(`Vision OCR page ${p.index} of ${name} failed, using its native text: ${err?.message}`);
          return p.text;
        }
      }));
      if (!pages.length) break;
    }
    if (total > this.visionMaxPages) {
      this.logger.warn(`Vision OCR ${name}: truncated at ${this.visionMaxPages} of ${total} pages (OCR_VISION_MAX_PAGES)`);
    }
    this.logger.log(`OCR vision ${name}: ${out.length} pages transcribed`);
    return out.length > 1
      ? out.map((t, i) => `--- Page ${i + 1} ---\n${t}`).join('\n\n')
      : (out[0] ?? '');
  }

  /**
   * One multimodal call to the vision model (llm_configs.isVision ?? default).
   * Cross-provider via LangChain's `image_url` data-URL block. Throws when no
   * model is configured or it does not accept images.
   */
  private async visionTranscribe(base64: string, mimeType: string, prompt: string, maxTokens: number): Promise<string> {
    const entity = await this.llmConfigs?.getVision();
    if (!entity) throw new Error('no LLM config (Settings → AI System)');
    const model = await this.llmConfigs!.buildModelForConfig(entity, { maxTokens });
    const response = await model.invoke([
      new HumanMessage({
        content: [
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
          { type: 'text', text: prompt },
        ],
      }),
    ]);
    const content: any = response.content;
    if (typeof content === 'string') return content;
    return (content as any[]).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
  }

  private async post(path: string, form: FormData): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`ocr-service ${path} → HTTP ${res.status} ${detail.slice(0, 200)}`);
    }
    return res.json();
  }

  private async mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    });
    await Promise.all(workers);
    return results;
  }
}
