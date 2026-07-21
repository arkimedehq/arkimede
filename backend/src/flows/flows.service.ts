/**
 * @file flows.service.ts
 *
 * CRUD for Flows + manual run start. Visibility and management follow the same
 * model as custom tools / skills / data sources:
 *   - personal → only the creator
 *   - team     → team members (management: admin or team owner)
 *   - org      → the whole organization (management: admin)
 */
import {
  Injectable, NotFoundException, ForbiddenException, BadRequestException, Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { randomBytes } from 'crypto';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

import { TeamsService } from '../teams/teams.service';
import { Flow } from './flow.entity';
import { FlowRun } from './flow-run.entity';
import { FlowEngineService } from './flow-engine.service';
import { FlowSchedulerService } from './flow-scheduler.service';
import { FlowDefinition, FlowInputVar, FlowScope, FlowTrigger } from './flow.types';
import { AuditService } from '../audit/audit.service';

export interface UpsertFlowData {
  name: string;
  description?: string | null;
  definition?: FlowDefinition;
  trigger?: FlowTrigger;
  inputSchema?: FlowInputVar[];
  exposeAsTool?: boolean;
  loadOnFirst?: boolean;
  enabled?: boolean;
  scope?: FlowScope;
  teamId?: string | null;
}

@Injectable()
export class FlowsService {
  constructor(
    @InjectRepository(Flow) private readonly flowRepo: Repository<Flow>,
    @InjectRepository(FlowRun) private readonly runRepo: Repository<FlowRun>,
    private readonly teams: TeamsService,
    private readonly engine: FlowEngineService,
    private readonly scheduler: FlowSchedulerService,
    @Optional() private readonly audit?: AuditService,
  ) {}

  // ── Read ──────────────────────────────────────────────────────────────

  /** Flows visible to the user: own + org + teams they belong to. */
  async findAll(userId: string): Promise<Flow[]> {
    const teamIds = await this.teams.teamIdsForUser(userId);
    return this.flowRepo.find({
      where: this.visibilityWhere(userId, teamIds),
      order: { updatedAt: 'DESC' },
    });
  }

  /** Loads an accessible flow (own or shared) or throws 404/403. */
  async findOneAccessible(id: string, userId: string): Promise<Flow> {
    const flow = await this.flowRepo.findOne({ where: { id } });
    if (!flow) throw new NotFoundException('flows.notFound');
    await this.assertAccessible(flow, userId);
    return flow;
  }

  /** Loads a flow without checks (internal use, e.g. controller after assertCanManage). */
  async findById(id: string): Promise<Flow> {
    const flow = await this.flowRepo.findOne({ where: { id } });
    if (!flow) throw new NotFoundException('flows.notFound');
    return flow;
  }

  // ── Write ────────────────────────────────────────────────────────────

  async create(userId: string, data: UpsertFlowData): Promise<Flow> {
    const flow = this.flowRepo.create({
      userId,
      name: data.name,
      description: data.description ?? null,
      definition: data.definition ?? { nodes: [], edges: [] },
      trigger: data.trigger ?? { type: 'manual' },
      inputSchema: data.inputSchema ?? [],
      exposeAsTool: data.exposeAsTool ?? false,
      loadOnFirst: data.loadOnFirst ?? true,
      enabled: data.enabled ?? true,
      scope: data.scope ?? 'personal',
      teamId: data.scope === 'team' ? (data.teamId ?? null) : null,
    });
    this.ensureWebhookToken(flow);
    const saved = await this.flowRepo.save(flow);
    await this.scheduler.syncFlow(saved);
    await this.audit?.record({
      actorId: userId, action: 'flow.create', resource: saved.name,
      outcome: 'ok', ctx: { flowId: saved.id, scope: saved.scope },
    });
    return saved;
  }

  async update(id: string, data: Partial<UpsertFlowData>): Promise<Flow> {
    const flow = await this.findById(id);
    if (data.name !== undefined) flow.name = data.name;
    if (data.description !== undefined) flow.description = data.description;
    if (data.definition !== undefined) flow.definition = data.definition;
    if (data.trigger !== undefined) flow.trigger = data.trigger;
    if (data.inputSchema !== undefined) flow.inputSchema = data.inputSchema;
    if (data.exposeAsTool !== undefined) flow.exposeAsTool = data.exposeAsTool;
    if (data.loadOnFirst !== undefined) flow.loadOnFirst = data.loadOnFirst;
    if (data.enabled !== undefined) flow.enabled = data.enabled;
    if (data.scope !== undefined) {
      flow.scope = data.scope;
      flow.teamId = data.scope === 'team' ? (data.teamId ?? flow.teamId ?? null) : null;
    }
    this.ensureWebhookToken(flow);
    const saved = await this.flowRepo.save(flow);
    await this.scheduler.syncFlow(saved);
    return saved;
  }

  /** Generates a webhook token if the trigger is 'webhook' and doesn't have one. */
  private ensureWebhookToken(flow: Flow): void {
    if (flow.trigger?.type === 'webhook' && !flow.trigger.webhookToken) {
      flow.trigger = { ...flow.trigger, webhookToken: randomBytes(24).toString('hex') };
    }
  }

  /** Runs a flow from the webhook token (public endpoint, no JWT). */
  async runByWebhookToken(token: string, input: Record<string, unknown>): Promise<FlowRun> {
    const flow = await this.flowRepo
      .createQueryBuilder('f')
      .where("f.trigger ->> 'webhookToken' = :token", { token })
      .getOne();
    if (!flow) throw new NotFoundException('flows.webhookNotFound');
    if (!flow.enabled) throw new BadRequestException('flows.disabled');
    return this.engine.run(flow, flow.userId, input ?? {}, { triggeredBy: 'webhook' });
  }

  async remove(id: string, actorId?: string): Promise<void> {
    const flow = await this.flowRepo.findOne({ where: { id } });
    await this.scheduler.removeJobs(id);
    await this.flowRepo.delete({ id });
    await this.audit?.record({
      actorId: actorId ?? null, action: 'flow.delete', resource: flow?.name ?? id,
      outcome: 'ok', ctx: { flowId: id, trigger: null },
    });
  }

  // ── Execution ───────────────────────────────────────────────────────────

  /** Starts a manual run after verifying access. */
  async runManual(id: string, userId: string, input: Record<string, unknown>): Promise<FlowRun> {
    const flow = await this.findOneAccessible(id, userId);
    if (!flow.enabled) throw new BadRequestException('flows.disabled');
    await this.audit?.record({
      actorId: userId, action: 'flow.run', resource: flow.name,
      outcome: 'ok', ctx: { flowId: flow.id, trigger: 'manual' },
    });
    return this.engine.run(flow, userId, input ?? {}, { triggeredBy: 'manual' });
  }

  /**
   * Test run of a SINGLE node: executes the subgraph leading to `nodeId` (the node
   * itself + all its transitive predecessors), without the rest of the flow. It serves to
   * populate the tree of real fields in the binding picker during construction.
   * The optional `definition` allows testing the current unsaved canvas state.
   */
  async runNode(
    id: string,
    userId: string,
    nodeId: string,
    input: Record<string, unknown>,
    definition?: FlowDefinition,
  ): Promise<FlowRun> {
    const flow = await this.findOneAccessible(id, userId);
    const def = definition ?? flow.definition ?? { nodes: [], edges: [] };
    if (!def.nodes.some((n) => n.id === nodeId)) {
      throw new BadRequestException('flows.nodeNotFound');
    }
    const keep = this.subgraphUpTo(nodeId, def);
    const prunedDef: FlowDefinition = {
      nodes: def.nodes.filter((n) => keep.has(n.id)),
      edges: (def.edges ?? []).filter((e) => keep.has(e.source) && keep.has(e.target)),
    };
    const flowForRun = { ...flow, definition: prunedDef } as Flow;
    return this.engine.run(flowForRun, userId, input ?? {}, { triggeredBy: 'node' });
  }

  /** Set of nodes upstream of `target` (included) following the edges back. */
  private subgraphUpTo(target: string, def: FlowDefinition): Set<string> {
    const incoming = new Map<string, string[]>();
    for (const e of def.edges ?? []) {
      const arr = incoming.get(e.target) ?? [];
      arr.push(e.source);
      incoming.set(e.target, arr);
    }
    const keep = new Set<string>([target]);
    const stack = [target];
    while (stack.length) {
      const n = stack.pop()!;
      for (const p of incoming.get(n) ?? []) if (!keep.has(p)) { keep.add(p); stack.push(p); }
    }
    return keep;
  }

  /** Execution history of an accessible flow. */
  async listRuns(id: string, userId: string, limit = 50): Promise<FlowRun[]> {
    await this.findOneAccessible(id, userId);
    return this.runRepo.find({
      where: { flowId: id },
      order: { startedAt: 'DESC' },
      take: Math.min(limit, 200),
    });
  }

  // ── Flow-as-tool (chat-as-tool) ──────────────────────────────────────────

  /**
   * Loads the flows exposed as tools (`exposeAsTool=true`, enabled, visible
   * to the user) as DynamicStructuredTool, for the agent (resolveAgent).
   */
  async loadToolsForUser(
    userId: string,
    projectId?: string,
    opts: { flatOnly?: boolean } = {},
  ): Promise<DynamicStructuredTool[]> {
    const teamIds = await this.teams.teamIdsForUser(userId);
    // flatOnly (chat): excludes flows with loadOnFirst=false (usable only via agent).
    const base = opts.flatOnly
      ? { exposeAsTool: true, enabled: true, loadOnFirst: true } as const
      : { exposeAsTool: true, enabled: true } as const;
    const where: any[] = [{ userId, ...base }, { scope: 'org', ...base }];
    if (teamIds.length) where.push({ scope: 'team', teamId: In(teamIds), ...base });

    const flows = await this.flowRepo.find({ where });
    return flows.map((f) => this.buildFlowTool(f, userId, projectId));
  }

  /** Builds the DynamicStructuredTool for a flow (executes it via FlowEngine). */
  private buildFlowTool(flow: Flow, userId: string, projectId?: string): DynamicStructuredTool {
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const v of flow.inputSchema ?? []) {
      let field: z.ZodTypeAny =
        v.type === 'number' ? z.number()
        : v.type === 'boolean' ? z.boolean()
        : v.type === 'json' ? z.any()
        : z.string();
      if (v.description) field = field.describe(v.description);
      if (!v.required) field = field.optional();
      shape[v.name] = field;
    }

    return new DynamicStructuredTool({
      name: this.toolNameForFlow(flow.name),
      description: flow.description?.trim() || `Esegue il flow "${flow.name}".`,
      schema: z.object(shape),
      func: async (args: Record<string, unknown>) => {
        const run = await this.engine.run(flow, userId, args ?? {}, { triggeredBy: 'agent', projectId: projectId ?? null });
        if (run.status === 'error') return `Error during flow execution: ${run.error}`;
        const outputs = Object.fromEntries(
          Object.entries(run.state.nodes).map(([id, r]) => [id, (r as any).output]),
        );
        return JSON.stringify(outputs);
      },
    });
  }

  /** Valid tool name (snake_case) derived from the flow name, prefix `flow_`. */
  private toolNameForFlow(name: string): string {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50);
    return `flow_${slug || 'senza_nome'}`;
  }

  // ── Authorization ──────────────────────────────────────────────────────

  /**
   * Verifies that the user can MANAGE (create with scope / modify / delete)
   * a flow with the given scope/teamId. Mirror of custom-tools.
   */
  async assertCanManage(
    user: { id: string; role: string },
    scope: FlowScope,
    teamId: string | null | undefined,
    ownerId?: string,
  ): Promise<void> {
    if (scope === 'org') {
      if (user.role !== 'admin') throw new ForbiddenException('flows.orgAdminOnly');
      return;
    }
    if (scope === 'team') {
      if (!teamId) throw new ForbiddenException('flows.teamIdMissing');
      if (user.role === 'admin') return;
      if (await this.teams.isOwner(teamId, user.id)) return;
      throw new ForbiddenException('flows.teamAdminOnly');
    }
    if (ownerId !== undefined && ownerId !== user.id) {
      throw new ForbiddenException('flows.ownerOnly');
    }
  }

  /** Verifies that the user can VIEW/execute the flow. */
  private async assertAccessible(flow: Flow, userId: string): Promise<void> {
    if (flow.userId === userId) return;
    if (flow.scope === 'org') return;
    if (flow.scope === 'team' && flow.teamId && (await this.teams.isMember(flow.teamId, userId))) return;
    throw new ForbiddenException('flows.accessDenied');
  }

  private visibilityWhere(userId: string, teamIds: string[]) {
    const where: any[] = [{ userId }, { scope: 'org' }];
    if (teamIds.length) where.push({ scope: 'team', teamId: In(teamIds) });
    return where;
  }
}
