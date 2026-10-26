// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/** The user's Diary: what Recordare remembers about them (backend proxy /api/recordare/diary). */
import api from './client';

export type PlanStatus = 'open' | 'confirmed' | 'cancelled' | 'rescheduled' | 'unresolved';

export interface DiaryEpisode {
  id: string;
  kind: 'event' | 'plan' | 'state_change';
  content: string;
  occurredAt: string | null;
  occurredUntil: string | null;
  datePrecision: string;
  place: string | null;
  planStatus?: PlanStatus;
  importance: number;
  feelings: string[];
  opinion: string | null;
  people: string[];
  authorRole: string;
  inferred: boolean;
  corrected: boolean;
  recordedAt: string;
}

export interface DiaryEpisodeDetail extends DiaryEpisode {
  evidence: Array<{ conversation?: string; role: string; author?: string | null; sentAt: string; text?: string; otherClient?: true }>;
  history: Array<{ id: string; content: string; occurredAt: string | null; recordedAt: string }>;
  confirmedBy?: DiaryEpisode | null;
  rescheduledTo?: DiaryEpisode | null;
}

export interface DiaryDigest { id: string; level: 'day' | 'month'; periodStart: string; periodEnd: string; content: string }

export interface DiaryFact {
  id: string;
  about?: string;
  key: string;
  value: string | null;
  status: string;
  validFrom: string | null;
  pending: boolean;
  inferred: boolean;
  history: Array<{ id: string; value: string | null; from: string | null; to: string | null; status: string }>;
}

export interface DiaryNote {
  id: string;
  category: string;
  content: string;
  pinned: boolean;
  pending: boolean;
  inferred: boolean;
  /** A recurring pattern the memory drew from its episodes. */
  pattern?: boolean;
  authorRole: string;
}

/** Where a Recordare note was copied in the persistent memory (A-MEM, D34). */
export interface DiaryCopy { recordareNoteId: string; scope: 'personal' | 'team' | 'org'; teamId: string | null }

/** The categories of Recordare's notes (the copy rule). */
export const NOTE_CATEGORIES = ['preference', 'habit', 'value', 'relationship', 'knowledge', 'profile', 'constraint'] as const;

const base = '/recordare/diary';

export const diaryApi = {
  episodes: (params: { q?: string; cursor?: string; limit?: number }): Promise<{ items: DiaryEpisode[]; nextCursor: string | null }> =>
    api.get(`${base}/episodes`, { params }).then((r) => r.data),
  episode: (id: string): Promise<DiaryEpisodeDetail> => api.get(`${base}/episodes/${id}`).then((r) => r.data),
  correct: (id: string, fix: { content?: string; occurredAt?: string }): Promise<{ id: string }> =>
    api.post(`${base}/episodes/${id}/corrections`, fix).then((r) => r.data),
  forget: (id: string): Promise<void> => api.delete(`${base}/episodes/${id}`).then(() => undefined),
  digests: (): Promise<DiaryDigest[]> => api.get(`${base}/digests`).then((r) => r.data),
  facts: (includePending = false): Promise<DiaryFact[]> => api.get(`${base}/facts`, { params: { includePending } }).then((r) => r.data),
  notes: (includePending = false): Promise<DiaryNote[]> => api.get(`${base}/notes`, { params: { includePending } }).then((r) => r.data),
  plans: (): Promise<DiaryEpisode[]> => api.get(`${base}/plans`).then((r) => r.data),
  copies: (): Promise<DiaryCopy[]> => api.get(`${base}/copies`).then((r) => r.data),
  /** Copies a note into the persistent memory (A-MEM): personal, a team, or the org (admins). */
  copy: (id: string, scope: DiaryCopy['scope'], teamId: string | null): Promise<void> =>
    api.post(`${base}/notes/${id}/copy`, { scope, teamId }).then(() => undefined),
  pin: (id: string, pinned: boolean): Promise<void> => api.patch(`${base}/notes/${id}`, { pinned }).then(() => undefined),
  remove: (what: 'notes' | 'facts', id: string): Promise<void> => api.delete(`${base}/${what}/${id}`).then(() => undefined),
  decide: (what: 'notes' | 'facts', id: string, decision: 'confirm' | 'reject'): Promise<void> =>
    api.post(`${base}/${what}/${id}/${decision}`).then(() => undefined),
};
