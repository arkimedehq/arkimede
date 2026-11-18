// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import api from './client';

export interface VoiceProfileView {
  id: string;
  name: string;
  haPerson: string | null;
  userId: string | null;
  sampleCount: number;
  enrolling: { satellite: string; left: number } | null;
}

export interface VoiceRecognition {
  at: string;
  satellite: string | null;
  name: string | null;
  score: number | null;
  second: number | null;
  confidence: number | null;
}

/** Sensitive actions by voice only for a recognised voice (backend voice-id/voice-clearance.ts). */
export interface VoiceClearancePolicy {
  enabled: boolean;
  /** Lowest voice similarity score (0–1) that clears a protected action. */
  minScore: number;
  /** Voice profile ids allowed; empty = any recognised voice. */
  people: string[];
  /** Protected tool names (`*` allowed). */
  tools: string[];
  /** Protected entities, by id or domain (`*` allowed). */
  entities: string[];
  /** Also what the integration deems sensitive (locks, alarms, garage doors, gates). */
  sensitiveTargets: boolean;
}

export interface VoiceIdState {
  enabled: boolean;
  voices: VoiceProfileView[];
  recognitions: VoiceRecognition[];
  clearance: VoiceClearancePolicy;
}

export interface VoiceSampleScore {
  /** Against the voice's other samples (null: the only one). */
  own: number | null;
  other: { name: string; score: number } | null;
  suspect: boolean;
}

export interface VoicePayload {
  name?: string;
  haPerson?: string | null;
  userId?: string | null;
}

export const voiceIdApi = {
  get: () => api.get<VoiceIdState>('/admin/voice-id').then((r) => r.data),
  setEnabled: (enabled: boolean) => api.put<VoiceIdState>('/admin/voice-id/enabled', { enabled }).then((r) => r.data),
  setClearance: (p: Partial<VoiceClearancePolicy>) => api.put<VoiceIdState>('/admin/voice-id/clearance', p).then((r) => r.data),
  create: (p: VoicePayload) => api.post('/admin/voice-id/voices', p).then((r) => r.data),
  update: (id: string, p: VoicePayload) => api.patch(`/admin/voice-id/voices/${id}`, p).then((r) => r.data),
  remove: (id: string) => api.delete(`/admin/voice-id/voices/${id}`),
  clearSamples: (id: string) => api.delete(`/admin/voice-id/voices/${id}/samples`),
  samples: (id: string) => api.get<VoiceSampleScore[]>(`/admin/voice-id/voices/${id}/samples`).then((r) => r.data),
  removeSample: (id: string, index: number) => api.delete(`/admin/voice-id/voices/${id}/samples/${index}`),
  enroll: (id: string, satellite: string) => api.post(`/admin/voice-id/voices/${id}/enroll`, { satellite }).then((r) => r.data),
  cancelEnroll: (id: string) => api.delete(`/admin/voice-id/voices/${id}/enroll`),
};
