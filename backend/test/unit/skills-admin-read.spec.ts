// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Unit — an admin reads every user's skills (the list of all, and any skill's detail) to set their network or help;
 * a user still reads only their own and the shared approved ones. The egress allowlist adds the active plugins' hosts.
 */
import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NotFoundException } from '@nestjs/common';
import { SkillsService } from '../../src/skills/skills.service';

const configStub = { get: (_k: string, d?: any) => d ?? join(tmpdir(), 'pa-skills-unit') } as any;

function mkService(rows: Array<Record<string, unknown>>) {
  const matches = (row: Record<string, unknown>, w: Record<string, unknown>) =>
    Object.entries(w).every(([k, v]) => (typeof v === 'object' && v !== null ? false : row[k] === v));
  const skillRepo = {
    find: vi.fn(async () => rows),
    findOne: vi.fn(async ({ where }: any) => rows.find((r) => (where as any[]).some((w) => matches(r, w))) ?? null),
  } as any;
  const teams = { teamIdsForUser: vi.fn(async () => []) } as any;
  const svc = new SkillsService(skillRepo, {} as any, {} as any, {} as any, {} as any, configStub, teams, {} as any);
  return { svc, skillRepo };
}

const personal = { id: 's1', ownerId: 'voice', scope: 'personal', isApproved: false };

describe('skills: an admin reads every skill', () => {
  it("a user does not read another user's personal skill", async () => {
    const { svc } = mkService([personal]);
    await expect(svc.findOne('s1', 'someone')).rejects.toBeInstanceOf(NotFoundException);
  });

  it("an admin reads it, and the owner still does", async () => {
    const { svc } = mkService([personal]);
    await expect(svc.findOne('s1', 'admin', true)).resolves.toMatchObject({ id: 's1' });
    await expect(svc.findOne('s1', 'voice')).resolves.toMatchObject({ id: 's1' });
  });

  it("the admin's list has every skill, with no filter", async () => {
    const { svc, skillRepo } = mkService([personal]);
    await expect(svc.findAllForAdmin()).resolves.toEqual([personal]);
    expect(skillRepo.find.mock.calls[0][0].where).toBeUndefined();
  });
});

describe('skills: egress allowlist', () => {
  it("joins the active plugins' hosts to the enabled skills' domains; a failing provider leaves the skills' alone", async () => {
    const { svc } = mkService([{ id: 's1', scope: 'personal', enabled: true, networkDomains: ['API.example.com'] }]);
    expect(await svc.getEgressAllowlist()).toEqual(['api.example.com']);
    svc.setPluginEgressProvider(async () => ['192.168.1.50/32']);
    expect(await svc.getEgressAllowlist()).toEqual(['192.168.1.50/32', 'api.example.com']);
    svc.setPluginEgressProvider(async () => { throw new Error('db down'); });
    expect(await svc.getEgressAllowlist()).toEqual(['api.example.com']);
  });
});
