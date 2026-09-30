// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * OCR levels for document text extraction, from the cheapest to the most
 * accurate. Ordered: the index is the "rank" used to cap a requested level
 * with the admin maximum and to degrade to the nearest available one.
 *
 *   none        native PDF text layer only (pdf-parse), no OCR of PDFs
 *   fast        ocr-service, PyMuPDF + Tesseract: native text + OCR of image
 *               areas, full-page OCR for scans
 *   structured  ocr-service, Docling: layout + tables + OCR → markdown
 *   vision      each page rendered and transcribed by the vision LLM
 *               (llm_configs.isVision ?? default), native text as a hint
 */
export const OCR_LEVELS = ['none', 'fast', 'structured', 'vision'] as const;
export type OcrLevel = typeof OCR_LEVELS[number];

export const DEFAULT_OCR_LEVEL: OcrLevel = 'fast';
export const DEFAULT_OCR_MAX_LEVEL: OcrLevel = 'vision';

export function ocrRank(level: OcrLevel): number {
  return OCR_LEVELS.indexOf(level);
}

export function isOcrLevel(value: unknown): value is OcrLevel {
  return typeof value === 'string' && (OCR_LEVELS as readonly string[]).includes(value);
}

/** Why a level cannot be used on this deployment (null = available). */
export type OcrUnavailableReason = 'service_missing' | 'engine_missing' | 'no_vision_model' | null;

export interface OcrLevelStatus {
  level:     OcrLevel;
  available: boolean;
  reason:    OcrUnavailableReason;
}
