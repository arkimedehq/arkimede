// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * A daemon that dies unexpectedly is restarted automatically with growing
 * delays, then left in 'error'; an explicit stop or restart cancels the
 * pending restart; a death never reported (sync) counts as a crash too.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FindOperator } from 'typeorm';
import { DaemonsService, RESTART_DELAYS_S, STABLE_RUN_MS } from '../../src/daemons/daemons.service';

type Row = { id: string; userId: string; skillId: string; scriptFilename: string; status: string;
  pid: number | null; startedAt: Date | null; lastError: string | null };

function matches(row: Row, where: Record<string, unknown>) {
  return Object.entries(where).every(([k, v]) =>
    v instanceof FindOperator ? (v.value as unknown[]).includes((row as any)[k]) : (row as any)[k] === v);
}

function makeService(initial: Partial<Row> = {}) {
  const rows = new Map<string, Row>();
  const row: Row = { id: 'd1', userId: 'u1', skillId: 's1', scriptFilename: 'scripts/daemon.js', status: 'running',
    pid: 10, startedAt: new Date(), lastError: null, ...initial };
  rows.set(row.id, row);
  const repo = {
    findOne: vi.fn(async ({ where }: any) => [...rows.values()].find((r) => matches(r, where)) ?? null),
    find: vi.fn(async ({ where }: any) => [...rows.values()].filter((r) => matches(r, where))),
    update: vi.fn(async (criteria: any, patch: Partial<Row>) => {
      const where = typeof criteria === 'string' ? { id: criteria } : criteria;
      const hit = [...rows.values()].filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, patch));
      return { affected: hit.length };
    }),
  };
  const live = new Map<string, { daemon_id: string; running: boolean; pid: number }>();
  const executor = {
    startDaemon: vi.fn(async (req: any) => {
      live.set(req.daemon_id, { daemon_id: req.daemon_id, running: true, pid: 99 });
      return { pid: 99, started_at: new Date().toISOString() };
    }),
    stopDaemon: vi.fn(async (id: string) => { live.delete(id); }),
    listDaemons: vi.fn(async () => [...live.values()]),
  };
  const skillsSvc = { resolveConfig: vi.fn(async () => ({})) };
  const skillRepo = { findOne: vi.fn(async () => ({ id: 's1' })) };
  const scriptRepo = { findOne: vi.fn(async () => ({ language: 'node' })) };
  const cfg = { get: (_k: string, d: string) => d };
  const svc = new DaemonsService(repo as any, skillRepo as any, scriptRepo as any, skillsSvc as any, executor as any, cfg as any);
  return { svc, row, executor, live };
}

describe('daemon auto-restart', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('restarts a crashed daemon after the first delay and keeps the output tail', async () => {
    const { svc, row, executor } = makeService();
    await svc.handleDaemonExit('d1', 1, '[bot] Fatal: 409 Conflict');
    expect(row.status).toBe('restarting');
    expect(row.lastError).toContain('exit code 1');
    expect(row.lastError).toContain('409 Conflict');
    expect(row.lastError).toContain(`restarting in ${RESTART_DELAYS_S[0]}s, attempt 1/${RESTART_DELAYS_S.length}`);

    await vi.advanceTimersByTimeAsync(RESTART_DELAYS_S[0] * 1000);
    expect(executor.startDaemon).toHaveBeenCalledTimes(1);
    expect(row.status).toBe('running');
    expect(row.lastError).toBeNull();
    svc.onModuleDestroy();
  });

  it('uses growing delays and gives up after the last one', async () => {
    const { svc, row, executor } = makeService();
    for (let i = 0; i < RESTART_DELAYS_S.length; i++) {
      row.startedAt = new Date();               // dies right after each start
      await svc.handleDaemonExit('d1', 1);
      expect(row.lastError).toContain(`attempt ${i + 1}/`);
      await vi.advanceTimersByTimeAsync(RESTART_DELAYS_S[i] * 1000 - 1);
      expect(executor.startDaemon).toHaveBeenCalledTimes(i);
      await vi.advanceTimersByTimeAsync(1);
      expect(executor.startDaemon).toHaveBeenCalledTimes(i + 1);
    }
    row.startedAt = new Date();
    await svc.handleDaemonExit('d1', 1);
    expect(row.status).toBe('error');
    expect(row.lastError).toContain(`automatic restart stopped after ${RESTART_DELAYS_S.length} attempts`);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(executor.startDaemon).toHaveBeenCalledTimes(RESTART_DELAYS_S.length);
    svc.onModuleDestroy();
  });

  it('starts from the first delay again after a stable run', async () => {
    const { svc, row } = makeService();
    await svc.handleDaemonExit('d1', 1);
    await vi.advanceTimersByTimeAsync(RESTART_DELAYS_S[0] * 1000);
    row.startedAt = new Date(Date.now() - STABLE_RUN_MS);
    await svc.handleDaemonExit('d1', 1);
    expect(row.lastError).toContain('attempt 1/');
    svc.onModuleDestroy();
  });

  it('an explicit stop cancels the pending restart', async () => {
    const { svc, row, executor } = makeService();
    await svc.handleDaemonExit('d1', 1);
    await svc.stop('d1', 'u1');
    expect(row.status).toBe('stopped');
    await vi.advanceTimersByTimeAsync(RESTART_DELAYS_S[0] * 1000);
    expect(executor.startDaemon).not.toHaveBeenCalled();
    svc.onModuleDestroy();
  });

  it('ignores the exit of a daemon that was stopped or already given up', async () => {
    for (const status of ['stopped', 'error']) {
      const { svc, row, executor } = makeService({ status, lastError: 'kept' });
      await svc.handleDaemonExit('d1', 0);
      expect(row.status).toBe(status);
      expect(row.lastError).toBe('kept');
      await vi.advanceTimersByTimeAsync(RESTART_DELAYS_S[0] * 1000);
      expect(executor.startDaemon).not.toHaveBeenCalled();
      svc.onModuleDestroy();
    }
  });

  it('two reports of the same death schedule a single restart', async () => {
    const { svc, row, executor } = makeService();
    await Promise.all([svc.handleDaemonExit('d1', 1), svc.findAll('u1')]);
    expect(row.lastError).toContain('attempt 1/');
    await vi.advanceTimersByTimeAsync(RESTART_DELAYS_S[0] * 1000);
    expect(executor.startDaemon).toHaveBeenCalledTimes(1);
    svc.onModuleDestroy();
  });

  it('a running daemon missing from the executor is treated as a crash on sync', async () => {
    const { svc, row, executor } = makeService();
    await svc.findAll('u1');
    expect(row.status).toBe('restarting');
    expect(row.lastError).toContain('not found in the executor');
    await vi.advanceTimersByTimeAsync(RESTART_DELAYS_S[0] * 1000);
    expect(executor.startDaemon).toHaveBeenCalledTimes(1);
    svc.onModuleDestroy();
  });

  it('a failed restart counts as a further crash', async () => {
    const { svc, row, executor } = makeService();
    executor.startDaemon.mockRejectedValueOnce(new Error('executor down'));
    await svc.handleDaemonExit('d1', 1);
    await vi.advanceTimersByTimeAsync(RESTART_DELAYS_S[0] * 1000);
    expect(row.status).toBe('restarting');
    expect(row.lastError).toContain('Restart failed: executor down');
    expect(row.lastError).toContain('attempt 2/');
    await vi.advanceTimersByTimeAsync(RESTART_DELAYS_S[1] * 1000);
    expect(row.status).toBe('running');
    svc.onModuleDestroy();
  });

  it('boot recovery resumes a daemon left in restarting', async () => {
    const { svc, row, executor } = makeService({ status: 'restarting' });
    await svc.onModuleInit();
    expect(executor.startDaemon).toHaveBeenCalledTimes(1);
    expect(row.status).toBe('running');
    svc.onModuleDestroy();
  });
});
