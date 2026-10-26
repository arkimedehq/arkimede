// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Recordare D34 — the A-MEM toggle split and the copies of Recordare notes:
 *   - the tools follow the notes the user uses (personal: all three; team / org only: search_memory);
 *   - a copy is made once per place, a copy by rule never pushes the user's notes out, a team copy needs membership;
 *   - copies follow the note through the change feed (updated / corrected → new text, forgotten → removed) and the
 *     rule copies the current, confirmed notes of its categories.
 */
import { describe, it, expect, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { FindOperator } from 'typeorm';
import { UserMemoryService } from '../../src/user-memory/user-memory.service';
import { RecordareNotesSyncService } from '../../src/recordare/recordare-notes-sync.service';
import type { NoteChange } from '../../src/recordare/client';

/** An in-memory user_memory table: equality, IsNull() and Not(IsNull()) in `where`. */
function fakeRepo(rows: any[] = []) {
  let n = 0;
  const match = (r: any, where: Record<string, unknown>) => Object.entries(where).every(([k, v]) => {
    if (!(v instanceof FindOperator)) return r[k] === v;
    if (v.type === 'isNull') return r[k] == null;
    if (v.type === 'not') return r[k] != null;
    throw new Error(`operator ${v.type}`);
  });
  return {
    rows,
    find: vi.fn(async ({ where }: any) => rows.filter((r) => match(r, where))),
    findOne: vi.fn(async ({ where }: any) => rows.find((r) => match(r, where)) ?? null),
    count: vi.fn(async ({ where }: any) => rows.filter((r) => match(r, where)).length),
    create: (x: any) => ({ ...x }),
    save: vi.fn(async (x: any) => {
      if (!x.id) { x.id = `m${++n}`; rows.push(x); }
      return x;
    }),
    remove: vi.fn(async (x: any) => { rows.splice(rows.indexOf(x), 1); x.id = undefined; }),
  };
}

function makeService(rows: any[] = [], teams: string[] = []) {
  const svc: any = Object.create(UserMemoryService.prototype);
  svc.repo = fakeRepo(rows);
  svc.teams = { teamIdsForUser: vi.fn(async () => teams) };
  svc.enrichNote = vi.fn(async () => undefined);
  svc.deindexNote = vi.fn(async () => undefined);
  svc.pruneConfirmed = vi.fn(async () => undefined);
  return svc;
}

const note = (id: string, content = `note ${id}`, category = 'preference') => ({ id, content, category });
const personal = { scope: 'personal' as const, teamId: null, isAdmin: false };

describe('A-MEM tools follow the notes the user uses (D34)', () => {
  const svc: any = Object.create(UserMemoryService.prototype);
  const names = (use: { personal: boolean; shared: boolean }) => svc.buildMemoryTools('u', 'c', use).map((t: any) => t.name);

  it('personal memory: save, search and the conversation search', () => {
    expect(names({ personal: true, shared: false })).toEqual(['save_memory', 'search_memory', 'search_conversations']);
  });

  it('team / org notes alone: only search_memory; nothing used: no tools', () => {
    expect(names({ personal: false, shared: true })).toEqual(['search_memory']);
    expect(names({ personal: false, shared: false })).toEqual([]);
  });

  it('no notes used: nothing retrieved and no query run', async () => {
    const s = makeService();
    s.repo.query = vi.fn();
    expect(await s.retrieve('u', 'anything', { personal: false, shared: false })).toEqual([]);
    expect(s.repo.query).not.toHaveBeenCalled();
  });
});

describe('copying a Recordare note into A-MEM (D34)', () => {
  it('confirmed, linked to the note, once per place', async () => {
    const svc = makeService();
    const a = await svc.copyRecordareNote('u', note('r1', 'Likes bitter coffee'), personal);
    expect(a).toMatchObject({ userId: 'u', content: 'Likes bitter coffee', category: 'preference', status: 'confirmed',
      scope: 'personal', teamId: null, recordareNoteId: 'r1' });
    expect(await svc.copyRecordareNote('u', note('r1'), personal)).toBe(a);
    expect(svc.repo.rows).toHaveLength(1);
  });

  it('a team copy needs membership; the org needs an admin', async () => {
    const svc = makeService([], ['t1']);
    await expect(svc.copyRecordareNote('u', note('r1'), { scope: 'team', teamId: 't2', isAdmin: false }))
      .rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.copyRecordareNote('u', note('r1'), { scope: 'org', teamId: null, isAdmin: false }))
      .rejects.toBeInstanceOf(ForbiddenException);
    const t = await svc.copyRecordareNote('u', note('r1'), { scope: 'team', teamId: 't1', isAdmin: false });
    expect(t).toMatchObject({ scope: 'team', teamId: 't1' });
    expect(svc.pruneConfirmed).not.toHaveBeenCalled();   // only personal notes are bounded
  });

  it('a copy by rule is skipped when the personal memory is full; a copy by hand is not', async () => {
    const full = Array.from({ length: 50 }, (_, i) => ({ id: `own${i}`, userId: 'u', status: 'confirmed', scope: 'personal' }));
    const svc = makeService(full);
    expect(await svc.copyRecordareNote('u', note('r1'), personal, true)).toBeNull();
    expect(await svc.copyRecordareNote('u', note('r1'), personal)).toMatchObject({ recordareNoteId: 'r1' });
  });

  it('copies follow the note: new text and id, or removed with it', async () => {
    const svc = makeService();
    await svc.copyRecordareNote('u', note('r1', 'old'), personal);
    expect(await svc.followRecordareNote('u', 'r1', note('r2', 'new'))).toBe(1);
    expect(svc.repo.rows[0]).toMatchObject({ recordareNoteId: 'r2', content: 'new' });
    expect(await svc.followRecordareNote('u', 'r2', null)).toBe(1);
    expect(svc.repo.rows).toHaveLength(0);
    expect(svc.deindexNote).toHaveBeenCalledWith('m1');
  });
});

describe('following the notes change feed (D34)', () => {
  const change = (c: Partial<NoteChange> & Pick<NoteChange, 'noteId' | 'change'>): NoteChange => ({
    seq: 1, at: '2026-10-13T00:00:00Z', replaces: null, note: null, ...c,
  });
  const live = (id: string, extra: Record<string, unknown> = {}) => ({
    id, category: 'preference', content: `note ${id}`, pinned: false, pending: false, inferred: false, pattern: false,
    authorRole: 'holder', supportCount: 1, recordedAt: '2026-10-13T00:00:00Z', status: 'current', ...extra,
  }) as NoteChange['note'];

  function makeSync() {
    const svc = makeService();
    const sync = new RecordareNotesSyncService({} as any, svc);
    return { svc, sync };
  }

  it('the rule copies current, confirmed notes of its categories only', async () => {
    const { svc, sync } = makeSync();
    await sync.apply('u', ['preference'], change({ noteId: 'a', change: 'created', note: live('a') }));
    await sync.apply('u', ['preference'], change({ noteId: 'b', change: 'created', note: live('b', { pending: true }) }));
    await sync.apply('u', ['preference'], change({ noteId: 'c', change: 'created', note: live('c', { category: 'habit' }) }));
    await sync.apply('u', ['preference'], change({ noteId: 'b', change: 'confirmed', note: live('b') }));
    expect(svc.repo.rows.map((r: any) => r.recordareNoteId)).toEqual(['a', 'b']);
  });

  it('a correction moves the copy on, even through a replaced step; forgetting removes it', async () => {
    const { svc, sync } = makeSync();
    await svc.copyRecordareNote('u', note('a', 'first'), personal);
    // b replaced a, then c corrected b: replaying the feed, b is no longer current but the copy still follows it.
    await sync.apply('u', [], change({ noteId: 'b', change: 'updated', replaces: 'a', note: live('b', { content: 'second', status: 'corrected' }) }));
    await sync.apply('u', [], change({ noteId: 'c', change: 'corrected', replaces: 'b', note: live('c', { content: 'third' }) }));
    expect(svc.repo.rows).toEqual([expect.objectContaining({ recordareNoteId: 'c', content: 'third' })]);
    await sync.apply('u', [], change({ noteId: 'c', change: 'forgotten' }));
    expect(svc.repo.rows).toEqual([]);
  });

  it('a copy that the rule also wants is not made twice', async () => {
    const { svc, sync } = makeSync();
    await svc.copyRecordareNote('u', note('a'), personal);
    await sync.apply('u', ['preference'], change({ noteId: 'b', change: 'updated', replaces: 'a', note: live('b') }));
    expect(svc.repo.rows.map((r: any) => r.recordareNoteId)).toEqual(['b']);
  });
});
