/**
 * @file flow.types.ts
 *
 * Types of the Flows engine (deterministic graph workflows).
 *
 * A Flow is a DAG of nodes saved in `flows.definition` (jsonb). The `FlowEngine`
 * interprets it in topological order: for each node the `BindingResolver` resolves
 * the inputs from the run state, executes the node and writes a `NodeResult` into the
 * state, so the downstream nodes can read the outputs of the upstream ones.
 *
 * Slice 1: `tool` | `llm` | `condition` nodes, `manual` trigger.
 * (Slice 2+: `skill` | `transform` | `http` | `flow`; control `join` | `loop`.)
 *
 * See the "Flows (Design)" section in PROJECT.md for the complete model.
 */

/** Visibility/management scope, identical to custom tools / skills / data sources. */
export type FlowScope = 'personal' | 'team' | 'org';

// ── Nodes ─────────────────────────────────────────────────────────────────────

/** Node types (F1: tool|llm|condition; F2: +http|skill|transform|flow; F4: +agent|team|loop|join). */
export type FlowNodeType =
  | 'tool' | 'llm' | 'condition'
  | 'http' | 'skill' | 'transform' | 'flow'
  | 'agent' | 'team'
  | 'loop' | 'join' | 'chat';

/** Per-node error policy (Slice 4). */
export type NodeErrorPolicy = 'stop' | 'continue' | 'retry';

export interface FlowNodeBase {
  /** Unique id of the node within the flow (e.g. "n1"). Used in the bindings. */
  id: string;
  type: FlowNodeType;
  /** Human-readable label shown on the canvas. */
  label?: string;
  /** Position on the React Flow canvas (persisted with the definition). */
  position?: { x: number; y: number };
  /** Error policy (default 'stop'). 'continue' = proceeds; 'retry' = retries. */
  onError?: NodeErrorPolicy;
  /** Number of retries (only onError='retry', default 2). */
  retries?: number;
  /** Wait between retries in ms (only onError='retry'). */
  retryDelayMs?: number;
}

/**
 * `tool` node — executes an existing custom tool (by id) with arguments mapped
 * via binding from the run state.
 */
export interface ToolNode extends FlowNodeBase {
  type: 'tool';
  /** custom_tools.id of the tool to execute. */
  toolId: string;
  /** Argument → binding-expression mapping (e.g. { regione: "{{ input.regione }}" }). */
  inputs?: Record<string, string>;
}

/**
 * `llm` node — single LLM call (interpolated system + user). Evolution of the
 * `prompt` executor of the custom tools, reuses the same callLlm pattern.
 */
export interface LlmNode extends FlowNodeBase {
  type: 'llm';
  /** LlmConfig to use (omitted = default config). */
  llmConfigId?: string;
  /** System prompt with binding interpolation. */
  systemPrompt?: string;
  /** User prompt with binding interpolation. */
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
}

/** Operators of the condition node (no JS eval: structured, deterministic comparisons). */
export type ConditionOp =
  | 'truthy' | 'falsy'
  | 'eq' | 'ne'
  | 'gt' | 'lt' | 'gte' | 'lte'
  | 'contains';

/**
 * `condition` node — evaluates a comparison on the state and activates the outgoing
 * edges with a `branch` matching the boolean result ('true' | 'false').
 */
export interface ConditionNode extends FlowNodeBase {
  type: 'condition';
  /** Binding expression of the left side (resolved before the comparison). */
  left: string;
  /** Comparison operator (default 'truthy'). */
  op?: ConditionOp;
  /** Binding expression of the right side (for ops other than truthy/falsy). */
  right?: string;
}

/**
 * `http` node — direct HTTP call (without going through a custom tool). URL,
 * headers and body are interpolated via binding; `responsePath` extracts a field
 * from the JSON response.
 */
export interface HttpNode extends FlowNodeBase {
  type: 'http';
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  /** Body (string, also JSON) interpolated. Ignored for GET. */
  body?: string;
  /** Dot-path to extract a field from the JSON response (e.g. "data.0.id"). */
  responsePath?: string;
  timeoutMs?: number;
}

/**
 * `skill` node — executes a `oneshot` script of an installed skill, reusing
 * the skill infrastructure (per-language sandbox executor).
 */
export interface SkillNode extends FlowNodeBase {
  type: 'skill';
  skillId: string;
  scriptFilename: string;
  inputs?: Record<string, string>;
}

/**
 * `transform` node — deterministic transformation in JS, executed in the executor's
 * isolated-vm sandbox (the only place allowed for arbitrary JS). The script
 * reads the global variable `input` and MUST do `return <value>` to produce
 * the output (the code runs inside an async function: a simple final expression
 * is not returned).
 */
export interface TransformNode extends FlowNodeBase {
  type: 'transform';
  code: string;
  /** Builds the `input` object passed to the sandbox (binding → values). */
  inputs?: Record<string, string>;
}

/**
 * `flow` node — invokes another flow (recursive composability). The `inputs`
 * map the start variables of the sub-flow; the output is the
 * `nodeId → output` map of the sub-run. Protected by a depth-guard and cycle detection.
 */
export interface FlowCallNode extends FlowNodeBase {
  type: 'flow';
  flowId: string;
  inputs?: Record<string, string>;
}

/**
 * `agent` node — executes a single Multi-Agent agent. `input` is a binding
 * that resolves the prompt to pass to the agent.
 */
export interface AgentNode extends FlowNodeBase {
  type: 'agent';
  agentId: string;
  input?: string;
}

/**
 * `team` node — executes a team of agents (Multi-Agent) with its topology.
 * Output = the team's final response.
 */
export interface TeamNode extends FlowNodeBase {
  type: 'team';
  teamId: string;
  input?: string;
}

/**
 * `loop` node — iterates over an array (binding `over`) executing a sub-flow for each
 * element (the item is passed as the `itemVar` variable, default "item"). Output =
 * array of results (`nodeId → output` map of each sub-run).
 */
export interface LoopNode extends FlowNodeBase {
  type: 'loop';
  /** Binding that resolves the array to iterate over. */
  over: string;
  /** Sub-flow to execute for each element. */
  flowId: string;
  /** Name of the input variable with the current element (default "item"). */
  itemVar?: string;
  /** Safety limit on the number of iterations (default 100). */
  maxItems?: number;
}

/**
 * `join` node — fan-in: synchronizes (waits for all predecessors) and collects
 * their outputs into an object `{ <predecessor nodeId>: output }`.
 */
export interface JoinNode extends FlowNodeBase {
  type: 'join';
}

/**
 * `chat` node — delivers a message into a chat (homogeneous with the other nodes: bound
 * input). Writes `message` as an `assistant` message into the flow's dedicated chat
 * (created on the 1st run and reused via `flows.deliverChatId`), marking it unread.
 * Output = `{ chatId }` (so the end-of-run notification can open the chat).
 */
export interface ChatNode extends FlowNodeBase {
  type: 'chat';
  /** Content of the message (binding/interpolation). */
  message: string;
  /** Title of the dedicated chat (default: flow name). */
  chatTitle?: string;
}

export type FlowNode =
  | ToolNode | LlmNode | ConditionNode
  | HttpNode | SkillNode | TransformNode | FlowCallNode
  | AgentNode | TeamNode
  | LoopNode | JoinNode | ChatNode;

// ── Edges ────────────────────────────────────────────────────────────────────

export interface FlowEdge {
  id: string;
  /** Id of the source node. */
  source: string;
  /** Id of the target node. */
  target: string;
  /**
   * Only for edges outgoing from a `condition` node: branch to follow if the
   * condition is 'true' / 'false'. Absent on normal edges (always active).
   */
  branch?: 'true' | 'false';
}

export interface FlowDefinition {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

// ── Trigger & input ──────────────────────────────────────────────────────────

/** Where a flow starts from. */
export type FlowTriggerType =
  | 'manual'        // manual execution from UI
  | 'cron'          // recurring on a cron expression
  | 'scheduled'     // one-shot at a precise date/time (day X at Y)
  | 'chat-as-tool'  // invoked by the agent as a tool
  | 'webhook'       // external POST with token
  | 'flow-call';    // invoked by another flow (flow node)

export interface FlowTrigger {
  type: FlowTriggerType;
  /** 5/6-field cron expression (only type='cron'). */
  cron?: string;
  /** ISO date/time of the single fire (only type='scheduled'). */
  runAt?: string;
  /** IANA timezone for cron/scheduled (e.g. "Europe/Rome"). Default server time. */
  timezone?: string;
  /** ISO timestamp of the last fire of a one-shot (avoids re-executions after restart). */
  firedAt?: string;
  /** Webhook token (only type='webhook'). */
  webhookToken?: string;
}

/** Start variable of the flow (tool signature / manual-execution form). */
export interface FlowInputVar {
  name: string;
  type?: 'string' | 'number' | 'boolean' | 'json';
  description?: string;
  required?: boolean;
}

// ── Runtime ──────────────────────────────────────────────────────────────────

export type NodeStatus = 'ok' | 'error';

/**
 * Standard envelope returned by every node. `status` is ALWAYS present (covers the
 * "fire-and-forget" nodes like sending email: { status:'ok' } without output);
 * `output` is the optional payload consumable by the downstream nodes.
 */
export interface NodeResult {
  status: NodeStatus;
  output?: any;
  error?: string;
  meta?: { durationMs?: number };
}

/**
 * State of a run: input variables + outputs accumulated per node-id. The bindings
 * read from here: `{{ input.x }}`, `{{ nodes.<id>.output.<path> }}`.
 */
export interface FlowRunState {
  input: Record<string, any>;
  nodes: Record<string, NodeResult>;
}

export type FlowRunStatus = 'running' | 'completed' | 'error' | 'cancelled';

/** Who started the run (for history/observability). 'node' = test run of a single node + predecessors. */
export type FlowTriggeredBy = 'manual' | 'cron' | 'scheduled' | 'agent' | 'webhook' | 'flow' | 'node';

/** Per-node timeline saved on flow_runs.nodeRuns (debug). */
export interface NodeRunRecord {
  nodeId: string;
  type: FlowNodeType;
  status: NodeStatus | 'skipped';
  durationMs?: number;
  error?: string;
}
