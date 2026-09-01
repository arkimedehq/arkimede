// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Unit — SkillsService.installOrUpdateFromZip: the registry install endpoint
 * must create when the user does not own a skill with the manifest name, and
 * update in place (preserving config vars) when they do.
 */
import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillsService } from '../../src/skills/skills.service';

const ZIP = Buffer.from('fake-zip');
const configStub = { get: (_k: string, d?: any) => d ?? join(tmpdir(), 'pa-skills-unit') } as any;

function mkService(existing: { id: string } | null) {
  const skillRepo = { findOne: vi.fn().mockResolvedValue(existing) } as any;
  const svc = new SkillsService(
    skillRepo, {} as any, {} as any, {} as any, {} as any,
    configStub, {} as any, {} as any,
  );
  vi.spyOn(svc as any, 'parseAndValidateZip').mockReturnValue({ manifest: { name: 'demo-skill' }, entries: [] });
  const create = vi.spyOn(svc, 'uploadAndCreate').mockResolvedValue({ id: 'created' } as any);
  const update = vi.spyOn(svc, 'updateFromZip').mockResolvedValue({ id: 'updated' } as any);
  return { svc, skillRepo, create, update };
}

describe('SkillsService.installOrUpdateFromZip', () => {
  it('creates when the user does not own a skill with that name', async () => {
    const { svc, skillRepo, create, update } = mkService(null);

    const res = await svc.installOrUpdateFromZip('user-1', ZIP);

    expect(skillRepo.findOne).toHaveBeenCalledWith({ where: { ownerId: 'user-1', name: 'demo-skill' } });
    expect(create).toHaveBeenCalledWith('user-1', ZIP);
    expect(update).not.toHaveBeenCalled();
    expect(res).toEqual({ skill: { id: 'created' }, updated: false });
  });

  it('updates in place when the user already owns a skill with that name', async () => {
    const { svc, create, update } = mkService({ id: 'skill-9' });

    const res = await svc.installOrUpdateFromZip('user-1', ZIP);

    expect(update).toHaveBeenCalledWith('skill-9', 'user-1', ZIP);
    expect(create).not.toHaveBeenCalled();
    expect(res).toEqual({ skill: { id: 'updated' }, updated: true });
  });
});
