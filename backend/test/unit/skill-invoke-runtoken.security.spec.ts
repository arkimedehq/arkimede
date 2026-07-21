/**
 * Inter-skill invoke now propagates the caller's identity to the executor as a
 * signed run-token (mirrors the primary skill-tool path), so an invoked skill can
 * reach the internal APIs AS the caller instead of running identity-less. Verifies
 * the run_token/user_id are attached and the token carries the caller's sub.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

beforeAll(() => { process.env.RUN_TOKEN_SECRET = 'x'.repeat(48); });

import { SkillsService } from '../../src/skills/skills.service';
import { verifyInternalToken } from '../../src/common/internal-token/internal-token';

function makeService() {
  const svc: any = Object.create(SkillsService.prototype);
  let captured: any = null;
  svc.skillRepo = { findOne: vi.fn(async () => ({ id: 's1', name: 'S', status: 'ready', ownerId: 'user-A', scope: 'personal' })) };
  svc.scriptRepo = {
    findOne: vi.fn(async () => ({ id: 'sc1', filename: 'scripts/run.py', language: 'python', mode: 'task' })),
    find: vi.fn(async () => []),
    update: vi.fn(async () => {}),
  };
  svc.teamsService = { teamIdsForUser: vi.fn(async () => []) };
  svc.logger = { log() {}, debug() {}, warn() {}, error() {} };
  svc.resolveConfig = vi.fn(async () => ({}));
  svc.executorClient = {
    execute: vi.fn(async (arg: any) => { captured = arg; return { exit_code: 0, stdout: '{"ok":true}', stderr: '', duration_ms: 5 }; }),
  };
  return { svc, getCaptured: () => captured };
}

describe('inter-skill invoke — propagates caller identity as a run-token', () => {
  it('attaches user_id + a run_token minted for the caller', async () => {
    const { svc, getCaptured } = makeService();
    await svc.invoke('s1', 'run.py', {}, 30_000, 'user-A');
    const arg = getCaptured();
    expect(arg.user_id).toBe('user-A');
    expect(typeof arg.run_token).toBe('string');
    expect(verifyInternalToken(arg.run_token).sub).toBe('user-A');
    expect(verifyInternalToken(arg.run_token).typ).toBe('run');
  });

  it('attaches no identity when invoked without a caller (unchanged legacy path)', async () => {
    const { svc, getCaptured } = makeService();
    await svc.invoke('s1', 'run.py', {}, 30_000, undefined);
    const arg = getCaptured();
    expect(arg.user_id).toBeUndefined();
    expect(arg.run_token).toBeUndefined();
  });
});
