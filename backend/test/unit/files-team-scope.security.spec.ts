// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Sharing a file with a team names a team the user belongs to: without one nobody else could open it (the access check
 * needs the teamId), so "team" would silently stay personal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { FilesService } from '../../src/files/files.service';

describe('file sharing with a team', () => {
  let saved: any[];
  let svc: FilesService;

  beforeEach(() => {
    saved = [];
    const dir = mkdtempSync(path.join(tmpdir(), 'files-team-'));
    const file = { id: 'f1', userId: 'u1', scope: 'personal', teamId: null, originalName: 'a.pdf' };
    const repo = {
      findOne: vi.fn(async () => ({ ...file })),
      save: vi.fn(async (f: any) => { saved.push(f); return f; }),
    };
    const cfg = { get: (k: string, d?: string) => (k === 'UPLOAD_DIR' ? dir : d) };
    const teams = { teamIdsForUser: vi.fn(async (u: string) => (u === 'u1' ? ['t1'] : [])) };
    svc = new FilesService(repo as any, {} as any, cfg as any, {} as any, teams as any, null);
  });

  it('a team of mine: shared', async () => {
    await svc.setScope('f1', 'u1', 'team', 't1', false);
    expect(saved).toEqual([expect.objectContaining({ scope: 'team', teamId: 't1' })]);
  });

  it('no team: refused, nothing saved', async () => {
    await expect(svc.setScope('f1', 'u1', 'team', null, false)).rejects.toBeInstanceOf(BadRequestException);
    expect(saved).toEqual([]);
  });

  it('a team I am not in: refused; an admin may choose any team', async () => {
    await expect(svc.setScope('f1', 'u1', 'team', 't9', false)).rejects.toBeInstanceOf(ForbiddenException);
    await svc.setScope('f1', 'admin', 'team', 't9', true);
    expect(saved).toEqual([expect.objectContaining({ scope: 'team', teamId: 't9' })]);
  });

  it('personal and org need no team (and drop the one there was)', async () => {
    await svc.setScope('f1', 'u1', 'org', 't1', false);
    expect(saved).toEqual([expect.objectContaining({ scope: 'org', teamId: null })]);
  });
});
