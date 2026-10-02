// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Shared text chunker for every vector-indexing path.
 *
 * Text extraction from layout-heavy documents (tables, forms) pads with long runs of
 * spaces; a plain sliding window then produces chunks made only of whitespace, whose
 * vectors are identical noise that pollutes similarity search. So the text is normalized
 * first (horizontal whitespace runs → one space, 3+ line breaks → 2) and blank chunks are
 * dropped.
 *
 * Sliding window: step = size - overlap; chunk_i = text[i*step : i*step + size].
 */
export function normalizeForChunking(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function splitIntoChunks(text: string, size: number, overlap: number): string[] {
  const clean = normalizeForChunking(text);
  if (!clean) return [];
  const step = Math.max(1, size - overlap);
  const chunks: string[] = [];
  for (let i = 0; i < clean.length; i += step) {
    const chunk = clean.slice(i, i + size);
    if (chunk.trim()) chunks.push(chunk);
    if (i + size >= clean.length) break;
  }
  return chunks;
}
