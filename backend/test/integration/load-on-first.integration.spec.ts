/**
 * Integration with real DB (testcontainers): hierarchical delegation.
 *
 *  A) loadOnFirst + flatOnly on CustomToolsService
 *     - chat (flatOnly)   → sees the loadOnFirst=true tools, NOT the false ones
 *     - agent (no flatOnly) → sees BOTH
 *  B) exposeAsTool on MultiAgentService.loadToolsForUser
 *     - an exposeAsTool=true agent is exposed as tool `agent_<slug>`
 *
 * No AppModule boot: only the services under test are instantiated with the
 * real repositories and stub/noop collaborators (like custom-tools-scoping).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DataSource } from 'typeorm';
import { startTestDb, type TestDb } from './_db';

import { CustomToolsService } from '../../src/custom-tools/custom-tools.service';
import { CustomTool } from '../../src/custom-tools/custom-tool.entity';
import { ToolSecret } from '../../src/custom-tools/tool-secret.entity';
import { AgentsService } from '../../src/agents/agents.service';
import { Agent } from '../../src/agents/agent.entity';
import { AgentTeamsService } from '../../src/agents/agent-teams.service';
import { AgentTeam } from '../../src/agents/agent-team.entity';
import { AgentTeamMember } from '../../src/agents/agent-team-member.entity';
import { MultiAgentService } from '../../src/agents/multi-agent.service';
import { User } from '../../src/users/users.entity';

const teamsStub = {
  teamIdsForUser: async () => [],
  isMember: async () => false,
  isOwner: async () => false,
} as any;
const noop = {} as any;

const httpCfg = { url: 'https://example.com', method: 'GET' as const };
const mkTool = (name: string, loadOnFirst: boolean) => ({
  name, description: 'desc', parameters: [],
  executorType: 'http' as const, executorConfig: httpCfg as any,
  loadOnFirst,
});

let db: TestDb;
let dataSource: DataSource;
let tools: CustomToolsService;
let agents: AgentsService;
let multiAgent: MultiAgentService;
let U: string;

beforeAll(async () => {
  db = await startTestDb();
  dataSource = db.dataSource;

  tools = new CustomToolsService(
    dataSource.getRepository(CustomTool),
    dataSource.getRepository(ToolSecret),
    noop, noop, noop, noop, noop, noop,
    teamsStub,
  );
  agents = new AgentsService(dataSource.getRepository(Agent), teamsStub);
  const agentTeams = new AgentTeamsService(
    dataSource.getRepository(AgentTeam),
    dataSource.getRepository(AgentTeamMember),
    teamsStub,
  );
  // loadToolsForUser uses only agents/teams (the other collaborators come into play
  // only when the agent is invoked, not when building the tool) → noop.
  multiAgent = new MultiAgentService(agents, agentTeams, noop, noop, noop, noop, noop);

  const users = dataSource.getRepository(User);
  U = (await users.save(users.create({ email: 'u@test.local', name: 'u', password: 'x' }))).id;
}, 180_000);

afterAll(async () => { await db?.stop(); });

describe('A) loadOnFirst + flatOnly (CustomToolsService)', () => {
  beforeAll(async () => {
    await tools.create(U, mkTool('db_tool', true));     // stays flat
    await tools.create(U, mkTool('email_tool', false)); // hidden from flat
  });

  it('flatOnly=true (chat) excludes the loadOnFirst=false tools', async () => {
    const names = (await tools.loadToolsForUser(U, undefined, { flatOnly: true })).map((t) => t.name);
    expect(names).toContain('db_tool');
    expect(names).not.toContain('email_tool');
  });

  it('without flatOnly (agent path) sees BOTH tools', async () => {
    const names = (await tools.loadToolsForUser(U)).map((t) => t.name);
    expect(names).toContain('db_tool');
    expect(names).toContain('email_tool');
  });
});

describe('B) exposeAsTool (MultiAgentService.loadToolsForUser)', () => {
  it('an exposeAsTool=true agent is exposed as tool agent_<slug>', async () => {
    await agents.create(U, {
      name: 'email writer',
      description: 'Scrive e invia email.',
      exposeAsTool: true,
      toolFilter: { mode: 'names', names: ['email_tool'] },
    });

    const names = (await multiAgent.loadToolsForUser(U)).map((t) => t.name);
    expect(names).toContain('agent_email_writer');
  });

  it('an exposeAsTool=false agent is NOT exposed', async () => {
    await agents.create(U, { name: 'segreto', exposeAsTool: false });
    const names = (await multiAgent.loadToolsForUser(U)).map((t) => t.name);
    expect(names).not.toContain('agent_segreto');
  });
});
