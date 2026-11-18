// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Text for reading a message aloud: markdown reduced to speakable plain text, and that text cut into pieces at
 * sentence ends so playback starts after the first short piece instead of after the whole message.
 */

/** The first piece is short (audio starts soon); the next ones are synthesized while the previous one plays. */
export const TTS_FIRST_CHUNK = 200;
export const TTS_CHUNK = 600;

/** Reduces markdown to speakable plain text (code blocks and tables are skipped; a line's end stays a sentence end). */
export function ttsPlainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')          // fenced code blocks
    .replace(/`([^`]+)`/g, '$1')              // inline code → its content
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')    // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')  // links → their label
    .replace(/^\s*\|.*\|\s*$/gm, ' ')         // table rows
    .replace(/^#{1,6}\s+/gm, '')              // heading markers
    .replace(/^\s*[-*+]\s+/gm, '')            // list bullets
    .replace(/^\s*\d+[.)]\s+/gm, '')          // numbered list markers
    .replace(/[*_~>#]/g, '')                  // emphasis leftovers
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    // A heading or a list item has no final punctuation: without one the voice would run it into the next line.
    .map((line) => (/[.!?…;:,]$/.test(line) ? line : `${line}.`))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Pieces of `text` for playback in order: cut at sentence ends (then at commas or spaces for a run-on sentence), the
 * first at most `first` chars, the others at most `rest`.
 */
export function ttsChunks(text: string, first = TTS_FIRST_CHUNK, rest = TTS_CHUNK): string[] {
  const pieces: string[] = [];
  let current = '';
  const limit = () => (pieces.length ? rest : first);
  for (let sentence of text.split(/(?<=[.!?…;:])\s+/).map((s) => s.trim()).filter(Boolean)) {
    if (current && current.length + 1 + sentence.length > limit()) { pieces.push(current); current = ''; }
    // A run-on sentence longer than a piece: cut at a comma or a space.
    while (!current && sentence.length > limit()) {
      const max = limit();
      const at = Math.max(sentence.lastIndexOf(', ', max), sentence.lastIndexOf(' ', max));
      const cut = at > 0 ? at + 1 : max;
      pieces.push(sentence.slice(0, cut).trim());
      sentence = sentence.slice(cut).trim();
    }
    if (sentence) current = current ? `${current} ${sentence}` : sentence;
  }
  if (current) pieces.push(current);
  return pieces;
}
