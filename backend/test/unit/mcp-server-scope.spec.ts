// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * MCP server visibility & scope rules. The service composes the same OR-based
 * visibility filter as tools/skills (own + org + team-of-user) and gates scope
 * changes by role/membership. These invariants back cross-user tool exposure —
 * a regression either leaks a personal server or hides a shared one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenException, BadRequestException } from '@nestjs/common';
import { McpServersService } from '../../src/mcp-servers/mcp-servers.service';

function makeService(overrides: {
  teamIds?: string[];
  isMember?: boolean;
  find?: any;
} = {}) {
  const serverRepo = {
    find: vi.fn().mockResolvedValue(overrides.find ?? []),
    findOne: vi.fn(),
    create: vi.fn((x) => x),
    save: vi.fn(async (x) => ({ id: 'new-id', ...x })),
  };
  const teams = {
    teamIdsForUser: vi.fn().mockResolvedValue(overrides.teamIds ?? []),
    isMember: vi.fn().mockResolvedValue(overrides.isMember ?? false),
  };
  const svc = new McpServersService(
    serverRepo as any,
    { find: vi.fn().mockResolvedValue([]) } as any, // secretRepo
    { findOne: vi.fn().mockResolvedValue(null) } as any, // appConfigRepo
    teams as any,
    { record: vi.fn() } as any, // audit
  );
  return { svc, serverRepo, teams };
}

// visibilityWhere / resolveScope are private — exercise them through the public
// surface where behavior is observable (find query shape, create scope result).
describe('MCP visibility filter', () => {
  it('findAll queries own + org, and team only when the user has teams', async () => {
    const { svc, serverRepo } = makeService({ teamIds: [] });
    await svc.findAll('user-1');
    const where = serverRepo.find.mock.calls[0][0].where;
    expect(where).toEqual([{ userId: 'user-1' }, { scope: 'org' }]);
  });

  it('includes the team branch when the user belongs to teams', async () => {
    const { svc, serverRepo } = makeService({ teamIds: ['team-a', 'team-b'] });
    await svc.findAll('user-1');
    const where = serverRepo.find.mock.calls[0][0].where;
    expect(where).toHaveLength(3);
    expect(where[2]).toMatchObject({ scope: 'team' });
  });
});

describe('MCP scope gating on create', () => {
  let base: any;
  beforeEach(() => {
    base = { name: 'HA', transport: 'sse', url: 'http://x/sse' };
  });

  it('a non-admin cannot create an org-shared server', async () => {
    const { svc } = makeService();
    await expect(
      svc.create('user-1', { ...base, scope: 'org' }, false, 'user'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('an admin can create an org-shared server', async () => {
    const { svc, serverRepo } = makeService();
    serverRepo.findOne.mockResolvedValue({ id: 'new-id', name: 'HA', scope: 'org', secrets: [] });
    await svc.create('admin-1', { ...base, scope: 'org' }, true, 'admin');
    expect(serverRepo.save).toHaveBeenCalledWith(expect.objectContaining({ scope: 'org', teamId: null }));
  });

  it('team scope requires membership (non-member rejected)', async () => {
    const { svc } = makeService({ isMember: false });
    await expect(
      svc.create('user-1', { ...base, scope: 'team', teamId: 'team-x' }, false, 'user'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('team scope with a missing teamId is a bad request', async () => {
    const { svc } = makeService({ isMember: true });
    await expect(
      svc.create('user-1', { ...base, scope: 'team' }, false, 'user'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('a member can create a team-shared server', async () => {
    const { svc, serverRepo } = makeService({ isMember: true });
    serverRepo.findOne.mockResolvedValue({ id: 'new-id', name: 'HA', scope: 'team', secrets: [] });
    await svc.create('user-1', { ...base, scope: 'team', teamId: 'team-x' }, false, 'user');
    expect(serverRepo.save).toHaveBeenCalledWith(expect.objectContaining({ scope: 'team', teamId: 'team-x' }));
  });

  it('defaults to personal when no scope is given', async () => {
    const { svc, serverRepo } = makeService();
    serverRepo.findOne.mockResolvedValue({ id: 'new-id', name: 'HA', scope: 'personal', secrets: [] });
    await svc.create('user-1', base, false, 'user');
    expect(serverRepo.save).toHaveBeenCalledWith(expect.objectContaining({ scope: 'personal', teamId: null }));
  });
});
