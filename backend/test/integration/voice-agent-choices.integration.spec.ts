// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Integration with real DB — the voice agent of a user, as the admin sets it (specs/VOICE_SATELLITES.md §3.6): the
 * choices are the user's own agents, their teams' and the organization's; any other agent is refused.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestDb, type TestDb } from './_db';
import { UsersService } from '../../src/users/users.service';
import { User } from '../../src/users/users.entity';
import { Agent } from '../../src/agents/agent.entity';
import { Team } from '../../src/teams/team.entity';
import { TeamMembership } from '../../src/teams/team-membership.entity';

let db: TestDb;
let service: UsersService;
let VOICE: string, OTHER: string;
const ids: Record<string, string> = {};

beforeAll(async () => {
  db = await startTestDb();
  const users = db.dataSource.getRepository(User);
  service = new UsersService(users as any);
  const mk = async (email: string) => (await users.save(users.create({ email, name: email, password: 'x' }))).id;
  VOICE = await mk('voice@va.local');
  OTHER = await mk('other@va.local');
  const team = await db.dataSource.getRepository(Team).save({ name: 'va-team' });
  const other = await db.dataSource.getRepository(Team).save({ name: 'va-other' });
  await db.dataSource.getRepository(TeamMembership).save({ teamId: team.id, userId: VOICE });
  const agents = db.dataSource.getRepository(Agent);
  const ag = async (name: string, over: Partial<Agent>) => { ids[name] = (await agents.save(agents.create({ name, userId: OTHER, ...over }))).id; };
  await ag('own', { userId: VOICE });
  await ag('org', { scope: 'org' });
  await ag('team', { scope: 'team', teamId: team.id });
  await ag('other-team', { scope: 'team', teamId: other.id });
  await ag('someone-else', {});
}, 180_000);

afterAll(async () => { await db?.stop(); });

describe('voice agent choices', () => {
  it('lists the user\'s own, their team\'s and the organization\'s agents only', async () => {
    expect((await service.voiceAgentChoices(VOICE)).map((a) => a.name).sort()).toEqual(['org', 'own', 'team']);
  });

  it('sets a visible agent, refuses another\'s, clears to the standard pipeline', async () => {
    await service.updateProfile(VOICE, { voiceAgentId: ids.team });
    expect((await service.voiceSettings(VOICE))?.voiceAgentId).toBe(ids.team);
    await expect(service.updateProfile(VOICE, { voiceAgentId: ids['someone-else'] })).rejects.toThrow(/voiceAgentNotFound/);
    await expect(service.updateProfile(VOICE, { voiceAgentId: ids['other-team'] })).rejects.toThrow(/voiceAgentNotFound/);
    await service.updateProfile(VOICE, { voiceAgentId: null });
    expect((await service.voiceSettings(VOICE))?.voiceAgentId).toBeNull();
  });
});
