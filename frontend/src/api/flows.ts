import api from './client';

// ── Tipi (mirror di backend/src/flows/flow.types.ts) ──────────────────────────

export type FlowScope = 'personal' | 'team' | 'org';
export type FlowNodeType = 'tool' | 'llm' | 'condition' | 'http' | 'skill' | 'transform' | 'flow' | 'agent' | 'team' | 'loop' | 'join' | 'chat';
export type NodeErrorPolicy = 'stop' | 'continue' | 'retry';
export type ConditionOp =
  | 'truthy' | 'falsy' | 'eq' | 'ne' | 'gt' | 'lt' | 'gte' | 'lte' | 'contains';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface FlowNodeBase {
  id: string;
  type: FlowNodeType;
  label?: string;
  position?: { x: number; y: number };
  onError?: NodeErrorPolicy;
  retries?: number;
  retryDelayMs?: number;
}
export interface ToolNode extends FlowNodeBase {
  type: 'tool';
  toolId: string;
  inputs?: Record<string, string>;
}
export interface LlmNode extends FlowNodeBase {
  type: 'llm';
  llmConfigId?: string;
  systemPrompt?: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
}
export interface ConditionNode extends FlowNodeBase {
  type: 'condition';
  left: string;
  op?: ConditionOp;
  right?: string;
}
export interface HttpNode extends FlowNodeBase {
  type: 'http';
  method: HttpMethod;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  responsePath?: string;
  timeoutMs?: number;
}
export interface SkillNode extends FlowNodeBase {
  type: 'skill';
  skillId: string;
  scriptFilename: string;
  inputs?: Record<string, string>;
}
export interface TransformNode extends FlowNodeBase {
  type: 'transform';
  code: string;
  inputs?: Record<string, string>;
}
export interface FlowCallNode extends FlowNodeBase {
  type: 'flow';
  flowId: string;
  inputs?: Record<string, string>;
}
export interface AgentNode extends FlowNodeBase { type: 'agent'; agentId: string; input?: string; }
export interface TeamNode extends FlowNodeBase { type: 'team'; teamId: string; input?: string; }
export interface LoopNode extends FlowNodeBase { type: 'loop'; over: string; flowId: string; itemVar?: string; maxItems?: number; }
export interface JoinNode extends FlowNodeBase { type: 'join'; }
export interface ChatNode extends FlowNodeBase { type: 'chat'; message: string; chatTitle?: string; }
export type FlowNode =
  | ToolNode | LlmNode | ConditionNode
  | HttpNode | SkillNode | TransformNode | FlowCallNode
  | AgentNode | TeamNode | LoopNode | JoinNode | ChatNode;

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  branch?: 'true' | 'false';
}
export interface FlowDefinition {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export type FlowTriggerType = 'manual' | 'cron' | 'scheduled' | 'chat-as-tool' | 'webhook' | 'flow-call';
export interface FlowTrigger {
  type: FlowTriggerType;
  cron?: string;
  runAt?: string;
  timezone?: string;
  firedAt?: string;
  webhookToken?: string;
}

export interface FlowInputVar {
  name: string;
  type?: 'string' | 'number' | 'boolean' | 'json';
  description?: string;
  required?: boolean;
}

export interface Flow {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  definition: FlowDefinition;
  trigger: FlowTrigger;
  inputSchema: FlowInputVar[];
  exposeAsTool: boolean;
  loadOnFirst: boolean;
  enabled: boolean;
  scope: FlowScope;
  teamId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NodeResult {
  status: 'ok' | 'error';
  output?: unknown;
  error?: string;
  meta?: { durationMs?: number };
}
export interface NodeRunRecord {
  nodeId: string;
  type: FlowNodeType;
  status: 'ok' | 'error' | 'skipped';
  durationMs?: number;
  error?: string;
}
export interface FlowRun {
  id: string;
  flowId: string | null;
  flowName: string | null;
  userId: string | null;
  triggeredBy: string;
  status: 'running' | 'completed' | 'error' | 'cancelled';
  state: { input: Record<string, unknown>; nodes: Record<string, NodeResult> };
  nodeRuns: NodeRunRecord[];
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface UpsertFlowPayload {
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

// ── API ───────────────────────────────────────────────────────────────────────

export const flowsApi = {
  list: (): Promise<Flow[]> =>
    api.get('/flows').then((r) => r.data),

  get: (id: string): Promise<Flow> =>
    api.get(`/flows/${id}`).then((r) => r.data),

  create: (payload: UpsertFlowPayload): Promise<Flow> =>
    api.post('/flows', payload).then((r) => r.data),

  update: (id: string, payload: UpsertFlowPayload): Promise<Flow> =>
    api.put(`/flows/${id}`, payload).then((r) => r.data),

  toggle: (id: string, enabled: boolean): Promise<Flow> =>
    api.patch(`/flows/${id}/toggle`, { enabled }).then((r) => r.data),

  remove: (id: string): Promise<void> =>
    api.delete(`/flows/${id}`).then((r) => r.data),

  run: (id: string, input: Record<string, unknown> = {}): Promise<FlowRun> =>
    api.post(`/flows/${id}/run`, { input }).then((r) => r.data),

  runNode: (id: string, body: { nodeId: string; input?: Record<string, unknown>; definition?: FlowDefinition }): Promise<FlowRun> =>
    api.post(`/flows/${id}/run-node`, body).then((r) => r.data),

  runs: (id: string): Promise<FlowRun[]> =>
    api.get(`/flows/${id}/runs`).then((r) => r.data),
};
