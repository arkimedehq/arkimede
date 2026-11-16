// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Who spoke to a satellite (voice-id/): a voice is recognised only above the threshold and clearly above the next one,
 * with a confidence that never reaches the level of a private message; whom the memory hears (the holder of a
 * personal memory, a Home Assistant person, the voice itself); a voice learned from the turns spoken to a satellite
 * while it is being enrolled; the voiceprint found again by the turn's text; samples encrypted at rest.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import {
  FAIR_CONFIDENCE, MATCH_MARGIN, STRONG_CONFIDENCE, centroid, checkSample, cosine, matchVoice, normalize, scoreSamples, speakerIdentity, turnKey,
} from '../../src/voice-id/voice-match';
import { ENROLL_SAMPLES, VoiceIdService } from '../../src/voice-id/voice-id.service';
import { fakeRepo } from './helpers/fake-repo';

beforeAll(() => { process.env.TOOL_SECRETS_KEY = 'c'.repeat(64); });

/** A unit vector at `deg` degrees in the plane of the first two axes (cos of the angle = their similarity). */
const at = (deg: number) => [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180), 0];

describe('voice-match', () => {
  it('centroid and cosine', () => {
    expect(cosine(normalize([3, 4]), normalize([3, 4]))).toBeCloseTo(1);
    expect(centroid([[1, 0], [0, 1]])).toEqual(normalize([1, 1]));
    expect(centroid([])).toBeNull();
  });

  it('recognises above the threshold and clearly above the next voice; fair and strong confidence, never 0.85', () => {
    const voices = [{ id: 'a', centroid: at(0) }, { id: 'b', centroid: at(90) }];
    expect(matchVoice(voices, at(10)).match).toMatchObject({ id: 'a', confidence: STRONG_CONFIDENCE });
    expect(matchVoice([{ id: 'a', centroid: at(0) }], at(55)).match).toMatchObject({ id: 'a', confidence: FAIR_CONFIDENCE });
    expect(STRONG_CONFIDENCE).toBeLessThan(0.85);
    // Far from every voice: nobody, but the best score is reported (to calibrate).
    const far = matchVoice([{ id: 'a', centroid: at(0) }], at(80));
    expect(far.match).toBeNull();
    expect(far.best!.id).toBe('a');
    // Two voices equally close: nobody rather than a guess.
    expect(matchVoice(voices, at(45)).match).toBeNull();
    expect(MATCH_MARGIN).toBeGreaterThan(0);
    expect(matchVoice([], at(0))).toEqual({ match: null, best: null });
  });

  it('a sentence is learned only when long enough, not another voice, and like the voice\'s own samples', () => {
    const sam = [{ name: 'Sam', centroid: at(90) }];
    expect(checkSample('sì', at(0), [], sam)).toEqual({ reason: 'short' });
    expect(checkSample('accendi la luce', at(0), [], sam)).toBeNull();
    // No sample yet: only a voice strongly another's is refused (a new voice may resemble a known one a little).
    expect(checkSample('accendi la luce', at(85), [], sam)).toMatchObject({ reason: 'other', name: 'Sam' });
    expect(checkSample('accendi la luce', at(30), [], sam)).toBeNull();
    // With samples: another voice as close as the own one (within the margin) is refused.
    expect(checkSample('accendi la luce', at(45), [at(0), at(5)], sam)).toMatchObject({ reason: 'other', name: 'Sam' });
    expect(checkSample('accendi la luce', at(30), [at(0), at(5)], sam)).toBeNull();
    // Enough samples: one unlike them all is noise or someone else.
    expect(checkSample('accendi la luce', at(-70), [at(0), at(5), at(10)], sam)).toMatchObject({ reason: 'outlier' });
    expect(checkSample('accendi la luce', at(-70), [at(0), at(5)], sam)).toBeNull();
  });

  it('each sample scored against its voice\'s others and the other voices: the ones that do not belong are suspect', () => {
    const r = scoreSamples([at(0), at(5), at(10), at(80)], [{ name: 'Sam', centroid: at(90) }]);
    expect(r.map((x) => x.suspect)).toEqual([false, false, false, true]);
    expect(r[3].other).toMatchObject({ name: 'Sam' });
    expect(r[0].own).toBeGreaterThan(0.8);
    expect(scoreSamples([at(0)], [])).toEqual([{ own: null, other: null, suspect: false }]);
  });

  it('whom the memory hears: the holder of a personal memory, else the Home Assistant person, else the voice', () => {
    const voice = { id: 'v1', name: 'Alex', haPerson: 'person.alex', userId: 'u1' };
    expect(speakerIdentity(voice, { userId: 'u1', mode: 'personal' })).toEqual({ holder: true, identity: null, displayName: 'Alex' });
    expect(speakerIdentity(voice, { userId: 'u1', mode: 'entity' })).toEqual({ holder: false, identity: { channel: 'homeassistant', externalId: 'person.alex' }, displayName: 'Alex' });
    expect(speakerIdentity({ ...voice, haPerson: null }, { userId: 'house', mode: 'personal' }).identity).toEqual({ channel: 'voice', externalId: 'v1' });
    expect(turnKey('  Accendi   la Luce ')).toBe('accendi la luce');
  });
});

describe('VoiceIdService', () => {
  function setup(on = true) {
    const repo = fakeRepo<any>();
    const config = fakeRepo<any>([{ id: 1, voiceIdEnabled: on }]);
    const users = fakeRepo<any>([{ id: 'u1' }]);
    const env = { get: (_k: string, d?: string) => d };
    const identity = { cachedMemoryId: vi.fn(), details: vi.fn(() => ({ mode: 'entity', atlasUrl: null })) };
    const svc = new VoiceIdService(repo as any, config as any, users as any, env as any, identity as any);
    return { svc, repo };
  }

  it('learns a voice from the turns spoken to the satellite while enrolling, then recognises it', async () => {
    const { svc, repo } = setup();
    const alex = await svc.create({ name: 'Alex', haPerson: 'person.alex' });
    await svc.create({ name: 'Sam' });
    await svc.enroll(alex.id, 'assist_satellite.living');
    for (let i = 0; i < ENROLL_SAMPLES; i++) {
      svc.remember(`questa è la frase ${i}`, Promise.resolve(at(i)));
      const r = await svc.forTurn(`Questa è la frase ${i}`, 'assist_satellite.living', 'house');
      expect(r).toMatchObject({ kind: 'enrolled', name: 'Alex', samples: i + 1, of: ENROLL_SAMPLES });
    }
    const row = repo.rows.find((r) => r.id === alex.id)!;
    expect(row.sampleCount).toBe(ENROLL_SAMPLES);
    expect(row.samples).not.toContain('0.99');   // encrypted at rest
    // Enrollment done: the next turn is recognised — on any satellite.
    svc.remember('accendi la luce', Promise.resolve(at(3)));
    expect(await svc.forTurn('accendi la luce', 'assist_satellite.kitchen', 'house')).toMatchObject({
      kind: 'speaker', speaker: { profileId: alex.id, displayName: 'Alex', holder: false, identity: { channel: 'homeassistant', externalId: 'person.alex' }, confidence: STRONG_CONFIDENCE },
    });
    expect(svc.lastRecognitions()[0]).toMatchObject({ name: 'Alex', satellite: 'assist_satellite.kitchen' });
    expect((await svc.list()).find((v) => v.id === alex.id)).not.toHaveProperty('samples');
  });

  it('while enrolling, a sentence too short or in another voice is not learned and does not count', async () => {
    const { svc, repo } = setup();
    const alex = await svc.create({ name: 'Alex' });
    const sam = await svc.create({ name: 'Sam' });
    await svc.enroll(sam.id, 'sat');
    svc.remember('questa è sam', Promise.resolve(at(90)));
    await svc.forTurn('questa è sam', 'sat', 'house');
    await svc.enroll(alex.id, 'sat');
    svc.remember('sì', Promise.resolve(at(0)));
    expect(await svc.forTurn('sì', 'sat', 'house')).toMatchObject({ kind: 'rejected', name: 'Alex', rejection: { reason: 'short' }, left: ENROLL_SAMPLES });
    svc.remember('parla ancora sam', Promise.resolve(at(88)));
    expect(await svc.forTurn('parla ancora sam', 'sat', 'house')).toMatchObject({ kind: 'rejected', rejection: { reason: 'other', name: 'Sam' } });
    svc.remember('ora parla alex', Promise.resolve(at(0)));
    expect(await svc.forTurn('ora parla alex', 'sat', 'house')).toMatchObject({ kind: 'enrolled', name: 'Alex', samples: 1 });
    expect(repo.rows.find((r) => r.id === alex.id)).toMatchObject({ sampleCount: 1 });
  });

  it('the samples of a voice scored, and a suspect one removed alone', async () => {
    const { svc, repo } = setup();
    const alex = await svc.create({ name: 'Alex' });
    const sam = await svc.create({ name: 'Sam' });
    await svc.enroll(sam.id, 'sat');
    svc.remember('questa è sam', Promise.resolve(at(90)));
    await svc.forTurn('questa è sam', 'sat', 'house');
    await svc.enroll(alex.id, 'sat');
    for (const [i, deg] of [0, 5, 10].entries()) {
      svc.remember(`frase numero ${i}`, Promise.resolve(at(deg)));
      await svc.forTurn(`frase numero ${i}`, 'sat', 'house');
    }
    // A sample taken before the checks (as old enrollments were): Sam's voice among Alex's.
    const row = repo.rows.find((r) => r.id === alex.id)!;
    await svc.cancelEnrollment(alex.id);
    (svc as any).voices = null;
    const { encrypt } = await import('../../src/custom-tools/crypto.utils');
    row.samples = encrypt(JSON.stringify([at(0), at(5), at(10), at(85)].map(normalize)));
    row.sampleCount = 4;
    const scores = await svc.sampleScores(alex.id);
    expect(scores.map((x) => x.suspect)).toEqual([false, false, false, true]);
    expect(scores[3].other?.name).toBe('Sam');
    await svc.removeSample(alex.id, 3);
    expect(repo.rows.find((r) => r.id === alex.id)).toMatchObject({ sampleCount: 3 });
    expect((await svc.sampleScores(alex.id)).every((x) => !x.suspect)).toBe(true);
    await expect(svc.removeSample(alex.id, 7)).rejects.toThrow(/Sample/);
  });

  it('unknown without a voiceprint for that text, without voices, or when it was too short', async () => {
    const { svc } = setup();
    expect(await svc.forTurn('mai sentito', 'sat', 'house')).toEqual({ kind: 'unknown' });
    svc.remember('corto', Promise.resolve(null));
    expect(await svc.forTurn('corto', 'sat', 'house')).toEqual({ kind: 'unknown' });
    svc.remember('nessuna voce', Promise.resolve(at(0)));
    expect(await svc.forTurn('nessuna voce', 'sat', 'house')).toEqual({ kind: 'unknown' });
  });

  it('forgetting a voice removes it; clearing its samples keeps the person', async () => {
    const { svc, repo } = setup();
    const v = await svc.create({ name: 'Alex' });
    await svc.enroll(v.id, 'sat');
    svc.remember('questa è una frase', Promise.resolve(at(0)));
    await svc.forTurn('questa è una frase', 'sat', 'house');
    await svc.clearSamples(v.id);
    expect(repo.rows[0]).toMatchObject({ samples: null, sampleCount: 0 });
    await svc.remove(v.id);
    expect(repo.rows).toEqual([]);
    await expect(svc.create({ name: ' ' })).rejects.toThrow(/name/);
    await expect(svc.create({ name: 'X', haPerson: 'light.kitchen' })).rejects.toThrow(/person/);
  });

  it('embed: the whisper-service voiceprint, or null when it fails', async () => {
    const { svc } = setup();
    svc.fetchImpl = vi.fn(async () => new Response(JSON.stringify({ embedding: [0.1, 0.2] }), { status: 200 })) as any;
    expect(await svc.embed(Buffer.from('RIFF'))).toEqual([0.1, 0.2]);
    expect((svc.fetchImpl as any).mock.calls[0][0]).toBe('http://localhost:9000/v1/speaker/embed');
    svc.fetchImpl = vi.fn(async () => new Response('down', { status: 503 })) as any;
    expect(await svc.embed(Buffer.from('RIFF'))).toBeNull();
    expect(await setup(false).svc.active()).toBe(false);
  });
});
