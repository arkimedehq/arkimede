// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * A plugin's skill is managed with its plugin (specs/PLUGINS.md §5): applying a compilation rewrites its SKILL.md, so it
 * is refused like the other changes by hand; a skill of no plugin is compiled as before.
 */
import { describe, it, expect, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { SkillsController } from '../../src/skills/skills.controller';

function controllerFor(pluginId: string | null) {
  const service = {
    assertNotPluginManaged: vi.fn(async () => { if (pluginId) throw new ForbiddenException('skills.pluginManaged'); }),
    applyCompilation: vi.fn(async () => ({ ok: true })),
  };
  return { service, controller: new SkillsController(service as any, {} as any, {} as any) };
}

describe('SkillsController.compile', () => {
  it('refuses a plugin\'s skill without touching it', async () => {
    const { service, controller } = controllerFor('plugin-1');
    await expect(controller.compile('s1', { scripts: [] } as any, { id: 'u1' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.applyCompilation).not.toHaveBeenCalled();
  });

  it('compiles a skill of no plugin', async () => {
    const { service, controller } = controllerFor(null);
    await expect(controller.compile('s1', { scripts: [] } as any, { id: 'u1' })).resolves.toEqual({ ok: true });
    expect(service.applyCompilation).toHaveBeenCalledWith('s1', 'u1', []);
  });
});
