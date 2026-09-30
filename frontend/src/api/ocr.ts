// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import api from './client';

/** Document OCR levels, cheapest → most accurate (backend: ocr/ocr.types.ts). */
export const OCR_LEVELS = ['none', 'fast', 'structured', 'vision'] as const;
export type OcrLevel = typeof OCR_LEVELS[number];

export type OcrUnavailableReason = 'service_missing' | 'engine_missing' | 'no_vision_model' | null;

export interface OcrLevelStatus {
  level:     OcrLevel;
  available: boolean;
  reason:    OcrUnavailableReason;
}

export interface OcrConfig {
  defaultLevel: OcrLevel;
  maxLevel:     OcrLevel;
  levels:       OcrLevelStatus[];
}

export const ocrApi = {
  /** GET /api/ocr/levels — levels offered to users (default, maximum, availability) */
  levels: () => api.get<OcrConfig>('/ocr/levels').then((r) => r.data),

  /** GET /api/admin/config/ocr */
  getAdmin: () => api.get<OcrConfig>('/admin/config/ocr').then((r) => r.data),

  /** PATCH /api/admin/config/ocr */
  updateAdmin: (dto: { defaultLevel: OcrLevel; maxLevel: OcrLevel }) =>
    api.patch<OcrConfig>('/admin/config/ocr', dto).then((r) => r.data),
};

/** True for the file types whose text extraction goes through OCR. */
export function isOcrCandidate(mimeType: string): boolean {
  return mimeType === 'application/pdf' || mimeType.startsWith('image/');
}
