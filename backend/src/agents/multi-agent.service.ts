/**
 * @file multi-agent.service.ts
 *
 * Multi-Agent runtime (MA-3): builds and runs agents and teams.
 *
 * Each agent = a `createReactAgent` with ITS OWN model (LlmConfig), ITS OWN
 * system prompt and a subset of the user's tools (custom/mcp/skill/flow)
 * filtered by `toolFilter`. Teams:
 *   - `sequential` → A → B → C (the output of one = the input of the next). [MA-3]
 *   - `supervisor` / `parallel` → MA-4 (StateGraph).
 */
import { Injectable, BadRequestException } from '@nestjs/common';
import { I18nContext } from 'nestjs-i18n';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

import {
  SUPERVISOR_DEFAULT, SUPERVISOR_DEFAULT_PARALLEL,
  parallelAggregationSystem, parallelAggregationUser,
  supervisorRoutingSystem, supervisorRoutingUser,
  supervisorSynthesisSystem, supervisorSynthesisUser,
} from '../prompts/prompts';
import { CustomToolsService } from '../custom-tools/custom-tools.service';
import { McpServersService } from '../mcp-servers/mcp-servers.service';
import { SkillsService } from '../skills/skills.service';
import { FlowsService } from '../flows/flows.service';
import { LlmConfigsService } from '../llm-configs/llm-configs.service';
import { AgentsService } from './agents.service';
import { AgentTeamsService } from './agent-teams.service';
import { Agent } from './agent.entity';
import { AgentTeam } from './agent-team.entity';
import { LlmUsage, emptyUsage, addUsage, sumUsageFromMessages, usageFromResult } from '../common/llm-usage.util';
import { runWithLlmCallContext, getLlmCallContext } from '../usage/llm-call-context';

export interface TeamStep { agent: string; role: string | null; output: string }
export interface TeamRunResult {
  final: string;
  steps: TeamStep[];
  usage: LlmUsage;
  provider?: string | null;
  model?: string | null;
}

@Injectable()
export class MultiAgentService {
  constructor(
    private readonly agents: AgentsService,
    private readonly teams: AgentTeamsService,
    private readonly customTools: CustomToolsService,
    private readonly mcp: McpServersService,
    private readonly skills: SkillsService,
    private readonly flows: FlowsService,
    private readonly llmConfigs: LlmConfigsService,
  ) {}

  // ── Entry point with access check ───────────────────────────────────────────

  async runAgentById(agentId: string, userId: string, input: string, projectId?: string): Promise<string> {
    const agent = await this.agents.findOneAccessible(agentId, userId);
    return this.runAgent(agent, userId, input, projectId);
  }

  async runTeamById(teamId: string, userId: string, input: string, projectId?: string): Promise<TeamRunResult> {
    const team = await this.teams.findOneAccessible(teamId, userId);
    let res: TeamRunResult;
    switch (team.topology) {
      case 'sequential': res = await this.runSequential(team.members, userId, input, projectId); break;
      case 'parallel':   res = await this.runParallel(team.supervisorAgentId, team.members, userId, input, projectId); break;
      case 'supervisor': res = await this.runSupervisor(team.supervisorAgentId, team.members, userId, input, projectId); break;
      default: throw new BadRequestException(I18nContext.current()?.t('agents.topologyUnknown', { args: { topology: team.topology } }) ?? `Topology "${team.topology}" not recognized.`);
    }
    // Cost attribution: provider/model of the default config (approximation:
    // a team may use multiple models; the total tokens are correct nonetheless).
    const def = await this.llmConfigs.getDefault();
    return { ...res, provider: def?.provider ?? null, model: def?.model ?? null };
  }

  // ── Agent/Team as a tool (exposeAsTool) ─────────────────────────────────────
  //
  // Hierarchical delegation: an agent/team with `exposeAsTool=true` is wrapped in a
  // DynamicStructuredTool and exposed to the chat (or to other agents) alongside the
  // other tools. The main model sees only name + description and *delegates* a task
  // to it; the agent's internal tools do NOT enter its context. Mirror of the
  // Flow chat-as-tool pattern (FlowsService.buildFlowTool).

  /** The user's exposable agent + team tools (for AgentService). */
  async loadToolsForUser(userId: string, projectId?: string): Promise<DynamicStructuredTool[]> {
    const [agents, teams] = await Promise.all([
      this.agents.findExposable(userId),
      this.teams.findExposable(userId),
    ]);
    return [
      ...agents.map((a) => this.buildAgentTool(a, userId, projectId)),
      ...teams.map((t)  => this.buildTeamTool(t, userId, projectId)),
    ];
  }

  private buildAgentTool(agent: Agent, userId: string, projectId?: string): DynamicStructuredTool {
    return new DynamicStructuredTool({
      name: this.toolName('agent', agent.name),
      description:
        agent.description?.trim() ||
        `Delegates a task to the agent "${agent.name}", which carries it out with its own tools.`,
      schema: z.object({
        input: z.string().describe('The task / request to assign to the agent, in natural language.'),
      }),
      func: async ({ input }) => this.runAgent(agent, userId, input, projectId),
    });
  }

  private buildTeamTool(team: AgentTeam, userId: string, projectId?: string): DynamicStructuredTool {
    return new DynamicStructuredTool({
      name: this.toolName('team', team.name),
      description:
        team.description?.trim() ||
        `Delegates a task to the team "${team.name}" (topology ${team.topology}).`,
      schema: z.object({
        input: z.string().describe('The task to assign to the team, in natural language.'),
      }),
      func: async ({ input }) => {
        const result = await this.runTeamById(team.id, userId, input, projectId);
        return result.final;
      },
    });
  }

  /** snake_case tool name, `agent_`/`team_` prefix (mirror of FlowsService). */
  private toolName(prefix: 'agent' | 'team', name: string): string {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50);
    return `${prefix}_${slug || 'no_name'}`;
  }

  // ── Building & running a single agent ──────────────────────────

  async runAgent(agent: Agent, userId: string, input: string, projectId?: string): Promise<string> {
    return (await this.runAgentWithUsage(agent, userId, input, projectId)).text;
  }

  private async runAgentWithUsage(agent: Agent, userId: string, input: string, projectId?: string): Promise<{ text: string; usage: LlmUsage }> {
    const { executor, callbacks } = await this.buildAgent(agent, userId, projectId);
    // LangGraph does not fire the model's instance callbacks (serving metrics):
    // re-passed via config, same workaround as AgentService. Class inherited
    // from the surroundings (chat-triggered teams stay interactive).
    const result: any = await runWithLlmCallContext(
      { priority: getLlmCallContext().priority ?? 'interactive', userId, origin: 'team' },
      () => executor.invoke({ messages: [new HumanMessage(input)] }, { callbacks }),
    );
    const messages = result?.messages ?? [];
    const last = messages[messages.length - 1];
    return { text: this.contentToString(last?.content), usage: sumUsageFromMessages(messages) };
  }

  private async buildAgent(agent: Agent, userId: string, projectId?: string) {
    const entity = agent.llmConfigId
      ? await this.llmConfigs.findOne(agent.llmConfigId)
      : await this.llmConfigs.getDefault();
    if (!entity) throw new BadRequestException('agents.noLlmConfigAgent');

    const model = await this.llmConfigs.buildModelForConfig(entity);
    const tools = await this.loadFilteredTools(agent, userId, projectId);

    return {
      executor: createReactAgent({
        llm: model,
        tools,
        messageModifier: agent.systemPrompt?.trim() || undefined,
      }),
      // Serving-metrics handler attached by buildModelForConfig: the caller must
      // re-pass it in the invoke config (LangGraph skips instance callbacks).
      callbacks: Array.isArray((model as any).callbacks) ? (model as any).callbacks : undefined,
    };
  }

  /** Loads the user's tools (custom/mcp/skill/flow) and applies the agent's filter. */
  private async loadFilteredTools(agent: Agent, userId: string, projectId?: string): Promise<DynamicStructuredTool[]> {
    const mode = agent.toolFilter?.mode ?? 'all';
    if (mode === 'none') return [];

    const groups = await Promise.all([
      this.customTools.loadToolsForUser(userId, projectId),
      this.mcp.loadToolsForUser(userId),
      this.skills.loadToolsForUser(userId, projectId),
      this.flows.loadToolsForUser(userId, projectId),
    ]);
    const all = groups.flat();

    if (mode === 'names') {
      const allowed = new Set(agent.toolFilter?.names ?? []);
      return all.filter((t) => allowed.has(t.name));
    }
    return all;
  }

  // ── Sequential topology ────────────────────────────────────────────────────

  private async runSequential(
    members: { agentId: string; role: string | null }[],
    userId: string,
    input: string,
    projectId?: string,
  ): Promise<TeamRunResult> {
    const steps: TeamStep[] = [];
    let usage = emptyUsage();
    let current = input;
    for (const m of members) {
      const agent = await this.agents.findById(m.agentId);
      const r = await this.runAgentWithUsage(agent, userId, current, projectId);
      usage = addUsage(usage, r.usage);
      steps.push({ agent: agent.name, role: m.role, output: r.text });
      current = r.text; // the output feeds the next member
    }
    return { final: current, steps, usage };
  }

  // ── Parallel topology ──────────────────────────────────────────────────────

  private async runParallel(
    supervisorAgentId: string | null,
    members: { agentId: string; role: string | null }[],
    userId: string,
    input: string,
    projectId?: string,
  ): Promise<TeamRunResult> {
    const memberAgents = await Promise.all(members.map((m) => this.agents.findById(m.agentId)));
    const results = await Promise.all(memberAgents.map((a) => this.runAgentWithUsage(a, userId, input, projectId)));
    const steps: TeamStep[] = memberAgents.map((a, i) => ({ agent: a.name, role: members[i].role, output: results[i].text }));
    let usage = results.reduce((acc, r) => addUsage(acc, r.usage), emptyUsage());
    const transcript = steps.map((s) => `[${s.agent}]: ${s.output}`).join('\n\n');

    // Aggregation: the supervisor synthesizes; without a supervisor, it concatenates.
    let final = transcript;
    if (supervisorAgentId) {
      const sup = await this.agents.findById(supervisorAgentId);
      const r = await this.callLlm(
        parallelAggregationSystem(sup.systemPrompt?.trim() || SUPERVISOR_DEFAULT_PARALLEL),
        parallelAggregationUser(input, transcript),
        sup.llmConfigId ?? undefined,
      );
      final = r.text; usage = addUsage(usage, r.usage);
    }
    return { final, steps, usage };
  }

  // ── Supervisor topology (routing loop, cross-provider) ──────────────────

  private async runSupervisor(
    supervisorAgentId: string | null,
    members: { agentId: string; role: string | null }[],
    userId: string,
    input: string,
    projectId?: string,
  ): Promise<TeamRunResult> {
    const memberAgents = await Promise.all(members.map((m) => this.agents.findById(m.agentId)));
    const sup = supervisorAgentId ? await this.agents.findById(supervisorAgentId) : null;
    const supLlm = sup?.llmConfigId ?? undefined;
    const supPrompt = sup?.systemPrompt?.trim() || SUPERVISOR_DEFAULT;

    const roster = memberAgents
      .map((a, i) => `- ${a.name}${members[i].role ? ` (${members[i].role})` : ''}: ${a.description ?? a.systemPrompt?.slice(0, 100) ?? ''}`)
      .join('\n');

    const steps: TeamStep[] = [];
    let usage = emptyUsage();
    let transcript = '';
    const maxSteps = Math.max(4, members.length * 2);

    for (let i = 0; i < maxSteps; i++) {
      const decision = await this.callLlm(
        supervisorRoutingSystem(supPrompt, roster),
        supervisorRoutingUser(input, transcript),
        supLlm,
      );
      usage = addUsage(usage, decision.usage);
      const choice = decision.text.trim();
      if (/finish/i.test(choice)) break;

      const idx = memberAgents.findIndex(
        (a) => choice.toLowerCase().includes(a.name.toLowerCase()) || a.name.toLowerCase().includes(choice.toLowerCase()),
      );
      if (idx < 0) break; // unresolvable routing → stop

      const agent = memberAgents[idx];
      const ctx = transcript ? `${input}\n\nTeam's work so far:\n${transcript}` : input;
      const r = await this.runAgentWithUsage(agent, userId, ctx, projectId);
      usage = addUsage(usage, r.usage);
      steps.push({ agent: agent.name, role: members[idx].role, output: r.text });
      transcript += `\n[${agent.name}]: ${r.text}`;
    }

    const fin = await this.callLlm(
      supervisorSynthesisSystem(supPrompt),
      supervisorSynthesisUser(input, transcript),
      supLlm,
    );
    usage = addUsage(usage, fin.usage);
    return { final: fin.text, steps, usage };
  }

  /** Direct LLM call (supervisor routing/synthesis), cross-provider. */
  private async callLlm(system: string, user: string, llmConfigId?: string): Promise<{ text: string; usage: LlmUsage }> {
    const entity = llmConfigId ? await this.llmConfigs.findOne(llmConfigId) : await this.llmConfigs.getDefault();
    if (!entity) throw new BadRequestException('agents.noLlmConfig');
    const model = await this.llmConfigs.buildModelForConfig(entity);
    // Inherits the surrounding class (chat-triggered teams stay interactive).
    const res: any = await runWithLlmCallContext({ priority: getLlmCallContext().priority ?? 'interactive', origin: 'team' }, () =>
      model.invoke([new SystemMessage(system), new HumanMessage(user)]));
    return { text: this.contentToString(res?.content), usage: usageFromResult(res) };
  }

  private contentToString(content: unknown): string {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map((b: any) => (typeof b === 'string' ? b : b?.text ?? '')).join('');
    }
    return String(content);
  }
}
