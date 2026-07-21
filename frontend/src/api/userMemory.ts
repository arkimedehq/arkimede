import api from './client';

export type UserMemoryStatus = 'pending' | 'confirmed';

export interface UserMemoryItem {
  id:           string;
  content:      string;
  status:       UserMemoryStatus;
  sourceChatId: string | null;
  /** A-MEM structured-note metadata (F1) — empty/null if generation failed. */
  tags:         string[];
  keywords:     string[];
  context:      string | null;
  category:     string | null;
  linkedIds:    string[];
  pinned:       boolean;
  /** Non-empty ⇒ pending MERGE proposal: confirming replaces those notes (F3). */
  mergeOfIds:   string[];
  /** Visibility (F4): personal | team | org. */
  scope:        'personal' | 'team' | 'org';
  teamId:       string | null;
  userId:       string;
  createdAt:    string;
  updatedAt:    string;
}

/** Proposal returned by the extraction (pending fact to confirm). */
export interface MemoryProposal {
  id:      string;
  content: string;
}

export const userMemoryApi = {
  /** All facts (confirmed + pending). */
  list: (): Promise<UserMemoryItem[]> =>
    api.get('/user-memory').then((r) => r.data),

  /** On-demand extraction from the indicated chat → pending proposals. */
  extract: (chatId: string): Promise<{ proposals: MemoryProposal[] }> =>
    api.post('/user-memory/extract', { chatId }).then((r) => r.data),

  /** Confirms the indicated pending facts. */
  confirm: (ids: string[]): Promise<void> =>
    api.post('/user-memory/confirm', { ids }).then(() => undefined),

  /** Adds a manual fact (already confirmed). */
  setScope: (id: string, scope: 'personal' | 'team' | 'org', teamId: string | null): Promise<UserMemoryItem> =>
    api.patch(`/user-memory/${id}/scope`, { scope, teamId }).then((r) => r.data),

  setPinned: (id: string, pinned: boolean): Promise<UserMemoryItem> =>
    api.patch(`/user-memory/${id}/pinned`, { pinned }).then((r) => r.data),

  reindex: (): Promise<{ enriched: number; indexed: number }> =>
    api.post('/user-memory/reindex').then((r) => r.data),

  add: (content: string): Promise<UserMemoryItem> =>
    api.post('/user-memory', { content }).then((r) => r.data),

  /** Edits the text of a fact. */
  update: (id: string, content: string): Promise<UserMemoryItem> =>
    api.patch(`/user-memory/${id}`, { content }).then((r) => r.data),

  /** Deletes a fact (reject pending or delete confirmed). */
  remove: (id: string): Promise<void> =>
    api.delete(`/user-memory/${id}`).then(() => undefined),
};
