// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file voice-match.ts
 *
 * Who spoke, from a voiceprint (plain data, no I/O): the cosine similarity of a turn's embedding with each learned
 * voice (the centroid of its samples). A voice is recognised only when its score is above the threshold AND clearly
 * above the next one (two similar voices are nobody rather than a guess). The score becomes the confidence the memory
 * reads: strong 0.8, fair 0.65 — never 0.85 or more, the level that opens what came from a private message: a voice
 * alone is not that sure.
 *
 * And whom the memory hears: the person's Home Assistant identity when the voice is linked to one (the memory already
 * knows it from the presence), else the voice's own (`voice`/<id>), named after it. In a personal memory the voice of
 * its holder (the voice linked to the account's own user) is the holder, "I": no identity.
 */

/** Below this cosine nobody is recognised. Calibrated on real voices (Settings → Voices shows the scores). */
export const MATCH_THRESHOLD = 0.5;
/** From this cosine the recognition is strong. */
export const STRONG_THRESHOLD = 0.65;
/** The best voice must beat the next one by this much. */
export const MATCH_MARGIN = 0.08;
export const STRONG_CONFIDENCE = 0.8;
export const FAIR_CONFIDENCE = 0.65;
/** Samples kept per voice (the oldest go). */
export const MAX_SAMPLES = 20;

/** A sentence of fewer words gives a voiceprint too unsure to learn from ("yes", "ok"). */
export const ENROLL_MIN_WORDS = 3;
/** From this many samples a voice knows itself well enough to tell a sample that is not it. */
export const OUTLIER_MIN_SAMPLES = 3;

export function normalize(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return n > 0 ? v.map((x) => x / n) : v.slice();
}

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/** The normalized mean of normalized samples; null without samples. */
export function centroid(samples: number[][]): number[] | null {
  const valid = samples.filter((s) => s.length && s.length === samples[0].length);
  if (!valid.length) return null;
  const sum = new Array(valid[0].length).fill(0);
  for (const s of valid.map(normalize)) for (let i = 0; i < s.length; i++) sum[i] += s[i];
  return normalize(sum);
}

export interface VoiceMatch {
  id: string;
  score: number;
  /** The next voice's score (0 when there is none). */
  second: number;
  confidence: number;
}

/** The voice that spoke, or null; `best` is reported either way (the scores the admin calibrates with). */
export function matchVoice(voices: Array<{ id: string; centroid: number[] }>, embedding: number[]): { match: VoiceMatch | null; best: { id: string; score: number; second: number } | null } {
  const e = normalize(embedding);
  const scored = voices.map((v) => ({ id: v.id, score: cosine(v.centroid, e) })).sort((a, b) => b.score - a.score);
  if (!scored.length) return { match: null, best: null };
  const [top, next] = scored;
  const second = next?.score ?? 0;
  const best = { id: top.id, score: top.score, second };
  if (top.score < MATCH_THRESHOLD || top.score - second < MATCH_MARGIN) return { match: null, best };
  return { match: { ...best, confidence: top.score >= STRONG_THRESHOLD ? STRONG_CONFIDENCE : FAIR_CONFIDENCE }, best };
}

export interface SpeakerIdentity {
  /** The holder of a personal memory: the turn is theirs, no participant identity. */
  holder: boolean;
  identity: { channel: string; externalId: string } | null;
  displayName: string;
}

/** Whom the memory hears for a recognised voice. */
export function speakerIdentity(
  voice: { id: string; name: string; haPerson: string | null; userId: string | null },
  memory: { userId: string; mode: 'personal' | 'entity' | null },
): SpeakerIdentity {
  if (memory.mode === 'personal' && voice.userId && voice.userId === memory.userId) {
    return { holder: true, identity: null, displayName: voice.name };
  }
  const identity = voice.haPerson ? { channel: 'homeassistant', externalId: voice.haPerson } : { channel: 'voice', externalId: voice.id };
  return { holder: false, identity, displayName: voice.name };
}

/** The text a satellite sent, as a key that finds its voiceprint again when the hub hands it to the conversation. */
export function turnKey(text: string): string {
  return text.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

/** Why a sample is not learned: too short, closer to another voice, or unlike the voice's own samples. */
export type SampleRejection =
  | { reason: 'short' }
  | { reason: 'other'; name: string; score: number }
  | { reason: 'outlier'; score: number };

/**
 * Whether a sentence spoken while a voice is being learned is that voice: not too short; not another known voice (one
 * that would recognise it as surely as the voice itself, or, before the voice has any sample, strongly); not unlike the
 * voice's own samples once there are enough of them (noise, someone not known yet). Null when it can be learned.
 */
export function checkSample(
  text: string, embedding: number[], own: number[][], others: Array<{ name: string; centroid: number[] }>,
): SampleRejection | null {
  if (text.trim().split(/\s+/).filter(Boolean).length < ENROLL_MIN_WORDS) return { reason: 'short' };
  const e = normalize(embedding);
  const ownCentroid = centroid(own);
  const ownScore = ownCentroid ? cosine(ownCentroid, e) : null;
  const other = others.map((o) => ({ name: o.name, score: cosine(o.centroid, e) })).sort((a, b) => b.score - a.score)[0];
  if (other && (ownScore === null ? other.score >= STRONG_THRESHOLD : other.score >= MATCH_THRESHOLD && other.score > ownScore - MATCH_MARGIN)) {
    return { reason: 'other', name: other.name, score: other.score };
  }
  if (ownScore !== null && own.length >= OUTLIER_MIN_SAMPLES && ownScore < MATCH_THRESHOLD) return { reason: 'outlier', score: ownScore };
  return null;
}

export interface SampleScore {
  /** Its voice's other samples (null: no other sample). */
  own: number | null;
  /** The closest other voice. */
  other: { name: string; score: number } | null;
  /** Would not be learned today: closer to another voice, or unlike its own. */
  suspect: boolean;
}

/** Each sample against its voice's other samples (leave-one-out) and the other voices: the ones that do not belong. */
export function scoreSamples(samples: number[][], others: Array<{ name: string; centroid: number[] }>): SampleScore[] {
  return samples.map((x, i) => {
    const rest = centroid(samples.filter((_, j) => j !== i));
    const own = rest ? cosine(rest, normalize(x)) : null;
    const best = others.map((o) => ({ name: o.name, score: cosine(o.centroid, normalize(x)) })).sort((a, b) => b.score - a.score)[0] ?? null;
    const suspect = own !== null && ((samples.length - 1 >= OUTLIER_MIN_SAMPLES && own < MATCH_THRESHOLD)
      || (!!best && best.score >= MATCH_THRESHOLD && best.score > own - MATCH_MARGIN));
    return { own, other: best, suspect };
  });
}
