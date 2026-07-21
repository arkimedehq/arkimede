/**
 * @file flow-engine.service.ts
 *
 * Flow execution engine: interprets `definition` as a DAG and runs it in
 * topological order. For each node: (1) the BindingResolver resolves the inputs
 * from the state, (2) the node is executed reusing the existing services, (3) the
 * NodeResult is written into the state for the downstream nodes.
 *
 * `condition` nodes activate only the edges of the branch matching the boolean
 * → nodes that are not reached are skipped. (Parallel/join/loop: Slice 4.)
 *
 * Slice 1: tool | llm | condition nodes, manual trigger, persistence on flow_runs.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';

import { CustomToolsService } from '../custom-tools/custom-tools.service';
import { runWithLlmCallContext } from '../usage/llm-call-context';
import { LlmConfigsService } from '../llm-configs/llm-configs.service';
import { SkillsService } from '../skills/skills.service';
import { SkillExecutorClient } from '../skills/skill-executor.client';
import { TeamsService } from '../teams/teams.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationsGateway } from '../notifications/notifications.gateway';
import { Chat } from '../chats/chats.entity';
import { Message } from '../messages/messages.entity';
import { Flow } from './flow.entity';
import { FlowRun } from './flow-run.entity';
import {
  AgentNode, ChatNode, ConditionNode, ConditionOp, FlowCallNode, FlowDefinition, FlowNode, FlowRunState,
  FlowTriggeredBy, HttpNode, JoinNode, LlmNode, LoopNode, NodeResult, NodeRunRecord, SkillNode,
  TeamNode, ToolNode, TransformNode,
} from './flow.types';
import { getByPath, resolveBinding, resolveInputs } from './binding-resolver';

const MAX_FLOW_DEPTH = 5;

export interface RunOptions {
  triggeredBy?: FlowTriggeredBy;
  projectId?: string | null;
  /** Sub-flow nesting depth (internal use for the depth-guard). */
  depth?: number;
  /** Chain of flowIds traversed (cycle detection between flows). */
  visited?: string[];
  /** Flow being executed (injected in `run`): needed by the `chat` node to reuse/persist
   * `deliverChats`. Internal use — do not pass it from the outside. */
  flowEntity?: Flow;
}

@Injectable()
export class FlowEngineService {
  private readonly logger = new Logger(FlowEngineService.name);

  constructor(
    @InjectRepository(FlowRun) private readonly runRepo: Repository<FlowRun>,
    @InjectRepository(Flow) private readonly flowRepo: Repository<Flow>,
    @InjectRepository(Chat) private readonly chatRepo: Repository<Chat>,
    @InjectRepository(Message) private readonly messageRepo: Repository<Message>,
    private readonly customTools: CustomToolsService,
    private readonly llmConfigs: LlmConfigsService,
    private readonly skills: SkillsService,
    private readonly executor: SkillExecutorClient,
    private readonly teams: TeamsService,
    private readonly notifications: NotificationsService,
    private readonly gateway: NotificationsGateway,
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * Runs a flow and persists the run. Returns the saved FlowRun (state + timeline).
   */
  async run(
    flow: Flow,
    userId: string,
    input: Record<string, unknown> = {},
    opts: RunOptions = {},
  ): Promise<FlowRun> {
    const state: FlowRunState = { input, nodes: {} };
    const nodeRuns: NodeRunRecord[] = [];
    let runError: string | null = null;
    opts = { ...opts, flowEntity: flow }; // available to the nodes (e.g. `chat`) via opts

    try {
      this.topoSort(flow.definition); // validates the topology: errors on cycles
      const def = flow.definition;
      const { byId, outEdges } = this.indexGraph(def);

      // WAVE-based executor (parallel): `pending[n]` = incoming edges not yet
      // resolved; a node is runnable when pending===0. Independent branches
      // fall in the same wave → they run in parallel (Promise.all). A `join`
      // with N inputs waits for all edges to resolve (native fan-in).
      const pending = new Map<string, number>();
      for (const n of def.nodes) pending.set(n.id, 0);
      for (const e of def.edges ?? []) if (byId.has(e.target)) pending.set(e.target, (pending.get(e.target) ?? 0) + 1);
      const reached = new Set<string>();
      const settled = new Set<string>();

      let ready = def.nodes.filter((n) => (pending.get(n.id) ?? 0) === 0).map((n) => n.id);
      for (const id of ready) reached.add(id); // entry nodes (indeg 0)

      while (ready.length) {
        const wave = ready;
        ready = [];

        // Run the reached nodes of the wave in PARALLEL; the unreached ones = skipped.
        await Promise.all(wave.map(async (id) => {
          const node = byId.get(id)!;
          if (!reached.has(id)) {
            nodeRuns.push({ nodeId: id, type: node.type, status: 'skipped' });
            settled.add(id);
            return;
          }
          const t0 = Date.now();
          const result = await this.executeNodeWithPolicy(node, state, userId, opts, def);
          result.meta = { durationMs: Date.now() - t0 };
          state.nodes[id] = result;
          nodeRuns.push({ nodeId: id, type: node.type, status: result.status, durationMs: result.meta.durationMs, error: result.error });
          settled.add(id);
        }));

        // Resolve the outgoing edges of the wave's nodes → compute the next one.
        for (const id of wave) {
          const node = byId.get(id)!;
          const edges = outEdges.get(id) ?? [];
          let active: typeof edges;
          if (!reached.has(id)) {
            active = []; // skipped → no propagation
          } else {
            const result = state.nodes[id];
            if (result.status === 'error' && (node.onError ?? 'stop') !== 'continue') {
              active = []; // stop (or retries exhausted) → halt propagation
              runError = runError ?? `Node "${id}": ${result.error}`;
            } else if (node.type === 'condition' && result.status === 'ok') {
              const branch = result.output === true ? 'true' : 'false';
              active = edges.filter((e) => (e.branch ?? 'true') === branch);
            } else {
              active = edges; // ok, or error with 'continue' policy
            }
          }
          const activeSet = new Set(active);
          for (const e of edges) {
            if (!byId.has(e.target)) continue;
            if (activeSet.has(e)) reached.add(e.target);
            const p = (pending.get(e.target) ?? 0) - 1;
            pending.set(e.target, p);
            if (p === 0 && !settled.has(e.target)) ready.push(e.target);
          }
        }
      }
    } catch (err: any) {
      runError = err?.message ?? String(err);
    }

    const run = this.runRepo.create({
      flowId: flow.id,
      flowName: flow.name,
      userId,
      projectId: opts.projectId ?? null,
      triggeredBy: opts.triggeredBy ?? 'manual',
      status: runError ? 'error' : 'completed',
      state,
      nodeRuns,
      error: runError,
      finishedAt: new Date(),
    });
    const saved = await this.runRepo.save(run);
    await this.notifyRun(flow, saved, userId, opts);
    return saved;
  }

  /**
   * End-of-run notification (best-effort): persisted + WebSocket push. Only for the
   * "standalone" triggers (manual|cron|scheduled|webhook): NOT for `agent` (already inline in
   * chat-as-tool), `flow` (internal sub-flow) and `node` (test run). If the flow has a
   * `chat` node that delivered, include its `chatId` so the toast opens the chat.
   * Never breaks the run.
   */
  private async notifyRun(flow: Flow, run: FlowRun, userId: string, opts: RunOptions): Promise<void> {
    const trigger = opts.triggeredBy ?? 'manual';
    if (!['manual', 'cron', 'scheduled', 'webhook'].includes(trigger)) return;

    try {
      // chatId = output of the first delivered `chat` node (to open the chat from the toast).
      let chatId: string | null = null;
      for (const res of Object.values(run.state.nodes)) {
        const out = (res as NodeResult)?.output as any;
        if (out && typeof out.chatId === 'string') { chatId = out.chatId; break; }
      }
      const payload = { flowId: flow.id, flowName: flow.name, status: run.status, runId: run.id, chatId, error: run.error };
      const notif = await this.notifications.create({
        userId, source: 'flow', sourceId: flow.id, eventType: 'flow_run', payload,
      });
      this.gateway.emitToUser(userId, 'notification', { id: notif.id, eventType: 'flow_run', ...payload });
    } catch (err: any) {
      this.logger.warn(`notifyRun flow ${flow.id} failed: ${err?.message ?? err}`);
    }
  }

  /** chat — writes `message` (bound) as an assistant message in the dedicated chat. */
  private async execChat(node: ChatNode, state: FlowRunState, userId: string, opts: RunOptions): Promise<NodeResult> {
    const flow = opts.flowEntity;
    if (!flow) return { status: 'error', error: 'missing flow context (chat)' };
    const raw = resolveBinding(node.message ?? '', state);
    const content = raw == null ? '' : typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
    if (!content.trim()) return { status: 'error', error: 'empty message (chat)' };
    const titleKey = (node.chatTitle ?? '').trim() || flow.name;
    const chatId = await this.deliverToChat(flow, titleKey, content, userId, opts.projectId ?? null);
    return { status: 'ok', output: { chatId } };
  }

  /**
   * Writes `content` as an `assistant` message in a dedicated chat (key = `titleKey`)
   * and marks it unread. Reuses `flow.deliverChats[titleKey]` if the chat still exists,
   * otherwise creates `🤖 <titleKey>` and persists the id in the map. Returns the chatId.
   */
  private async deliverToChat(flow: Flow, titleKey: string, content: string, userId: string, projectId: string | null): Promise<string> {
    const map = flow.deliverChats ?? {};
    let chatId = map[titleKey] ?? null;
    if (chatId) {
      const exists = await this.chatRepo.findOne({ where: { id: chatId }, select: { id: true } });
      if (!exists) chatId = null; // chat deleted → recreate
    }
    if (!chatId) {
      const chat = await this.chatRepo.save(this.chatRepo.create({
        userId, projectId: projectId ?? null, title: `🤖 ${titleKey}`.slice(0, 120), unread: true,
      }));
      chatId = chat.id;
      flow.deliverChats = { ...map, [titleKey]: chatId }; // update in-memory (reuse within the run)
      await this.flowRepo.update(flow.id, { deliverChats: flow.deliverChats });
    }
    await this.messageRepo.save(this.messageRepo.create({ chatId, role: 'assistant', content }));
    await this.chatRepo.update(chatId, { unread: true, updatedAt: new Date() });
    return chatId;
  }

  // ── Execution of individual nodes ────────────────────────────────────────────

  private async executeNode(node: FlowNode, state: FlowRunState, userId: string, opts: RunOptions, def: FlowDefinition): Promise<NodeResult> {
    switch (node.type) {
      case 'tool':      return this.execTool(node, state, userId);
      case 'llm':       return this.execLlm(node, state);
      case 'condition': return this.execCondition(node, state);
      case 'http':      return this.execHttp(node, state);
      case 'skill':     return this.execSkill(node, state, userId);
      case 'transform': return this.execTransform(node, state);
      case 'flow':      return this.execFlow(node, state, userId, opts);
      case 'agent':     return this.execAgent(node, state, userId, opts);
      case 'team':      return this.execTeam(node, state, userId, opts);
      case 'loop':      return this.execLoop(node, state, userId, opts);
      case 'join':      return this.execJoin(node, state, def);
      case 'chat':      return this.execChat(node, state, userId, opts);
      default:
        return { status: 'error', error: `Unsupported node type: ${(node as any).type}` };
    }
  }

  /** join — collects the outputs of the predecessor nodes into an object. */
  private async execJoin(node: JoinNode, state: FlowRunState, def: FlowDefinition): Promise<NodeResult> {
    const preds = (def.edges ?? []).filter((e) => e.target === node.id).map((e) => e.source);
    const output: Record<string, unknown> = {};
    for (const p of preds) output[p] = state.nodes[p]?.output;
    return { status: 'ok', output };
  }

  /** loop — iterates over an array executing a sub-flow for each element. */
  private async execLoop(node: LoopNode, state: FlowRunState, userId: string, opts: RunOptions): Promise<NodeResult> {
    if (!node.flowId) return { status: 'error', error: 'missing flowId (loop)' };
    const arr = resolveBinding(node.over, state);
    if (!Array.isArray(arr)) return { status: 'error', error: '`over` does not resolve to an array' };

    const depth = opts.depth ?? 0;
    if (depth >= MAX_FLOW_DEPTH) return { status: 'error', error: `Maximum depth exceeded (${MAX_FLOW_DEPTH})` };

    const sub = await this.flowRepo.findOne({ where: { id: node.flowId } });
    if (!sub) return { status: 'error', error: 'Loop sub-flow not found' };
    if (!(await this.isAccessible(sub, userId))) return { status: 'error', error: 'Sub-flow not accessible' };

    const itemVar = node.itemVar || 'item';
    const items = arr.slice(0, Math.max(1, node.maxItems ?? 100));
    const results: unknown[] = [];
    for (const item of items) {
      const subRun = await this.run(sub, userId, { [itemVar]: item }, {
        triggeredBy: 'flow', projectId: opts.projectId ?? null,
        depth: depth + 1, visited: [...(opts.visited ?? []), node.flowId],
      });
      results.push(subRun.state.nodes);
    }
    return { status: 'ok', output: results };
  }

  /** Executes a node applying the retry-policy (onError='retry'). */
  private async executeNodeWithPolicy(node: FlowNode, state: FlowRunState, userId: string, opts: RunOptions, def: FlowDefinition): Promise<NodeResult> {
    const maxRetries = node.onError === 'retry' ? Math.max(1, node.retries ?? 2) : 0;
    let result: NodeResult = { status: 'error', error: 'not executed' };
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        result = await this.executeNode(node, state, userId, opts, def);
      } catch (err: any) {
        result = { status: 'error', error: err?.message ?? String(err) };
      }
      if (result.status === 'ok' || attempt === maxRetries) break;
      if (node.retryDelayMs) await new Promise((r) => setTimeout(r, node.retryDelayMs));
    }
    return result;
  }

  // ── agent / team nodes (bridge to the Multi-Agent) ───────────────────────────────
  // MultiAgentService is resolved at runtime via ModuleRef (dynamic require) to
  // avoid the cycle at the module level: AgentsModule already imports FlowsModule.

  private getMultiAgent(): any {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { MultiAgentService } = require('../agents/multi-agent.service');
    return this.moduleRef.get(MultiAgentService, { strict: false });
  }

  private async execAgent(node: AgentNode, state: FlowRunState, userId: string, opts: RunOptions): Promise<NodeResult> {
    if (!node.agentId) return { status: 'error', error: 'missing agentId' };
    const input = String(resolveBinding(node.input ?? '', state) ?? '');
    const output = await this.getMultiAgent().runAgentById(node.agentId, userId, input, opts.projectId ?? undefined);
    return { status: 'ok', output };
  }

  private async execTeam(node: TeamNode, state: FlowRunState, userId: string, opts: RunOptions): Promise<NodeResult> {
    if (!node.teamId) return { status: 'error', error: 'missing teamId' };
    const input = String(resolveBinding(node.input ?? '', state) ?? '');
    const result = await this.getMultiAgent().runTeamById(node.teamId, userId, input, opts.projectId ?? undefined);
    return { status: 'ok', output: result.final, meta: {} };
  }

  private async execTool(node: ToolNode, state: FlowRunState, userId: string): Promise<NodeResult> {
    if (!node.toolId) return { status: 'error', error: 'missing toolId' };
    const tool = await this.customTools.buildToolForTest(node.toolId, userId);
    const args = resolveInputs(node.inputs, state);
    const raw = await tool.invoke(args as any);
    return { status: 'ok', output: this.tryParseJson(raw) };
  }

  private async execLlm(node: LlmNode, state: FlowRunState): Promise<NodeResult> {
    const system = String(resolveBinding(node.systemPrompt ?? '', state) ?? '');
    const user = String(resolveBinding(node.userPrompt ?? '', state) ?? '');
    const text = await this.callLlm(system, user, node.llmConfigId, node.maxTokens, node.temperature);
    return { status: 'ok', output: text };
  }

  private async execCondition(node: ConditionNode, state: FlowRunState): Promise<NodeResult> {
    const left = resolveBinding(node.left, state);
    const op: ConditionOp = node.op ?? 'truthy';
    const right = node.right !== undefined ? resolveBinding(node.right, state) : undefined;
    return { status: 'ok', output: this.compare(left, op, right) };
  }

  private async execHttp(node: HttpNode, state: FlowRunState): Promise<NodeResult> {
    const url = String(resolveBinding(node.url, state) ?? '');
    if (!url) return { status: 'error', error: 'missing url' };

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(node.headers ?? {})) headers[k] = String(resolveBinding(v, state) ?? '');

    let body: string | undefined;
    if (node.body != null && node.method !== 'GET') {
      const b = resolveBinding(node.body, state);
      body = typeof b === 'string' ? b : JSON.stringify(b);
      if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = 'application/json';
      }
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), node.timeoutMs ?? 15000);
    try {
      const res = await fetch(url, { method: node.method, headers, body, signal: ctrl.signal });
      const text = await res.text();
      let parsed: unknown = this.tryParseJson(text);
      if (node.responsePath && parsed && typeof parsed === 'object') parsed = getByPath(parsed, node.responsePath);
      if (!res.ok) return { status: 'error', error: `HTTP ${res.status}`, output: parsed };
      return { status: 'ok', output: parsed };
    } catch (err: any) {
      return { status: 'error', error: err?.name === 'AbortError' ? 'Timeout HTTP' : (err?.message ?? String(err)) };
    } finally {
      clearTimeout(timer);
    }
  }

  private async execSkill(node: SkillNode, state: FlowRunState, userId: string): Promise<NodeResult> {
    if (!node.skillId || !node.scriptFilename) return { status: 'error', error: 'missing skillId/scriptFilename' };
    const tool = await this.skills.buildScriptTool(node.skillId, node.scriptFilename, userId);
    const args = resolveInputs(node.inputs, state);
    const raw = await tool.invoke(args as any);
    return { status: 'ok', output: this.tryParseJson(raw) };
  }

  private async execTransform(node: TransformNode, state: FlowRunState): Promise<NodeResult> {
    if (!node.code?.trim()) return { status: 'error', error: 'missing code' };
    const input = resolveInputs(node.inputs, state);
    const res = await this.executor.evalJs(node.code, input);
    if (!res.ok) return { status: 'error', error: res.error ?? 'Transform error' };
    return { status: 'ok', output: res.output };
  }

  private async execFlow(node: FlowCallNode, state: FlowRunState, userId: string, opts: RunOptions): Promise<NodeResult> {
    if (!node.flowId) return { status: 'error', error: 'missing flowId' };
    const depth = opts.depth ?? 0;
    const visited = opts.visited ?? [];
    if (depth >= MAX_FLOW_DEPTH) return { status: 'error', error: `Maximum sub-flow depth exceeded (${MAX_FLOW_DEPTH})` };
    if (visited.includes(node.flowId)) return { status: 'error', error: 'Cycle between flows detected' };

    const sub = await this.flowRepo.findOne({ where: { id: node.flowId } });
    if (!sub) return { status: 'error', error: 'Sub-flow not found' };
    if (!(await this.isAccessible(sub, userId))) return { status: 'error', error: 'Sub-flow not accessible' };
    if (!sub.enabled) return { status: 'error', error: 'Sub-flow disabled' };

    const input = resolveInputs(node.inputs, state);
    const subRun = await this.run(sub, userId, input, {
      triggeredBy: 'flow',
      projectId: opts.projectId ?? null,
      depth: depth + 1,
      visited: [...visited, node.flowId],
    });
    if (subRun.status === 'error') {
      return { status: 'error', error: subRun.error ?? 'Sub-flow error', output: subRun.state.nodes };
    }
    return { status: 'ok', output: subRun.state.nodes };
  }

  private async isAccessible(flow: Flow, userId: string): Promise<boolean> {
    if (flow.userId === userId) return true;
    if (flow.scope === 'org') return true;
    if (flow.scope === 'team' && flow.teamId) return this.teams.isMember(flow.teamId, userId);
    return false;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private compare(left: unknown, op: ConditionOp, right: unknown): boolean {
    switch (op) {
      case 'truthy': return !!left;
      case 'falsy':  return !left;
      case 'eq':     return this.looseEq(left, right);
      case 'ne':     return !this.looseEq(left, right);
      case 'gt':     return Number(left) > Number(right);
      case 'lt':     return Number(left) < Number(right);
      case 'gte':    return Number(left) >= Number(right);
      case 'lte':    return Number(left) <= Number(right);
      case 'contains':
        if (Array.isArray(left)) return left.includes(right);
        return String(left ?? '').includes(String(right ?? ''));
      default: return false;
    }
  }

  private looseEq(a: unknown, b: unknown): boolean {
    const na = Number(a), nb = Number(b);
    if (!Number.isNaN(na) && !Number.isNaN(nb) && a !== '' && b !== '') return na === nb;
    return String(a) === String(b);
  }

  private tryParseJson(raw: unknown): unknown {
    if (typeof raw !== 'string') return raw;
    const s = raw.trim();
    if (s && (s.startsWith('{') || s.startsWith('['))) {
      try { return JSON.parse(s); } catch { /* not JSON */ }
    }
    return raw;
  }

  /** Replica of the callLlm pattern from the `prompt` executor (cross-provider). */
  private async callLlm(
    system: string, user: string,
    llmConfigId?: string, maxTokens?: number, temperature?: number,
  ): Promise<string> {
    const entity = llmConfigId
      ? await this.llmConfigs.findOne(llmConfigId)
      : await this.llmConfigs.getDefault();
    if (!entity) throw new Error('No LLM config available for the llm node');

    const model = await this.llmConfigs.buildModelForConfig(entity, { maxTokens, temperature });
    // Flow llm nodes are batch work: they yield to interactive traffic (P1-F2).
    const res = await runWithLlmCallContext({ priority: 'batch', origin: 'flow' }, () =>
      model.invoke([new SystemMessage(system), new HumanMessage(user)]));
    const content: any = res.content;
    if (typeof content === 'string') return content;
    const textBlock = (content as any[]).find((b: any) => b.type === 'text');
    return textBlock?.text ?? '';
  }

  // ── Graph topology ──────────────────────────────────────────────────────

  private indexGraph(def: FlowDefinition) {
    const byId = new Map<string, FlowNode>(def.nodes.map((n) => [n.id, n]));
    const outEdges = new Map<string, FlowDefinition['edges']>();
    for (const e of def.edges ?? []) {
      if (!outEdges.has(e.source)) outEdges.set(e.source, []);
      outEdges.get(e.source)!.push(e);
    }
    return { byId, outEdges };
  }

  private entryNodeIds(def: FlowDefinition): string[] {
    const hasIncoming = new Set((def.edges ?? []).map((e) => e.target));
    return def.nodes.filter((n) => !hasIncoming.has(n.id)).map((n) => n.id);
  }

  /** Topological sort (Kahn). Errors on a cycle (loop: Slice 4). */
  private topoSort(def: FlowDefinition): string[] {
    const inDeg = new Map<string, number>(def.nodes.map((n) => [n.id, 0]));
    for (const e of def.edges ?? []) {
      inDeg.set(e.target, (inDeg.get(e.target) ?? 0) + 1);
    }
    const queue = [...inDeg.entries()].filter(([, d]) => d === 0).map(([id]) => id);
    const order: string[] = [];
    const adj = this.indexGraph(def).outEdges;

    while (queue.length) {
      const id = queue.shift()!;
      order.push(id);
      for (const e of adj.get(id) ?? []) {
        const d = (inDeg.get(e.target) ?? 0) - 1;
        inDeg.set(e.target, d);
        if (d === 0) queue.push(e.target);
      }
    }
    if (order.length !== def.nodes.length) {
      throw new Error('The flow contains a cycle: loops are not supported in this version.');
    }
    return order;
  }
}
