// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * InvocationsService: preview/tool-call truncation at write time, best-effort
 * record() (a DB failure never reaches the caller), and findAll scoping
 * (own rows unless the admin all-users view is requested).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  InvocationsService, shapeToolCalls, truncatePreview, truncateToolValue,
} from '../../src/invocations/invocations.service';

function makeService(overrides: { repo?: any; userRepo?: any; env?: Record<string, string> } = {}) {
  const repo = {
    insert: vi.fn().mockResolvedValue(undefined),
    findAndCount: vi.fn().mockResolvedValue([[], 0]),
    delete: vi.fn().mockResolvedValue({ affected: 0 }),
    ...(overrides.repo ?? {}),
  };
  const userRepo = {
    find: vi.fn().mockResolvedValue([]),
    ...(overrides.userRepo ?? {}),
  };
  const env = { get: (k: string, d?: string) => overrides.env?.[k] ?? d };
  return { svc: new InvocationsService(repo as any, userRepo as any, env as any), repo, userRepo };
}

describe('truncation helpers', () => {
  it('truncatePreview caps long strings and marks the cut', () => {
    expect(truncatePreview(null)).toBeNull();
    expect(truncatePreview('short')).toBe('short');
    const out = truncatePreview('x'.repeat(5000))!;
    expect(out.length).toBeLessThan(4100);
    expect(out).toContain('truncated — 5000');
  });

  it('truncateToolValue preserves small objects and truncates big ones', () => {
    expect(truncateToolValue({ a: 1 })).toEqual({ a: 1 });
    const out = truncateToolValue({ big: 'y'.repeat(5000) });
    expect(typeof out).toBe('string');
    expect(out).toContain('truncated');
  });

  it('shapeToolCalls caps the record count and returns null when empty', () => {
    expect(shapeToolCalls([])).toBeNull();
    expect(shapeToolCalls(null)).toBeNull();
    const many = Array.from({ length: 60 }, (_, i) => ({ name: `t${i}` }));
    expect(shapeToolCalls(many)).toHaveLength(50);
  });
});

describe('InvocationsService.record', () => {
  it('swallows DB failures (best-effort: the logged request must not fail)', async () => {
    const { svc } = makeService({ repo: { insert: vi.fn().mockRejectedValue(new Error('db down')) } });
    await expect(
      svc.record({ userId: 'u1', origin: 'voice', route: 'chat', status: 'ok' }),
    ).resolves.toBeUndefined();
  });

  it('truncates previews at write time', async () => {
    const { svc, repo } = makeService();
    await svc.record({
      userId: 'u1', origin: 'voice', route: 'chat', status: 'ok',
      inputPreview: 'z'.repeat(9000),
    });
    const row = repo.insert.mock.calls[0][0];
    expect(row.inputPreview.length).toBeLessThan(4100);
  });
});

describe('InvocationsService.findAll scoping', () => {
  it('filters by the caller userId by default', async () => {
    const { svc, repo } = makeService();
    await svc.findAll('u1', {});
    expect(repo.findAndCount.mock.calls[0][0].where).toMatchObject({ userId: 'u1' });
  });

  it('drops the userId filter and resolves emails in the all-users view', async () => {
    const rows = [{ id: 'i1', userId: 'u2' }];
    const { svc, repo, userRepo } = makeService({
      repo: { findAndCount: vi.fn().mockResolvedValue([rows, 1]) },
      userRepo: { find: vi.fn().mockResolvedValue([{ id: 'u2', email: 'x@y.z' }]) },
    });
    const res = await svc.findAll('u1', { all: true });
    expect(repo.findAndCount.mock.calls[0][0].where.userId).toBeUndefined();
    expect(userRepo.find).toHaveBeenCalled();
    expect(res.items[0].userEmail).toBe('x@y.z');
  });

  it('clamps the page size to 100', async () => {
    const { svc, repo } = makeService();
    await svc.findAll('u1', { limit: 5000 });
    expect(repo.findAndCount.mock.calls[0][0].take).toBe(100);
  });
});
