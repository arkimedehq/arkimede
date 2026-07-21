/**
 * M2 regression — POST /internal/skills/:id/save-config must be bound to the
 * run-token identity and the caller's access to the target skill. Before the fix
 * any run-token could upsert config vars (including secrets) on ANY skill by id,
 * letting one skill overwrite another skill's stored credentials/endpoints.
 */
import { describe, it, expect, vi } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { InternalSkillsController } from '../../src/skills/internal-skills.controller';

function makeController(accessibleSkillId: string, owner: string) {
  const configVarRepo = {
    findOne: vi.fn(async () => null),
    create: vi.fn((x: any) => x),
    save: vi.fn(async (x: any) => x),
    update: vi.fn(async () => ({})),
  };
  const skillsService = {
    // Mirrors the real access gate: throws NotFound unless the caller can reach the skill.
    findOne: vi.fn(async (id: string, userId: string) => {
      if (id === accessibleSkillId && userId === owner) return { id, configSpec: [] };
      throw new NotFoundException('skills.notFound');
    }),
  };
  const controller = new InternalSkillsController(configVarRepo as any, skillsService as any);
  return { controller, configVarRepo, skillsService };
}

describe('save-config — bound to run-token identity + skill access (M2)', () => {
  it('saves config on a skill the caller can access', async () => {
    const { controller, configVarRepo } = makeController('skill-1', 'user-A');
    const res = await controller.saveConfig('skill-1', { config: { API_KEY: 'x' } }, { internalAuth: { sub: 'user-A' } });
    expect(res).toEqual({ ok: true, saved: 1 });
    expect(configVarRepo.save).toHaveBeenCalled();
  });

  it("denies writing config to another skill the caller cannot access", async () => {
    const { controller, configVarRepo } = makeController('skill-1', 'user-A');
    // Attacker A targets skill-2 (not accessible) → access gate throws, nothing saved.
    await expect(
      controller.saveConfig('skill-2', { config: { API_KEY: 'evil' } }, { internalAuth: { sub: 'user-A' } }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(configVarRepo.save).not.toHaveBeenCalled();
  });

  it('fails closed for an identity-less token', async () => {
    const { controller, skillsService } = makeController('skill-1', 'user-A');
    await expect(
      controller.saveConfig('skill-1', { config: { API_KEY: 'x' } }, { internalAuth: {} }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(skillsService.findOne).not.toHaveBeenCalled();
  });
});
