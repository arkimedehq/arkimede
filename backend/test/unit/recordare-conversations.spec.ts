// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * The end of a conversation told to Recordare (recordare-conversations.service.ts): the quiet, fully sent chats of
 * users whose memory is on are ended once (a 404 — a conversation Recordare never had — counts as done); a failure is
 * tried again next time; without Recordare nothing runs.
 */
import { describe, it, expect, vi } from 'vitest';
import { RecordareHttpError } from '@arkimedehq/recordare-client';
import { END_IDLE_MS, RecordareConversationsService } from '../../src/recordare/recordare-conversations.service';

function setup(rows: Array<{ id: string; userId: string }>) {
  const updates: any[][] = [];
  const queries: any[][] = [];
  const ds = {
    query: vi.fn(async (sql: string, params: any[]) => {
      queries.push([sql, params]);
      if (sql.startsWith('UPDATE')) { updates.push(params); return []; }
      return rows;
    }),
  };
  const client = { endConversation: vi.fn(async (_u: string, chat: string) => {
    if (chat === 'gone') throw new RecordareHttpError(404, { title: 'not found' } as any);
    if (chat === 'down') throw new Error('unreachable');
  }) };
  const svc = new RecordareConversationsService(ds as any);
  svc.client = () => client as any;
  return { svc, client, updates, queries };
}

describe('RecordareConversationsService', () => {
  it('ends the quiet chats once; a chat Recordare never had counts as ended; a failure waits for the next sweep', async () => {
    const t = setup([{ id: 'c1', userId: 'u1' }, { id: 'gone', userId: 'u1' }, { id: 'down', userId: 'u2' }]);
    const now = Date.parse('2026-11-09T12:00:00Z');
    expect(await t.svc.sweep(now)).toBe(2);
    expect(t.client.endConversation).toHaveBeenCalledWith('u1', 'c1');
    expect(t.updates.map((u) => u[0])).toEqual(['c1', 'gone']);
    // Quiet for END_IDLE_MS, memory on, nothing left in the outbox, ended before its last message (or never).
    const [sql, params] = t.queries[0];
    expect(sql).toMatch(/episodicMemoryEnabled" = true/);
    expect(sql).toMatch(/recordare_outbox/);
    expect(sql).toMatch(/"memoryEndedAt" IS NULL OR c."memoryEndedAt" < lm."last"/);
    expect(params[0]).toEqual(new Date(now - END_IDLE_MS));
  });

  it('without Recordare nothing runs', async () => {
    const t = setup([{ id: 'c1', userId: 'u1' }]);
    t.svc.client = () => null;
    expect(await t.svc.sweep()).toBe(0);
    expect(t.client.endConversation).not.toHaveBeenCalled();
  });
});
