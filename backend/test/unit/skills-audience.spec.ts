// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Unit — personal and shared skills (specs/EXTENSION_AUDIENCE.md): `runtime.audience` is read from SKILL.md (undeclared
 * = shared); a personal skill is never shared with a team or the organization, nor approved; only an admin shares one.
 */
import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { SkillsService, parseSkillMd } from '../../src/skills/skills.service';

const configStub = { get: (_k: string, d?: any) => d ?? join(tmpdir(), 'pa-skills-unit') } as any;

function mkService(skill: Record<string, unknown>) {
  const skillRepo = { findOne: vi.fn().mockResolvedValue(skill), save: vi.fn(async (x: any) => x) } as any;
  const svc = new SkillsService(skillRepo, {} as any, {} as any, {} as any, {} as any, configStub, {} as any, {} as any);
  vi.spyOn(svc as any, 'findOwned').mockResolvedValue(skill);
  return { svc, skillRepo };
}

describe('skills: audience', () => {
  it('reads runtime.audience from SKILL.md; undeclared is undefined (shared)', () => {
    const md = (runtime: string) => `---\nname: demo\ndescription: d\nruntime:\n  type: python\n${runtime}---\nbody\n`;
    expect(parseSkillMd(md('  audience: personal\n')).manifest.audience).toBe('personal');
    expect(parseSkillMd(md('  audience: shared\n')).manifest.audience).toBe('shared');
    expect(parseSkillMd(md('')).manifest.audience).toBeUndefined();
    expect(parseSkillMd(md('  audience: everyone\n')).manifest.audience).toBeUndefined();
  });

  it('a personal skill stays personal, even for an admin; a shared one is shared only by an admin', async () => {
    const personal = mkService({ id: 's1', scope: 'personal', teamId: null, audience: 'personal' });
    await expect(personal.svc.update('s1', 'u1', { scope: 'org' }, true)).rejects.toBeInstanceOf(BadRequestException);
    await expect(personal.svc.update('s1', 'u1', { scope: 'team', teamId: 't1' }, true)).rejects.toBeInstanceOf(BadRequestException);

    const shared = mkService({ id: 's2', scope: 'personal', teamId: null, audience: 'shared' });
    await expect(shared.svc.update('s2', 'u1', { scope: 'team', teamId: 't1' }, false)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a personal skill is never approved for the organization', async () => {
    const { svc } = mkService({ id: 's1', scope: 'org', audience: 'personal', scripts: [] });
    await expect(svc.approve('s1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('an update that makes a shared copy personal is refused (the admin makes the copy personal first)', async () => {
    const { svc } = mkService({ id: 's3', name: 'demo', scope: 'org', audience: 'shared', status: 'ready' });
    vi.spyOn(svc as any, 'parseAndValidateZip').mockReturnValue({ manifest: { name: 'demo', description: 'd', audience: 'personal' }, entries: [] });
    vi.spyOn(svc as any, 'validateSkillYaml').mockReturnValue(undefined);
    const extract = vi.spyOn(svc as any, 'extractZipToVolume').mockReturnValue(undefined);
    await expect(svc.updateFromZip('s3', 'u1', Buffer.from('zip'))).rejects.toBeInstanceOf(BadRequestException);
    expect(extract).not.toHaveBeenCalled();
  });
});
