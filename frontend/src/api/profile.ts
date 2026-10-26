// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import api from './client';
import type { ToolLoadingStrategy, ToolSchemaFormat } from './appConfig';

export interface UserProfile {
  id:           string;
  email:        string;
  name:         string;
  role:         string;
  systemPrompt: string | null;
  /** Interface/response language ('it' | 'en'); null = auto-detect from browser. */
  language:     string | null;
  /** null = use the global default configured by the admin */
  toolLoadingStrategy: ToolLoadingStrategy | null;
  toolLoadingMaxTools: number | null;
  toolSchemaFormat:    ToolSchemaFormat | null;
  /** Shows the input/output token count under each assistant response. */
  showTokenCount: boolean;
  /** Conversation history token limit; null = use the admin's global default. */
  maxHistoryTokens: number | null;
  /** Persistent user memory: automatic extraction of durable facts. */
  autoMemoryEnabled: boolean;
  /** Use the team and organisation notes, apart from the personal memory (Recordare D34). */
  sharedMemoryEnabled: boolean;
  /** Memory extraction threshold override (n. messages); null = global default. */
  memoryThreshold: number | null;
  /** Episodic memory in Recordare (separate from autoMemoryEnabled). */
  episodicMemoryEnabled: boolean;
  /** The copy rule: Recordare notes of these categories are copied into the personal memory (D34). */
  recordareCopyCategories?: string[];
  /** True when Recordare is configured on this installation. */
  episodicMemoryAvailable?: boolean;
  /** off | active | unknown (Recordare unreachable). */
  episodicMemoryStatus?: 'off' | 'active' | 'unknown';
  /**
   * Recordare memory mode: personal (what you say becomes the agent's own memory, first person) or entity (a shared
   * agent: unidentified speakers are "someone"); null = not known yet.
   */
  episodicMemoryMode?: MemoryMode | null;
  /** Grammatical gender (also the first person of the memory); null = not set (masculine). */
  gender?: UserGender | null;
  /** Recordare Atlas address (admins only, when installed). */
  recordareAtlasUrl?: string | null;
  createdAt:    string;
  updatedAt:    string;
}

/** Recordare memory mode (its D50). */
export type MemoryMode = 'personal' | 'entity';
/** Grammatical gender: masculine (default) | feminine | neutral. */
export type UserGender = 'masculine' | 'feminine' | 'neutral';

export const profileApi = {
  get: (): Promise<UserProfile> =>
    api.get('/users/me').then((r) => r.data),

  update: (data: {
    name?: string;
    email?: string;
    systemPrompt?: string | null;
    language?: string | null;
    toolLoadingStrategy?: ToolLoadingStrategy | null;
    toolLoadingMaxTools?: number | null;
    toolSchemaFormat?: ToolSchemaFormat | null;
    showTokenCount?: boolean;
    maxHistoryTokens?: number | null;
    autoMemoryEnabled?: boolean;
    sharedMemoryEnabled?: boolean;
    memoryThreshold?: number | null;
    episodicMemoryEnabled?: boolean;
    episodicMemoryMode?: MemoryMode;
    gender?: UserGender | null;
    recordareCopyCategories?: string[];
  }): Promise<UserProfile> =>
    api.patch('/users/me', data).then((r) => r.data),

  changePassword: (currentPassword: string, newPassword: string): Promise<void> =>
    api.post('/users/me/change-password', { currentPassword, newPassword }).then(() => undefined),
};
