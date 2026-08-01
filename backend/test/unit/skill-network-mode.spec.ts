// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Job network params of a skill (`skillNetworkParams`): the admin tier override
 * (Skill.networkMode) must win over the domain-derived tier, `internal` must
 * suppress even a declared-domains skill, and the derived behavior must stay
 * exactly as before when no override is set (no regressions).
 */
import { describe, it, expect } from 'vitest';
import { skillNetworkParams } from '../../src/skills/skill-networks';

describe('skillNetworkParams — derived tier (no override)', () => {
  it('omits network when the skill declares no domains (internal baseline)', () => {
    expect(skillNetworkParams({})).toEqual({});
    expect(skillNetworkParams({ networkDomains: [] })).toEqual({});
    expect(skillNetworkParams({ networkMode: null })).toEqual({});
  });

  it('derives internet when the skill declares domains', () => {
    expect(skillNetworkParams({ networkDomains: ['api.example.com'] })).toEqual({
      network: 'internet',
    });
  });
});

describe('skillNetworkParams — admin override', () => {
  it('open wins regardless of declared domains', () => {
    expect(skillNetworkParams({ networkMode: 'open' })).toEqual({ network: 'open' });
    expect(
      skillNetworkParams({ networkMode: 'open', networkDomains: ['api.example.com'] }),
    ).toEqual({ network: 'open' });
  });

  it('internal suppresses the domain-derived internet tier', () => {
    expect(
      skillNetworkParams({ networkMode: 'internal', networkDomains: ['api.example.com'] }),
    ).toEqual({});
  });

  it('internet can be forced on a skill without declared domains', () => {
    expect(skillNetworkParams({ networkMode: 'internet' })).toEqual({ network: 'internet' });
  });
});
