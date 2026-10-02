// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import type { UserMemory } from './user-memory.entity';

/** Vector collection of confirmed memory notes. */
export const MEMORY_COLLECTION = 'user_memory';

/**
 * Text embedded for a memory note. Single source for every writer (indexing, evolution,
 * re-embed) so that all vectors of the collection are computed the same way.
 */
export function memoryIndexText(note: Pick<UserMemory, 'content' | 'context' | 'keywords'>): string {
  return [note.content, note.context ?? '', (note.keywords ?? []).join(' ')].join('\n').trim();
}

/**
 * Vector payload of a memory note. `scope` and `teamId` are required by the scoped
 * retrieval filters (personal / team / org): a payload without them makes team and org
 * notes invisible to vector search.
 */
export function memoryVectorPayload(
  note: Pick<UserMemory, 'id' | 'userId' | 'tags' | 'category' | 'scope' | 'teamId'>,
): Record<string, unknown> {
  return {
    userId: note.userId, memoryId: note.id, tags: note.tags ?? [],
    category: note.category ?? null, scope: note.scope ?? 'personal', teamId: note.teamId ?? null,
  };
}
