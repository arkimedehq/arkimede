// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * An agent run as a tool of another (agent_<slug>) or in a team: its own step budget (maxIterations), never LangGraph's
 * default 25; the sandbox when its filter asks for it and the user may use it, as in the chat.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recursionLimitOf } from '../../src/agents/agent-run-options';
import { MultiAgentService } from '../../src/agents/multi-agent.service';
import { SandboxService } from '../../src/sandbox/sandbox.service';

describe('recursionLimitOf', () => {
  const previous = process.env.AGENT_RECURSION_LIMIT;
  afterEach(() => { if (previous === undefined) delete process.env.AGENT_RECURSION_LIMIT; else process.env.AGENT_RECURSION_LIMIT = previous; });

  it('an agent\'s tool rounds: two graph steps each, plus the answer', () => {
    expect(recursionLimitOf(120)).toBe(241);
  });

  it('else the platform default (100, at least 10), never 25', () => {
    delete process.env.AGENT_RECURSION_LIMIT;
    expect(recursionLimitOf(null)).toBe(100);
    process.env.AGENT_RECURSION_LIMIT = '4';
    expect(recursionLimitOf(undefined)).toBe(10);
  });
});

describe('MultiAgentService — the sandbox for a delegated agent', () => {
  const tool = { name: 'run_in_sandbox' };
  function service(enabled: boolean, role = 'user') {
    const sandbox = { isEnabledFor: vi.fn(async () => enabled), buildSandboxTools: vi.fn(() => [tool]) };
    const moduleRef = { get: vi.fn((token: any) => (token === SandboxService ? sandbox : null)) };
    const ds = { query: vi.fn(async () => [{ role }]) };
    const svc = new MultiAgentService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, moduleRef as any, ds as any);
    return { svc: svc as any, sandbox };
  }

  it('given when its filter names it (or allows all) and the user may use it', async () => {
    const { svc, sandbox } = service(true);
    expect(await svc.sandboxTools({ toolFilter: { mode: 'names', names: ['run_in_sandbox'] } }, 'u1')).toEqual([tool]);
    expect(await svc.sandboxTools({ toolFilter: { mode: 'all' } }, 'u1')).toEqual([tool]);
    expect(sandbox.isEnabledFor).toHaveBeenCalledWith('u1', undefined, false);
  });

  it('an admin passes the gate as in the chat', async () => {
    const { svc, sandbox } = service(true, 'admin');
    await svc.sandboxTools({ toolFilter: { mode: 'all' } }, 'u1', 'p1');
    expect(sandbox.isEnabledFor).toHaveBeenCalledWith('u1', 'p1', true);
  });

  it('not given when its filter leaves it out, or the sandbox is off for the user', async () => {
    expect(await service(true).svc.sandboxTools({ toolFilter: { mode: 'names', names: ['web_search'] } }, 'u1')).toEqual([]);
    expect(await service(true).svc.sandboxTools({ toolFilter: { mode: 'none' } }, 'u1')).toEqual([]);
    expect(await service(false).svc.sandboxTools({ toolFilter: { mode: 'all' } }, 'u1')).toEqual([]);
  });
});

describe('MultiAgentService — a delegated agent stops with its caller', () => {
  it('the tool hands the caller\'s signal to the delegated run', async () => {
    const svc: any = new MultiAgentService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    svc.runAgent = vi.fn(async () => 'done');
    const tool = svc.buildAgentTool({ name: 'Sviluppatore', description: 'builds apps' }, 'u1', undefined);
    const controller = new AbortController();
    await tool.invoke({ input: 'un gioco' }, { signal: controller.signal });
    expect(svc.runAgent).toHaveBeenCalledWith(expect.objectContaining({ name: 'Sviluppatore' }), 'u1', 'un gioco', undefined, controller.signal);
  });
});
