// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file voice-id.service.ts
 *
 * Who spoke to a satellite (opt-in, admin settings: app_config.voiceIdEnabled). The voice account is one many people
 * talk to: the house knows their voices (voice_profiles — a person, optionally a Home Assistant person and an Arkimede
 * user), learned from what they say to a satellite.
 *
 * The Wyoming server hands over each turn's audio (`embed`, alongside the transcription: no added wait) and its text
 * (`remember`); when the hub sends that text to the conversation, `forTurn` finds the voiceprint again by the text and
 * either learns it (a voice being enrolled on that satellite) or recognises it (voice-match.ts). The voiceprints come
 * from whisper-service (`/v1/speaker/embed`); no audio is kept, the samples are encrypted at rest. Off, nothing is
 * computed and every turn goes as before.
 */
import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { VoiceProfile } from './voice-profile.entity';
import { AppConfigEntity } from '../app-config/app-config.entity';
import { User } from '../users/users.entity';
import { RecordareIdentityService } from '../recordare/recordare-identity.service';
import { decrypt, encrypt } from '../custom-tools/crypto.utils';
import {
  MAX_SAMPLES, centroid, checkSample, matchVoice, normalize, scoreSamples, speakerIdentity, turnKey,
  type SampleRejection, type SampleScore, type SpeakerIdentity,
} from './voice-match';

const CONFIG_ID = 1;
/** A turn's voiceprint waits this long for the hub to hand its text to the conversation. */
const RECENT_MS = 60_000;
const SETTINGS_TTL_MS = 30_000;
const EMBED_TIMEOUT_MS = 10_000;
/** Samples an enrollment takes, and how long it waits for them. */
export const ENROLL_SAMPLES = 5;
const ENROLL_TTL_MS = 10 * 60_000;
const RECOGNITIONS_KEPT = 20;

export interface RecognisedSpeaker extends SpeakerIdentity {
  profileId: string;
  /** The Arkimede user this voice is (their own memory may want the turn: users.sharedTurnsInMyMemory). */
  userId: string | null;
  confidence: number;
  score: number;
}

export type VoiceTurnResult =
  | { kind: 'enrolled'; profileId: string; name: string; samples: number; of: number }
  /** A sentence said while the voice is learned, not taken: too short, or not that voice. */
  | { kind: 'rejected'; profileId: string; name: string; rejection: SampleRejection; left: number }
  | { kind: 'speaker'; speaker: RecognisedSpeaker }
  | { kind: 'unknown' };

export interface Recognition {
  at: string;
  satellite: string | null;
  name: string | null;
  score: number | null;
  second: number | null;
  confidence: number | null;
}

@Injectable()
export class VoiceIdService {
  private readonly logger = new Logger(VoiceIdService.name);
  private settings: { on: boolean; at: number } | null = null;
  private voices: Array<{ profile: VoiceProfile; centroid: number[] | null }> | null = null;
  private readonly recent = new Map<string, { embedding: Promise<number[] | null>; at: number }>();
  private readonly enrolling = new Map<string, { profileId: string; left: number; until: number }>();
  private readonly recognitions: Recognition[] = [];
  /** The voiceprint call (tests give a fake). */
  fetchImpl: typeof fetch = (input, init) => fetch(input, init);

  constructor(
    @InjectRepository(VoiceProfile) private readonly repo: Repository<VoiceProfile>,
    @InjectRepository(AppConfigEntity) private readonly configRepo: Repository<AppConfigEntity>,
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly env: ConfigService,
    @Optional() private readonly identity?: RecordareIdentityService,
  ) {}

  // ── Settings ─────────────────────────────────────────────────────────────

  async enabled(now = Date.now()): Promise<boolean> {
    if (this.settings && now - this.settings.at < SETTINGS_TTL_MS) return this.settings.on;
    const row = await this.configRepo.findOne({ where: { id: CONFIG_ID }, select: { id: true, voiceIdEnabled: true } });
    this.settings = { on: !!row?.voiceIdEnabled, at: now };
    return this.settings.on;
  }

  async setEnabled(on: boolean): Promise<void> {
    await this.configRepo.update(CONFIG_ID, { voiceIdEnabled: on });
    this.settings = { on, at: Date.now() };
    if (!on) {
      this.recent.clear();
      this.enrolling.clear();
    }
  }

  // ── Profiles ─────────────────────────────────────────────────────────────

  async list(): Promise<Array<Omit<VoiceProfile, 'samples'> & { enrolling: { satellite: string; left: number } | null }>> {
    const rows = await this.repo.find({ order: { name: 'ASC' } });
    return rows.map(({ samples: _s, ...p }) => {
      const e = [...this.enrolling].find(([, v]) => v.profileId === p.id && v.until > Date.now());
      return { ...p, enrolling: e ? { satellite: e[0], left: e[1].left } : null };
    });
  }

  async create(data: { name: string; haPerson?: string | null; userId?: string | null }): Promise<VoiceProfile> {
    const row = await this.repo.save(this.repo.create({ ...(await this.clean(data)), samples: null, sampleCount: 0 }));
    this.voices = null;
    return row;
  }

  async update(id: string, data: { name?: string; haPerson?: string | null; userId?: string | null }): Promise<VoiceProfile> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Voice not found');
    Object.assign(row, await this.clean({ name: data.name ?? row.name, haPerson: data.haPerson, userId: data.userId }, row));
    const saved = await this.repo.save(row);
    this.voices = null;
    return saved;
  }

  /** Forgets a voice: its samples go with it. */
  async remove(id: string): Promise<void> {
    await this.repo.delete({ id });
    for (const [sat, e] of this.enrolling) if (e.profileId === id) this.enrolling.delete(sat);
    this.voices = null;
  }

  /** Each sample of a voice scored against its other samples and the other voices (the suspect ones to remove). */
  async sampleScores(id: string): Promise<SampleScore[]> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Voice not found');
    const others = (await this.loadVoices()).filter((v) => v.profile.id !== id && v.centroid).map((v) => ({ name: v.profile.name, centroid: v.centroid! }));
    return scoreSamples(this.samplesOf(row), others).map((r) => ({
      own: r.own === null ? null : round(r.own), other: r.other && { name: r.other.name, score: round(r.other.score) }, suspect: r.suspect,
    }));
  }

  /** Forgets one sample (its position, oldest first, as sampleScores lists them). */
  async removeSample(id: string, index: number): Promise<void> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Voice not found');
    const samples = this.samplesOf(row);
    if (!Number.isInteger(index) || index < 0 || index >= samples.length) throw new NotFoundException('Sample not found');
    samples.splice(index, 1);
    await this.repo.update(id, { samples: samples.length ? encrypt(JSON.stringify(samples)) : null, sampleCount: samples.length });
    this.voices = null;
  }

  /** Forgets the samples, keeps the person (to learn the voice again). */
  async clearSamples(id: string): Promise<void> {
    await this.repo.update(id, { samples: null, sampleCount: 0 });
    this.voices = null;
  }

  private async clean(data: { name?: string; haPerson?: string | null; userId?: string | null }, row?: VoiceProfile) {
    const name = (data.name ?? '').trim().slice(0, 100);
    if (!name) throw new BadRequestException('A name is required');
    const haPerson = data.haPerson === undefined ? row?.haPerson ?? null : data.haPerson?.trim() || null;
    if (haPerson && !/^person\.[a-z0-9_]+$/.test(haPerson)) throw new BadRequestException('haPerson must be a Home Assistant person (person.x)');
    const userId = data.userId === undefined ? row?.userId ?? null : data.userId || null;
    if (userId && !(await this.users.exists({ where: { id: userId } }))) throw new BadRequestException('User not found');
    return { name, haPerson, userId };
  }

  // ── Enrollment ───────────────────────────────────────────────────────────

  /** The next ENROLL_SAMPLES turns spoken to `satellite` (within ten minutes) are this voice's samples. */
  async enroll(id: string, satellite: string): Promise<{ satellite: string; left: number }> {
    if (!(await this.repo.exists({ where: { id } }))) throw new NotFoundException('Voice not found');
    const sat = satellite.trim();
    if (!sat) throw new BadRequestException('Choose a satellite');
    this.enrolling.set(sat, { profileId: id, left: ENROLL_SAMPLES, until: Date.now() + ENROLL_TTL_MS });
    return { satellite: sat, left: ENROLL_SAMPLES };
  }

  cancelEnrollment(id: string): void {
    for (const [sat, e] of this.enrolling) if (e.profileId === id) this.enrolling.delete(sat);
  }

  // ── Turns ────────────────────────────────────────────────────────────────

  /** Whether turns should be voiceprinted now (the switch on). */
  async active(): Promise<boolean> {
    return this.enabled();
  }

  /** A turn's voiceprint from its audio (a WAV), or null (too short, the service down: the turn goes on without). */
  async embed(wav: Buffer): Promise<number[] | null> {
    const base = this.env.get<string>('TRANSCRIPTION_BASE_URL', 'http://localhost:9000/v1').replace(/\/$/, '');
    try {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'turn.wav');
      const res = await this.fetchImpl(`${base}/speaker/embed`, { method: 'POST', body: form, signal: AbortSignal.timeout(EMBED_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { embedding?: number[] | null };
      return Array.isArray(body.embedding) && body.embedding.length ? body.embedding : null;
    } catch (err) {
      this.logger.warn(`voiceprint failed: ${(err as Error).message}`);
      return null;
    }
  }

  /** Keeps a turn's voiceprint under its text until the conversation asks for it. */
  remember(text: string, embedding: Promise<number[] | null>, now = Date.now()): void {
    for (const [k, v] of this.recent) if (now - v.at > RECENT_MS) this.recent.delete(k);
    const key = turnKey(text);
    if (key) this.recent.set(key, { embedding, at: now });
  }

  /**
   * The conversation turn `text` from `satellite`, for the memory of `memoryUserId`: its voiceprint is learned (a
   * voice being enrolled there) or recognised. Unknown when there is none or nobody matches.
   */
  async forTurn(text: string, satellite: string | null, memoryUserId: string, now = Date.now()): Promise<VoiceTurnResult> {
    const key = turnKey(text);
    const entry = this.recent.get(key);
    if (!entry || now - entry.at > RECENT_MS) return { kind: 'unknown' };
    this.recent.delete(key);
    const embedding = await entry.embedding;
    if (!embedding) return { kind: 'unknown' };

    const enrolling = satellite ? this.enrolling.get(satellite) : undefined;
    if (satellite && enrolling) {
      if (enrolling.until < now) {
        this.enrolling.delete(satellite);
      } else {
        const row = await this.repo.findOne({ where: { id: enrolling.profileId } });
        const others = row ? (await this.loadVoices()).filter((v) => v.profile.id !== row.id && v.centroid).map((v) => ({ name: v.profile.name, centroid: v.centroid! })) : [];
        const rejection = row ? checkSample(text, embedding, this.samplesOf(row), others) : null;
        if (row && rejection) {
          this.logger.log(`voice ${row.name}: sentence not learned (${rejection.reason}${'score' in rejection ? ` ${round(rejection.score)}` : ''}${'name' in rejection ? `, ${rejection.name}` : ''})`);
          return { kind: 'rejected', profileId: row.id, name: row.name, rejection, left: enrolling.left };
        }
        const saved = row ? await this.addSample(row.id, embedding) : null;
        if (saved) {
          enrolling.left -= 1;
          if (enrolling.left <= 0) this.enrolling.delete(satellite);
          return { kind: 'enrolled', profileId: saved.id, name: saved.name, samples: ENROLL_SAMPLES - Math.max(enrolling.left, 0), of: ENROLL_SAMPLES };
        }
        this.enrolling.delete(satellite);
      }
    }

    const voices = await this.loadVoices();
    const { match, best } = matchVoice(voices.flatMap((v) => (v.centroid ? [{ id: v.profile.id, centroid: v.centroid }] : [])), embedding);
    const profile = match ? voices.find((v) => v.profile.id === match.id)!.profile : null;
    this.note({
      at: new Date(now).toISOString(), satellite, name: profile?.name ?? null,
      score: best ? round(best.score) : null, second: best ? round(best.second) : null, confidence: match?.confidence ?? null,
    });
    if (!match || !profile) return { kind: 'unknown' };
    this.identity?.cachedMemoryId(memoryUserId); // starts a lookup of the memory's mode when it is not known yet
    const mode = (this.identity?.details(memoryUserId).mode ?? null) as 'personal' | 'entity' | null;
    return {
      kind: 'speaker',
      speaker: { ...speakerIdentity(profile, { userId: memoryUserId, mode }), profileId: profile.id, userId: profile.userId ?? null, confidence: match.confidence, score: round(match.score) },
    };
  }

  /** The latest recognitions (the scores, to calibrate). */
  lastRecognitions(): Recognition[] {
    return [...this.recognitions].reverse();
  }

  private note(r: Recognition): void {
    this.recognitions.push(r);
    if (this.recognitions.length > RECOGNITIONS_KEPT) this.recognitions.shift();
    this.logger.log(`voice on ${r.satellite ?? '-'}: ${r.name ?? 'unknown'} (score ${r.score ?? '-'}, next ${r.second ?? '-'})`);
  }

  private async addSample(id: string, embedding: number[]): Promise<VoiceProfile | null> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) return null;
    const samples = [...this.samplesOf(row), normalize(embedding)].slice(-MAX_SAMPLES);
    row.samples = encrypt(JSON.stringify(samples));
    row.sampleCount = samples.length;
    const saved = await this.repo.save(row);
    this.voices = null;
    this.logger.log(`voice ${row.name}: sample ${samples.length} learned`);
    return saved;
  }

  private samplesOf(row: VoiceProfile): number[][] {
    if (!row.samples) return [];
    try {
      const list = JSON.parse(decrypt(row.samples));
      return Array.isArray(list) ? list.filter((s) => Array.isArray(s)) : [];
    } catch {
      this.logger.warn(`voice ${row.name}: samples could not be read`);
      return [];
    }
  }

  private async loadVoices(): Promise<Array<{ profile: VoiceProfile; centroid: number[] | null }>> {
    if (!this.voices) {
      const rows = await this.repo.find();
      this.voices = rows.map((profile) => ({ profile, centroid: centroid(this.samplesOf(profile)) }));
    }
    return this.voices;
  }
}

const round = (x: number) => Math.round(x * 1000) / 1000;
