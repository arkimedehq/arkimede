// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Editing an automation (SchedulingService.update + UpdateTaskDto) and the
 * per-automation token cap: NULL falls back to the global default, values above
 * the default (or 0 = no cap) are admin-only.
 */
import { validateSync } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { describe, expect, it, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { SchedulingService } from '../../src/scheduling/scheduling.service';
import { UpdateTaskDto } from '../../src/scheduling/scheduling.controller';

const DEFAULT_CAP = 200000;

function makeTask(over: Record<string, any> = {}): any {
  return {
    id: 't1', userId: 'u1', instruction: 'do something', title: 'Something',
    scheduleType: 'cron', cron: '0 7 * * *', runAt: null, timezone: 'Europe/Rome',
    enabled: true, status: 'active', maxTokensPerRun: null,
    toolFilter: { mode: 'none' }, ...over,
  };
}

function makeService(task: any, env: Record<string, any> = { SCHED_MAX_TOKENS_PER_RUN: String(DEFAULT_CAP) }) {
  const repo = {
    findOne: async ({ where }: any) => (task && where.id === task.id && where.userId === task.userId ? task : null),
    save: async (t: any) => t,
  };
  const config = { get: (k: string, d?: any) => (k in env ? env[k] : d) };
  return new SchedulingService(config as any, {} as any, repo as any, {} as any, {} as any, {} as any, {} as any);
}

describe('SchedulingService.update', () => {
  let task: any;
  beforeEach(() => { task = makeTask(); });

  it('edits instruction, title, cron, timezone and tools', async () => {
    const svc = makeService(task);
    const r = await svc.update('t1', 'u1', false, {
      instruction: 'new instruction', title: 'New', cron: '30 8 * * 1-5', timezone: 'UTC',
      toolFilter: { mode: 'names', names: ['web_search', ' '] },
    });
    expect(r).toMatchObject({
      instruction: 'new instruction', title: 'New', cron: '30 8 * * 1-5', timezone: 'UTC',
      toolFilter: { mode: 'names', names: ['web_search'] },
    });
  });

  it('leaves absent fields untouched', async () => {
    const r = await makeService(task).update('t1', 'u1', false, { title: 'Only title' });
    expect(r).toMatchObject({ instruction: 'do something', cron: '0 7 * * *', timezone: 'Europe/Rome', maxTokensPerRun: null });
  });

  it('turns an empty names list into mode none', async () => {
    const r = await makeService(task).update('t1', 'u1', false, { toolFilter: { mode: 'names', names: [] } });
    expect(r.toolFilter).toEqual({ mode: 'none' });
  });

  it('rejects an invalid cron, an empty instruction and a runAt on a cron task', async () => {
    const svc = makeService(task);
    await expect(svc.update('t1', 'u1', false, { cron: 'not a cron' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.update('t1', 'u1', false, { timezone: 'Mars/Olympus' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.update('t1', 'u1', false, { instruction: '  ' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.update('t1', 'u1', false, { runAt: new Date(Date.now() + 3600e3).toISOString() }))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('reschedules a completed one-shot into the future and re-arms it', async () => {
    task = makeTask({ scheduleType: 'scheduled', cron: null, runAt: new Date(Date.now() - 3600e3), status: 'done' });
    const svc = makeService(task);
    const future = new Date(Date.now() + 3600e3).toISOString();
    const r = await svc.update('t1', 'u1', false, { runAt: future });
    expect(r.status).toBe('active');
    expect(r.runAt?.toISOString()).toBe(future);
    await expect(svc.update('t1', 'u1', false, { runAt: new Date(Date.now() - 1000).toISOString() }))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.update('t1', 'u1', false, { cron: '* * * * *' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('is scoped to the owner', async () => {
    await expect(makeService(task).update('t1', 'other', true, { title: 'x' })).rejects.toBeInstanceOf(NotFoundException);
  });

  describe('token cap', () => {
    it('lets a user lower the cap or reset it to the default', async () => {
      const svc = makeService(task);
      expect((await svc.update('t1', 'u1', false, { maxTokensPerRun: 50000 })).maxTokensPerRun).toBe(50000);
      expect((await svc.update('t1', 'u1', false, { maxTokensPerRun: DEFAULT_CAP })).maxTokensPerRun).toBe(DEFAULT_CAP);
      expect((await svc.update('t1', 'u1', false, { maxTokensPerRun: null })).maxTokensPerRun).toBeNull();
    });

    it('reserves raising or removing the cap to admins', async () => {
      const svc = makeService(task);
      await expect(svc.update('t1', 'u1', false, { maxTokensPerRun: DEFAULT_CAP + 1 })).rejects.toBeInstanceOf(ForbiddenException);
      await expect(svc.update('t1', 'u1', false, { maxTokensPerRun: 0 })).rejects.toBeInstanceOf(ForbiddenException);
      expect((await svc.update('t1', 'u1', true, { maxTokensPerRun: 500000 })).maxTokensPerRun).toBe(500000);
      expect((await svc.update('t1', 'u1', true, { maxTokensPerRun: 0 })).maxTokensPerRun).toBe(0);
    });

    it('with no global cap, any positive cap is a restriction and is allowed', async () => {
      const svc = makeService(task, { SCHED_MAX_TOKENS_PER_RUN: '0' });
      expect((await svc.update('t1', 'u1', false, { maxTokensPerRun: 900000 })).maxTokensPerRun).toBe(900000);
    });

    it('the effective cap falls back to the global default when unset', () => {
      const svc: any = makeService(task);
      expect(svc.effectiveTokenCap(makeTask())).toBe(DEFAULT_CAP);
      expect(svc.effectiveTokenCap(makeTask({ maxTokensPerRun: 400000 }))).toBe(400000);
      expect(svc.effectiveTokenCap(makeTask({ maxTokensPerRun: 0 }))).toBe(0);
      expect(svc.limits()).toEqual({ defaultMaxTokensPerRun: DEFAULT_CAP });
    });
  });
});

describe('UpdateTaskDto', () => {
  const v = (body: any) => validateSync(plainToInstance(UpdateTaskDto, body));

  it('accepts partial bodies, a null cap and a numeric cap', () => {
    expect(v({})).toHaveLength(0);
    expect(v({ title: 'x' })).toHaveLength(0);
    expect(v({ maxTokensPerRun: null })).toHaveLength(0);
    expect(v({ maxTokensPerRun: 300000, toolFilter: { mode: 'names', names: ['a'] } })).toHaveLength(0);
  });

  it('rejects a negative or fractional cap and an unknown tool mode', () => {
    expect(v({ maxTokensPerRun: -1 })).not.toHaveLength(0);
    expect(v({ maxTokensPerRun: 1.5 })).not.toHaveLength(0);
    expect(v({ toolFilter: { mode: 'some' } })).not.toHaveLength(0);
  });
});
