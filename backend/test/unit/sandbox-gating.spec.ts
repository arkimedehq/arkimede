/**
 * Sandbox gating (scope b): global master switch in app_config + authorization
 * for admin | project in allowlist | user's team in allowlist. Fail-closed.
 */
import { describe, it, expect } from 'vitest';
import { SandboxService } from '../../src/sandbox/sandbox.service';

function makeService(
  cfg: { sandboxEnabled: boolean; sandboxAllowedTeamIds: string[]; sandboxAllowedProjectIds: string[] },
  userTeams: string[] = [],
): SandboxService {
  const appConfig = { getSandboxConfig: async () => cfg } as any;
  const teams     = { teamIdsForUser: async () => userTeams } as any;
  const executor  = {} as any;
  return new SandboxService(appConfig, teams, executor);
}

const ON = { sandboxEnabled: true, sandboxAllowedTeamIds: [] as string[], sandboxAllowedProjectIds: [] as string[] };

describe('SandboxService.isEnabledFor', () => {
  it('flag globale OFF → false anche per admin (fail-closed)', async () => {
    const s = makeService({ ...ON, sandboxEnabled: false });
    expect(await s.isEnabledFor('u', 'p', true)).toBe(false);
  });

  it('admin → true quando il flag è ON', async () => {
    const s = makeService(ON);
    expect(await s.isEnabledFor('u', undefined, true)).toBe(true);
  });

  it('non-admin senza allowlist → false', async () => {
    const s = makeService(ON);
    expect(await s.isEnabledFor('u', 'p', false)).toBe(false);
  });

  it('progetto in allowlist → true (solo per quel progetto)', async () => {
    const s = makeService({ ...ON, sandboxAllowedProjectIds: ['proj1'] });
    expect(await s.isEnabledFor('u', 'proj1', false)).toBe(true);
    expect(await s.isEnabledFor('u', 'proj2', false)).toBe(false);
  });

  it('team dell\'utente in allowlist → true', async () => {
    const s = makeService({ ...ON, sandboxAllowedTeamIds: ['t1'] }, ['t1', 't9']);
    expect(await s.isEnabledFor('u', undefined, false)).toBe(true);
  });

  it('team non corrispondente → false', async () => {
    const s = makeService({ ...ON, sandboxAllowedTeamIds: ['t1'] }, ['t2']);
    expect(await s.isEnabledFor('u', 'p', false)).toBe(false);
  });

  it('buildSandboxTools espone un solo tool run_in_sandbox', () => {
    const tools = makeService(ON).buildSandboxTools('u', 'p', 'chat1');
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('run_in_sandbox');
  });
});
