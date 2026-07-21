import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import ReactFlow, {
  Background, Controls, MiniMap, Handle, Position, MarkerType,
  addEdge, useNodesState, useEdgesState,
  type Node as RfNode, type Edge as RfEdge, type Connection, type NodeProps,
} from 'reactflow';
import 'reactflow/dist/style.css';
import {
  Workflow, Plus, Trash2, Play, Save, X, Loader2, Wrench, Bot, GitBranch,
  ArrowLeft, History, CheckCircle2, XCircle, MinusCircle, Globe, Sparkles, Wand2, Braces, Network,
  Repeat, GitMerge, MessageSquare,
} from 'lucide-react';

import {
  flowsApi, type Flow, type FlowNode, type FlowDefinition, type FlowNodeType,
  type ConditionOp, type FlowRun, type HttpMethod, type FlowTrigger, type FlowTriggerType,
  type NodeErrorPolicy, type FlowInputVar,
} from '../api/flows';
import { customToolsApi, type ToolParameter } from '../api/customTools';
import { llmConfigsApi } from '../api/llmConfigs';
import { skillsApi } from '../api/skills';
import { agentsApi, agentTeamsApi } from '../api/agents';

const uid = () => Math.random().toString(36).slice(2, 9);

/** ISO → value for <input type="datetime-local"> (local time). */
const toDatetimeLocal = (iso?: string) => {
  if (!iso) return '';
  const d = new Date(iso); const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

// ── Colors per node family ───────────────────────────────────────────────
const NODE_STYLE: Record<FlowNodeType, { ring: string; bg: string; icon: React.ElementType }> = {
  tool:      { ring: 'border-sky-500',    bg: 'bg-sky-500/15',    icon: Wrench },
  llm:       { ring: 'border-indigo-500', bg: 'bg-indigo-500/15', icon: Bot },
  http:      { ring: 'border-cyan-500',   bg: 'bg-cyan-500/15',   icon: Globe },
  skill:     { ring: 'border-violet-500', bg: 'bg-violet-500/15', icon: Sparkles },
  transform: { ring: 'border-teal-500',   bg: 'bg-teal-500/15',   icon: Wand2 },
  flow:      { ring: 'border-blue-500',   bg: 'bg-blue-500/15',   icon: Workflow },
  agent:     { ring: 'border-fuchsia-500',bg: 'bg-fuchsia-500/15',icon: Bot },
  team:      { ring: 'border-rose-500',   bg: 'bg-rose-500/15',   icon: Network },
  condition: { ring: 'border-amber-500',  bg: 'bg-amber-500/15',  icon: GitBranch },
  loop:      { ring: 'border-orange-500', bg: 'bg-orange-500/15', icon: Repeat },
  join:      { ring: 'border-yellow-500', bg: 'bg-yellow-500/15', icon: GitMerge },
  chat:      { ring: 'border-green-500',  bg: 'bg-green-500/15',  icon: MessageSquare },
};

/** Order of the building blocks in the palette (action then control). */
const PALETTE: FlowNodeType[] = ['tool', 'llm', 'http', 'skill', 'transform', 'flow', 'agent', 'team', 'condition', 'loop', 'join', 'chat'];

// ── Custom nodes ────────────────────────────────────────────────────────────────
function BaseNodeBox({ type, label, selected }: { type: FlowNodeType; label?: string; selected?: boolean }) {
  const { t } = useTranslation('flows');
  const s = NODE_STYLE[type];
  const Icon = s.icon;
  const typeLabel = t(`nodeType.${type}.label`);
  return (
    <div className={`group relative min-w-[140px] rounded-lg border-2 ${s.ring} ${s.bg} px-3 py-2 text-sm text-gray-100
      ${selected ? 'ring-2 ring-white/40' : ''}`}>
      <div className="flex items-center gap-2">
        <Icon size={14} className="opacity-80" />
        <span className="font-medium truncate">{label || typeLabel}</span>
      </div>
      <div className="text-[10px] uppercase tracking-wide text-gray-500 mt-0.5">{typeLabel}</div>
      {/* Descriptive bubble on hover */}
      <div className="pointer-events-none absolute left-1/2 -translate-x-1/2 top-full mt-2 z-50 w-56 rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-[11px] leading-snug text-gray-300 shadow-xl opacity-0 group-hover:opacity-100 transition-opacity duration-150">
        <span className="font-semibold text-gray-100">{typeLabel}</span>
        <span className="block mt-1 text-gray-400">{t(`nodeType.${type}.desc`)}</span>
      </div>
    </div>
  );
}

/** Generic view for action nodes (a single inbound and outbound handle). */
function ActionNodeView({ type, data, selected }: NodeProps) {
  return (
    <>
      <Handle type="target" position={Position.Top} />
      <BaseNodeBox type={type as FlowNodeType} label={data.label} selected={selected} />
      <Handle type="source" position={Position.Bottom} />
    </>
  );
}
function ConditionNodeView({ data, selected }: NodeProps) {
  return (
    <>
      <Handle type="target" position={Position.Top} />
      <BaseNodeBox type="condition" label={data.label} selected={selected} />
      <Handle id="true" type="source" position={Position.Bottom} style={{ left: '30%' }} />
      <Handle id="false" type="source" position={Position.Bottom} style={{ left: '70%' }} />
    </>
  );
}
const nodeTypes = {
  tool: ActionNodeView, llm: ActionNodeView, http: ActionNodeView,
  skill: ActionNodeView, transform: ActionNodeView, flow: ActionNodeView,
  agent: ActionNodeView, team: ActionNodeView, loop: ActionNodeView, join: ActionNodeView,
  chat: ActionNodeView,
  condition: ConditionNodeView,
};

// ── Conversion definition ↔ React Flow ───────────────────────────────────────
function toRf(def: FlowDefinition): { nodes: RfNode[]; edges: RfEdge[] } {
  const nodes = (def.nodes ?? []).map((n) => {
    const { id, type, position, ...rest } = n as any;
    return { id, type, position: position ?? { x: 0, y: 0 }, data: rest } as RfNode;
  });
  const edges = (def.edges ?? []).map((e) => ({
    id: e.id, source: e.source, target: e.target,
    sourceHandle: e.branch ?? null,
    label: e.branch,
    markerEnd: { type: MarkerType.ArrowClosed },
    style: e.branch === 'false' ? { stroke: '#f87171' } : e.branch === 'true' ? { stroke: '#4ade80' } : undefined,
  } as RfEdge));
  return { nodes, edges };
}
function fromRf(nodes: RfNode[], edges: RfEdge[]): FlowDefinition {
  return {
    nodes: nodes.map((n) => ({ id: n.id, type: n.type as FlowNodeType, position: n.position, ...(n.data as object) })) as FlowNode[],
    edges: edges.map((e) => ({
      id: e.id, source: e.source, target: e.target,
      branch: (e.sourceHandle as 'true' | 'false' | null) ?? undefined,
    })),
  };
}

// ══════════════════════════════════════════════════════════════════════════════
//  Main section
// ══════════════════════════════════════════════════════════════════════════════
export function FlowsSection() {
  const { t } = useTranslation('flows');
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Flow | null>(null);
  // A flow is created on the server up-front (the editor needs an id for run/save),
  // so remember when the open flow is a brand-new one: if the user backs out without
  // ever saving, it gets discarded instead of leaving an empty flow behind.
  const [editingIsNew, setEditingIsNew] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const query = useQuery({ queryKey: ['flows'], queryFn: flowsApi.list, staleTime: 10_000 });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['flows'] });

  const createM = useMutation({
    mutationFn: () => flowsApi.create({ name: t('newFlow'), definition: { nodes: [], edges: [] } }),
    onSuccess: (flow) => { invalidate(); setEditing(flow); setEditingIsNew(true); },
    onError: (e: any) => setErr(e?.response?.data?.message ?? t('errCreate')),
  });
  const removeM = useMutation({
    mutationFn: (id: string) => flowsApi.remove(id),
    onSuccess: () => { setErr(null); invalidate(); },
    onError: (e: any) => setErr(e?.response?.data?.message ?? t('errDelete')),
  });

  if (editing) {
    return (
      <FlowEditor
        flow={editing}
        isNew={editingIsNew}
        onClose={() => { setEditing(null); setEditingIsNew(false); invalidate(); }}
      />
    );
  }

  const flows = query.data ?? [];
  return (
    <div>
      <div className="flex items-start justify-between mb-5">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-gray-800 flex items-center justify-center text-gray-300"><Workflow size={18} /></div>
          <div>
            <h2 className="text-lg font-semibold text-white">Flows</h2>
            <p className="text-sm text-gray-500">{t('subtitle')}</p>
          </div>
        </div>
        <button onClick={() => createM.mutate()} disabled={createM.isPending}
          className="btn-primary px-4 py-2 text-sm flex items-center gap-2">
          {createM.isPending ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />} {t('newFlow')}
        </button>
      </div>

      {err && (
        <div className="flex items-center justify-between gap-3 bg-red-950/50 border border-red-900 text-red-300 text-sm rounded-lg px-3 py-2 mb-3">
          <span>{err}</span><button onClick={() => setErr(null)}><X size={14} /></button>
        </div>
      )}

      {query.isLoading ? (
        <div className="text-center py-10 text-gray-500"><Loader2 className="animate-spin inline" size={18} /></div>
      ) : flows.length === 0 ? (
        <div className="text-center py-10 text-gray-500 border border-dashed border-gray-800 rounded-xl">
          {t('empty')}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {flows.map((f) => (
            <div key={f.id} className="border border-gray-800 rounded-xl p-4 hover:border-gray-700 transition-colors">
              <div className="flex items-start justify-between">
                <button className="text-left min-w-0" onClick={() => { setEditing(f); setEditingIsNew(false); }}>
                  <div className="font-medium text-gray-100 truncate flex items-center gap-2">
                    {f.name}
                    {!f.enabled && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-800 text-gray-500">{t('offBadge')}</span>}
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {t('nodesScope', { count: f.definition?.nodes?.length ?? 0, scope: f.scope })}
                  </div>
                </button>
                <button title={t('deleteFlowTitle')} className="text-gray-500 hover:text-red-400"
                  onClick={() => { if (confirm(t('deleteFlowConfirm', { name: f.name }))) removeM.mutate(f.id); }}>
                  <Trash2 size={15} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
//  Canvas editor
// ══════════════════════════════════════════════════════════════════════════════
function FlowEditor({ flow, isNew = false, onClose }: { flow: Flow; isNew?: boolean; onClose: () => void }) {
  const { t } = useTranslation('flows');
  const qc = useQueryClient();
  // Was this (brand-new) flow ever saved? If not, backing out discards it.
  const [savedOnce, setSavedOnce] = useState(false);
  const initial = useMemo(() => toRf(flow.definition ?? { nodes: [], edges: [] }), [flow.id]);
  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);
  const [name, setName] = useState(flow.name);
  const [scope, setScope] = useState(flow.scope);
  const [enabled, setEnabled] = useState(flow.enabled);
  const [inputSchema, setInputSchema] = useState<FlowInputVar[]>(flow.inputSchema ?? []);
  const [trigger, setTrigger] = useState<FlowTrigger>(flow.trigger ?? { type: 'manual' });
  const [exposeAsTool, setExposeAsTool] = useState(flow.exposeAsTool ?? false);
  const [loadOnFirst, setLoadOnFirst] = useState(flow.loadOnFirst ?? true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [runOpen, setRunOpen] = useState(false);
  const [showRuns, setShowRuns] = useState(false);

  const tools = useQuery({ queryKey: ['custom-tools'], queryFn: customToolsApi.list, staleTime: 30_000 });
  const llmConfigs = useQuery({ queryKey: ['llm-configs'], queryFn: llmConfigsApi.list, staleTime: 30_000 });
  const skills = useQuery({ queryKey: ['skills'], queryFn: skillsApi.list, staleTime: 30_000 });
  const allFlows = useQuery({ queryKey: ['flows'], queryFn: flowsApi.list, staleTime: 10_000 });
  const agents = useQuery({ queryKey: ['agents'], queryFn: agentsApi.list, staleTime: 30_000 });
  const agentTeams = useQuery({ queryKey: ['agent-teams'], queryFn: agentTeamsApi.list, staleTime: 30_000 });
  // Latest run with populated node state → feeds the tree of real fields in the binding picker.
  const runs = useQuery({ queryKey: ['flow-runs', flow.id], queryFn: () => flowsApi.runs(flow.id), staleTime: 10_000 });
  const lastRun = useMemo(
    () => (runs.data ?? []).find((r) => r.state?.nodes && Object.keys(r.state.nodes).length > 0) ?? null,
    [runs.data],
  );

  const onConnect = useCallback((c: Connection) => setEdges((eds) => addEdge({
    ...c, markerEnd: { type: MarkerType.ArrowClosed },
    label: c.sourceHandle ?? undefined,
    style: c.sourceHandle === 'false' ? { stroke: '#f87171' } : c.sourceHandle === 'true' ? { stroke: '#4ade80' } : undefined,
  }, eds)), [setEdges]);

  const addNode = (type: FlowNodeType) => {
    const id = `${type}_${uid()}`;
    const base: any = { id, type, position: { x: 120 + Math.random() * 200, y: 80 + Math.random() * 200 }, data: {} };
    if (type === 'llm') base.data = { userPrompt: '' };
    if (type === 'condition') base.data = { left: '', op: 'truthy' };
    if (type === 'tool') base.data = { toolId: '', inputs: {} };
    if (type === 'http') base.data = { method: 'GET', url: '', headers: {} };
    if (type === 'skill') base.data = { skillId: '', scriptFilename: '', inputs: {} };
    if (type === 'transform') base.data = { code: '', inputs: {} };
    if (type === 'flow') base.data = { flowId: '', inputs: {} };
    if (type === 'agent') base.data = { agentId: '', input: '' };
    if (type === 'team') base.data = { teamId: '', input: '' };
    if (type === 'loop') base.data = { over: '', flowId: '', itemVar: 'item' };
    if (type === 'join') base.data = {};
    if (type === 'chat') base.data = { message: '', chatTitle: '' };
    setNodes((nds) => [...nds, base]);
    setSelectedId(id);
  };

  const updateNodeData = (id: string, patch: Record<string, unknown>) => {
    setNodes((nds) => nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)));
  };
  const deleteNode = (id: string) => {
    setNodes((nds) => nds.filter((n) => n.id !== id));
    setEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id));
    setSelectedId(null);
  };

  const selected = nodes.find((n) => n.id === selectedId) ?? null;

  const saveM = useMutation({
    mutationFn: () => flowsApi.update(flow.id, {
      name,
      definition: fromRf(nodes, edges),
      inputSchema: inputSchema.filter((v) => v.name.trim()),
      enabled,
      scope,
      teamId: flow.teamId,
      trigger,
      exposeAsTool,
      loadOnFirst,
    }),
    onSuccess: (updated) => { setErr(null); setSavedOnce(true); setTrigger(updated.trigger); qc.invalidateQueries({ queryKey: ['flows'] }); },
    onError: (e: any) => setErr(e?.response?.data?.message ?? t('errSave')),
  });

  // Discard a brand-new flow that was never saved (fired when backing out).
  const discardM = useMutation({
    mutationFn: () => flowsApi.remove(flow.id),
    onSettled: onClose, // close regardless: on error the stale flow is harmless
  });

  // Back button: keep the flow only if it's an existing one or was saved at least once.
  const handleClose = () => {
    if (isNew && !savedOnce) discardM.mutate();
    else onClose();
  };

  // Test run of the selected node + predecessors (subgraph) on the current canvas
  // state (even unsaved) → on success reloads the runs so the picker shows the real fields.
  const runNodeM = useMutation({
    mutationFn: (nodeId: string) =>
      flowsApi.runNode(flow.id, { nodeId, input: lastRun?.state.input ?? {}, definition: fromRf(nodes, edges) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['flow-runs', flow.id] }),
  });

  return (
    <div>
      {/* Editor header */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <button onClick={handleClose} className="text-gray-400 hover:text-white flex items-center gap-1 text-sm">
          <ArrowLeft size={16} /> Flows
        </button>
        <input value={name} onChange={(e) => setName(e.target.value)}
          className="bg-gray-900 border border-gray-800 rounded-lg px-3 py-1.5 text-sm text-white flex-1 min-w-[140px] max-w-xs" />
        <select value={scope} onChange={(e) => setScope(e.target.value as any)}
          className="bg-gray-900 border border-gray-800 rounded-lg px-2 py-1.5 text-sm text-gray-200">
          <option value="personal">personal</option>
          <option value="team">team</option>
          <option value="org">org</option>
        </select>
        <label className="flex items-center gap-1.5 text-sm text-gray-300">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> {t('editor.active')}
        </label>
        <div className="hidden md:block flex-1" />
        <button onClick={() => setShowRuns((s) => !s)} className="px-3 py-1.5 text-sm text-gray-300 hover:text-white flex items-center gap-1.5">
          <History size={15} /> {t('editor.history')}
        </button>
        <button onClick={() => setRunOpen(true)} className="px-3 py-1.5 text-sm rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white flex items-center gap-1.5">
          <Play size={15} /> {t('editor.run')}
        </button>
        <button onClick={() => saveM.mutate()} disabled={saveM.isPending}
          className="btn-primary px-3 py-1.5 text-sm flex items-center gap-1.5">
          {saveM.isPending ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} {t('common:actions.save')}
        </button>
      </div>

      {err && (
        <div className="flex items-center justify-between gap-3 bg-red-950/50 border border-red-900 text-red-300 text-sm rounded-lg px-3 py-2 mb-3">
          <span>{err}</span><button onClick={() => setErr(null)}><X size={14} /></button>
        </div>
      )}

      {/* Input variables */}
      <InputVarsEditor value={inputSchema} onChange={setInputSchema} />

      {/* Trigger */}
      <div className="flex items-center gap-2 mb-3 text-sm flex-wrap">
        <span className="text-gray-500">{t('trigger.label')}</span>
        <select value={trigger.type} onChange={(e) => setTrigger({ ...trigger, type: e.target.value as FlowTriggerType })}
          className="bg-gray-900 border border-gray-800 rounded-lg px-2 py-1.5 text-gray-200">
          <option value="manual">{t('trigger.manual')}</option>
          <option value="cron">{t('trigger.cron')}</option>
          <option value="scheduled">{t('trigger.scheduled')}</option>
          <option value="webhook">{t('trigger.webhook')}</option>
        </select>
        {trigger.type === 'cron' && (
          <CronBuilder value={trigger.cron ?? ''} onChange={(cron) => setTrigger({ ...trigger, cron })} />
        )}
        {trigger.type === 'scheduled' && (
          <input type="datetime-local" value={toDatetimeLocal(trigger.runAt)}
            onChange={(e) => setTrigger({ ...trigger, runAt: e.target.value ? new Date(e.target.value).toISOString() : undefined })}
            className="bg-gray-900 border border-gray-800 rounded-lg px-2.5 py-1.5 text-gray-200" />
        )}
        {trigger.type === 'webhook' && (
          trigger.webhookToken
            ? <code className="text-[11px] text-gray-400 truncate max-w-sm" title={`${window.location.origin}/api/flows/webhook/${trigger.webhookToken}`}>
                {window.location.origin}/api/flows/webhook/{trigger.webhookToken.slice(0, 10)}…
              </code>
            : <span className="text-gray-600 text-xs">{t('trigger.webhookSaveHint')}</span>
        )}
        <div className="flex-1" />
        <label className="flex items-center gap-1.5 text-gray-300">
          <input type="checkbox" checked={exposeAsTool} onChange={(e) => setExposeAsTool(e.target.checked)} />
          {t('trigger.exposeAsTool')}
        </label>
        {exposeAsTool && (
          <label className="flex items-center gap-1.5 text-gray-300" title={t('trigger.loadOnFirstTitle')}>
            <input type="checkbox" checked={loadOnFirst} onChange={(e) => setLoadOnFirst(e.target.checked)} />
            {t('trigger.loadOnFirst')}
          </label>
        )}
      </div>

      <div className="flex flex-col md:flex-row gap-3">
        {/* Canvas + palette */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <span className="text-xs text-gray-500">{t('palette.add')}</span>
            {PALETTE.map((nt) => {
              const s = NODE_STYLE[nt]; const Icon = s.icon;
              return (
                <div key={nt} className="relative group">
                  <button onClick={() => addNode(nt)}
                    className={`text-xs px-2.5 py-1 rounded-md border ${s.ring} ${s.bg} text-gray-200 flex items-center gap-1.5`}>
                    <Icon size={12} /> {t(`nodeType.${nt}.label`)}
                  </button>
                  {/* Descriptive bubble on hover */}
                  <div className="pointer-events-none absolute left-0 top-full mt-2 z-40 w-60 rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-[11px] leading-snug text-gray-300 shadow-xl opacity-0 group-hover:opacity-100 transition-opacity duration-150">
                    <span className={`inline-flex items-center gap-1 font-semibold text-gray-100`}><Icon size={11} /> {t(`nodeType.${nt}.label`)}</span>
                    <span className="block mt-1 text-gray-400">{t(`nodeType.${nt}.desc`)}</span>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="h-[58vh] border border-gray-800 rounded-xl overflow-hidden bg-gray-950">
            <ReactFlow
              nodes={nodes} edges={edges}
              onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
              nodeTypes={nodeTypes}
              onNodeClick={(_, n) => setSelectedId(n.id)}
              onPaneClick={() => setSelectedId(null)}
              deleteKeyCode={['Backspace', 'Delete']}
              onNodesDelete={(deleted) => { if (deleted.some((d) => d.id === selectedId)) setSelectedId(null); }}
              fitView proOptions={{ hideAttribution: true }}>
              <Background color="#374151" gap={16} />
              <Controls className="!bg-gray-800 !border-gray-700" />
              <MiniMap pannable zoomable className="!bg-gray-900" />
            </ReactFlow>
          </div>
        </div>

        {/* Node config panel */}
        {selected && (
          <NodeConfigPanel
            key={selected.id}
            node={selected}
            tools={tools.data ?? []}
            llmConfigs={llmConfigs.data ?? []}
            skills={skills.data ?? []}
            flows={(allFlows.data ?? []).filter((f) => f.id !== flow.id)}
            agents={agents.data ?? []}
            teams={agentTeams.data ?? []}
            bindings={buildBindings(
              selected.id, nodes, edges,
              inputSchema.map((v) => v.name).filter(Boolean),
              lastRun,
            )}
            onChange={(patch) => updateNodeData(selected.id, patch)}
            onDelete={() => deleteNode(selected.id)}
            onRunNode={() => runNodeM.mutate(selected.id)}
            runPending={runNodeM.isPending}
            runResult={runNodeM.data ?? null}
          />
        )}
      </div>

      {runOpen && <RunModal flowId={flow.id} vars={inputSchema} onClose={() => setRunOpen(false)} />}
      {showRuns && <RunsModal flowId={flow.id} onClose={() => setShowRuns(false)} />}
    </div>
  );
}

// ── Node configuration panel ──────────────────────────────────────────────
function NodeConfigPanel({ node, tools, llmConfigs, skills, flows, agents, teams, bindings, onChange, onDelete, onRunNode, runPending, runResult }: {
  node: RfNode;
  tools: { id: string; name: string; description?: string; parameters?: ToolParameter[] }[];
  llmConfigs: { id: string; name: string }[];
  skills: { id: string; name: string; scripts?: { filename: string; inputSchema?: Record<string, unknown> | null }[] }[];
  flows: { id: string; name: string; inputSchema?: FlowInputVar[] }[];
  agents: { id: string; name: string }[];
  teams: { id: string; name: string }[];
  bindings: BindEntry[];
  onChange: (patch: Record<string, unknown>) => void;
  onDelete: () => void;
  onRunNode: () => void;
  runPending: boolean;
  runResult: FlowRun | null;
}) {
  const { t } = useTranslation('flows');
  const type = node.type as FlowNodeType;
  const d = node.data as any;
  const s = NODE_STYLE[type];
  const typeLabel = t(`nodeType.${type}.label`);
  const selScripts = skills.find((sk) => sk.id === d.skillId)?.scripts ?? [];

  // Schema of the parameters declared by the selected resource (empty if n/a or not chosen).
  const inputSchema: InputField[] =
    type === 'tool'  ? toolSchema(tools.find((tl) => tl.id === d.toolId)?.parameters) :
    type === 'skill' ? skillSchema(selScripts.find((sc) => sc.filename === d.scriptFilename)?.inputSchema) :
    type === 'flow'  ? flowSchema(flows.find((f) => f.id === d.flowId)?.inputSchema) :
    [];

  // Additive pre-population: guarantees a key for every declared parameter
  // (never deletes, guards on the diff to avoid update-loops and spurious dirty).
  useEffect(() => {
    if (!inputSchema.length) return;
    const cur = (d.inputs ?? {}) as Record<string, string>;
    const missing = inputSchema.filter((f) => !(f.name in cur));
    if (!missing.length) return;
    const merged = { ...cur };
    for (const f of missing) merged[f.name] = '';
    onChange({ inputs: merged });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.toolId, d.skillId, d.scriptFilename, d.flowId]);

  return (
    <div className="w-full md:w-80 md:flex-shrink-0 border border-gray-800 rounded-xl p-4 bg-gray-900/60 max-h-[64vh] overflow-y-auto">
      <div className="flex items-center justify-between mb-3">
        <span className={`text-xs px-2 py-0.5 rounded ${s.bg} border ${s.ring} text-gray-200`}>{typeLabel}</span>
        <button onClick={onDelete} className="text-gray-500 hover:text-red-400" title={t('node.deleteNode')}><Trash2 size={14} /></button>
      </div>

      <button type="button" onClick={onRunNode} disabled={runPending}
        title={t('node.runNodeTitle')}
        className="w-full mb-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs rounded-lg border border-emerald-800 bg-emerald-900/30 text-emerald-300 hover:bg-emerald-900/50 disabled:opacity-50">
        {runPending ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} {t('node.runUntilHere')}
      </button>
      {runResult?.state?.nodes?.[node.id] && (
        <p className={`text-[11px] mb-1 ${runResult.state.nodes[node.id].status === 'ok' ? 'text-emerald-400' : 'text-red-400'}`}>
          {runResult.state.nodes[node.id].status === 'ok'
            ? t('node.runOk')
            : `✗ ${runResult.state.nodes[node.id].error ?? t('node.runErrFallback')}`}
        </p>
      )}

      <Lbl>{t('node.label')}</Lbl>
      <Inp value={d.label ?? ''} onChange={(v) => onChange({ label: v })} placeholder={typeLabel} />

      {type === 'tool' && (
        <>
          <Lbl>Tool</Lbl>
          <Sel value={d.toolId ?? ''} onChange={(v) => onChange({ toolId: v })} options={tools.map((tl) => ({ value: tl.id, label: tl.name }))} />
          <Lbl>{t('node.inputArgBinding')}</Lbl>
          <SchemaInputForm schema={inputSchema} value={d.inputs ?? {}} onChange={(inputs) => onChange({ inputs })} bindings={bindings} />
        </>
      )}

      {type === 'http' && (
        <>
          <Lbl>{t('node.method')}</Lbl>
          <Sel value={d.method ?? 'GET'} onChange={(v) => onChange({ method: v as HttpMethod })}
            options={['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => ({ value: m, label: m }))} />
          <Lbl>URL</Lbl>
          <BindInp value={d.url ?? ''} onChange={(v) => onChange({ url: v })} bindings={bindings} placeholder="https://api.esempio.it/{{ input.id }}" />
          <Lbl>{t('node.header')}</Lbl>
          <KvEditor value={d.headers ?? {}} onChange={(headers) => onChange({ headers })} bindings={bindings} />
          {d.method !== 'GET' && (
            <>
              <Lbl>{t('node.body')}</Lbl>
              <BindTxt value={d.body ?? ''} onChange={(v) => onChange({ body: v })} rows={3} bindings={bindings} placeholder={'{"q": "{{ input.q }}"}'} />
            </>
          )}
          <Lbl>{t('node.responsePath')}</Lbl>
          <Inp value={d.responsePath ?? ''} onChange={(v) => onChange({ responsePath: v })} placeholder="data.0.id" />
        </>
      )}

      {type === 'skill' && (
        <>
          <Lbl>Skill</Lbl>
          <Sel value={d.skillId ?? ''} onChange={(v) => onChange({ skillId: v, scriptFilename: '' })} options={skills.map((sk) => ({ value: sk.id, label: sk.name }))} />
          <Lbl>{t('node.script')}</Lbl>
          <Sel value={d.scriptFilename ?? ''} onChange={(v) => onChange({ scriptFilename: v })} options={selScripts.map((sc) => ({ value: sc.filename, label: sc.filename }))} />
          <Lbl>{t('node.inputArgBinding')}</Lbl>
          <SchemaInputForm schema={inputSchema} value={d.inputs ?? {}} onChange={(inputs) => onChange({ inputs })} bindings={bindings} />
        </>
      )}

      {type === 'transform' && (
        <>
          <Lbl>{t('node.inputKeyBinding')}</Lbl>
          <KvEditor value={d.inputs ?? {}} onChange={(inputs) => onChange({ inputs })} bindings={bindings} />
          <Lbl>{t('node.jsCodePre')} <code className="text-gray-400">input</code>{t('node.jsCodeMid')} <code className="text-gray-400">return</code> {t('node.jsCodePost')}</Lbl>
          <Txt value={d.code ?? ''} onChange={(v) => onChange({ code: v })} rows={6} placeholder={'return input.rows.filter(r => r.active)'} />
          <p className="text-[11px] text-gray-600 mt-1">{t('node.sandboxNotePre')} <code className="text-gray-400">return</code> {t('node.sandboxNotePost')}</p>
        </>
      )}

      {type === 'flow' && (
        <>
          <Lbl>{t('node.subFlow')}</Lbl>
          <Sel value={d.flowId ?? ''} onChange={(v) => onChange({ flowId: v })} options={flows.map((f) => ({ value: f.id, label: f.name }))} />
          <Lbl>{t('node.subFlowInput')}</Lbl>
          <SchemaInputForm schema={inputSchema} value={d.inputs ?? {}} onChange={(inputs) => onChange({ inputs })} bindings={bindings} />
          <p className="text-[11px] text-gray-600 mt-1">{t('node.subFlowNotePre')} <code className="text-gray-400">nodeId → output</code> {t('node.subFlowNotePost')}</p>
        </>
      )}

      {type === 'agent' && (
        <>
          <Lbl>{t('node.agent')}</Lbl>
          <Sel value={d.agentId ?? ''} onChange={(v) => onChange({ agentId: v })} options={agents.map((a) => ({ value: a.id, label: a.name }))} />
          <Lbl>{t('node.agentInput')}</Lbl>
          <BindInp value={d.input ?? ''} onChange={(v) => onChange({ input: v })} bindings={bindings} placeholder={'{{ input.request }}'} />
        </>
      )}

      {type === 'team' && (
        <>
          <Lbl>{t('node.team')}</Lbl>
          <Sel value={d.teamId ?? ''} onChange={(v) => onChange({ teamId: v })} options={teams.map((tm) => ({ value: tm.id, label: tm.name }))} />
          <Lbl>{t('node.teamInput')}</Lbl>
          <BindInp value={d.input ?? ''} onChange={(v) => onChange({ input: v })} bindings={bindings} placeholder={'{{ input.request }}'} />
        </>
      )}

      {type === 'loop' && (
        <>
          <Lbl>{t('node.loopArray')}</Lbl>
          <BindInp value={d.over ?? ''} onChange={(v) => onChange({ over: v })} bindings={bindings} placeholder={'{{ nodes.x.output.righe }}'} />
          <Lbl>{t('node.loopSubFlow')}</Lbl>
          <Sel value={d.flowId ?? ''} onChange={(v) => onChange({ flowId: v })} options={flows.map((f) => ({ value: f.id, label: f.name }))} />
          <Lbl>{t('node.loopItemVar')}</Lbl>
          <Inp value={d.itemVar ?? 'item'} onChange={(v) => onChange({ itemVar: v })} placeholder="item" />
          <p className="text-[11px] text-gray-600 mt-1">{t('node.loopNote')}</p>
        </>
      )}

      {type === 'join' && (
        <p className="text-[11px] text-gray-600 mt-2">{t('node.joinNotePre')} <code className="text-gray-400">{'{ nodeId: output }'}</code>.</p>
      )}

      {type === 'chat' && (
        <>
          <Lbl>{t('node.message')}</Lbl>
          <BindTxt value={d.message ?? ''} onChange={(v) => onChange({ message: v })} rows={4} bindings={bindings}
            placeholder={'{{ nodes.llm.output }}'} />
          <Lbl>{t('node.chatTitle')}</Lbl>
          <Inp value={d.chatTitle ?? ''} onChange={(v) => onChange({ chatTitle: v })} placeholder={t('node.chatTitlePlaceholder')} />
          <p className="text-[11px] text-gray-600 mt-1">{t('node.chatNotePre')} <code className="text-gray-400">{'{ chatId }'}</code>.</p>
        </>
      )}

      {type === 'llm' && (
        <>
          <Lbl>{t('node.model')}</Lbl>
          <Sel value={d.llmConfigId ?? ''} onChange={(v) => onChange({ llmConfigId: v || undefined })}
            options={[{ value: '', label: t('node.defaultModel') }, ...llmConfigs.map((c) => ({ value: c.id, label: c.name }))]} />
          <Lbl>{t('node.systemPrompt')}</Lbl>
          <BindTxt value={d.systemPrompt ?? ''} onChange={(v) => onChange({ systemPrompt: v })} rows={3} bindings={bindings} />
          <Lbl>{t('node.userPrompt')}</Lbl>
          <BindTxt value={d.userPrompt ?? ''} onChange={(v) => onChange({ userPrompt: v })} rows={4} bindings={bindings}
            placeholder={'Riassumi: {{ nodes.estrai.output }}'} />
        </>
      )}

      {type === 'condition' && (
        <>
          <Lbl>{t('node.condLeft')}</Lbl>
          <BindInp value={d.left ?? ''} onChange={(v) => onChange({ left: v })} bindings={bindings} placeholder={'{{ nodes.id.output.count }}'} />
          <Lbl>{t('node.condOp')}</Lbl>
          <Sel value={d.op ?? 'truthy'} onChange={(v) => onChange({ op: v as ConditionOp })}
            options={['truthy', 'falsy', 'eq', 'ne', 'gt', 'lt', 'gte', 'lte', 'contains'].map((o) => ({ value: o, label: o }))} />
          {!['truthy', 'falsy'].includes(d.op ?? 'truthy') && (
            <>
              <Lbl>{t('node.condRight')}</Lbl>
              <BindInp value={d.right ?? ''} onChange={(v) => onChange({ right: v })} bindings={bindings} />
            </>
          )}
          <p className="text-[11px] text-gray-600 mt-1">{t('node.condNote')}</p>
        </>
      )}

      {/* Per-node error policy (Slice 4) */}
      <div className="mt-4 pt-3 border-t border-gray-800">
        <Lbl>{t('errorPolicy.label')}</Lbl>
        <Sel value={d.onError ?? 'stop'} onChange={(v) => onChange({ onError: v as NodeErrorPolicy })}
          options={[{ value: 'stop', label: t('errorPolicy.stop') }, { value: 'continue', label: t('errorPolicy.continue') }, { value: 'retry', label: t('errorPolicy.retry') }]} />
        {d.onError === 'retry' && (
          <div className="flex gap-2">
            <div className="flex-1"><Lbl>{t('errorPolicy.retries')}</Lbl><Inp value={String(d.retries ?? 2)} onChange={(v) => onChange({ retries: Number(v) || 0 })} /></div>
            <div className="flex-1"><Lbl>{t('errorPolicy.retryDelay')}</Lbl><Inp value={String(d.retryDelayMs ?? 0)} onChange={(v) => onChange({ retryDelayMs: Number(v) || 0 })} /></div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Flow input variables editor ───────────────────────────────────────
/** Editable list of FlowInputVar: name, type, description (for the agent), required. */
function InputVarsEditor({ value, onChange }: { value: FlowInputVar[]; onChange: (v: FlowInputVar[]) => void }) {
  const { t } = useTranslation('flows');
  const set = (i: number, patch: Partial<FlowInputVar>) => onChange(value.map((v, j) => (j === i ? { ...v, ...patch } : v)));
  const del = (i: number) => onChange(value.filter((_, j) => j !== i));
  const add = () => onChange([...value, { name: '', type: 'string', required: false }]);
  return (
    <div className="mb-3">
      <div className="flex items-center gap-2 mb-1.5 text-sm">
        <span className="text-gray-500">{t('inputVars.title')}</span>
        <span className="text-gray-600 text-xs">{t('inputVars.hintPre')} <code className="text-gray-400">{'{{ input.nome }}'}</code></span>
      </div>
      {value.length > 0 && (
        <div className="space-y-1.5">
          {value.map((v, i) => (
            <div key={i} className="flex flex-wrap items-center gap-1.5">
              <input value={v.name} onChange={(e) => set(i, { name: e.target.value })} placeholder={t('inputVars.namePlaceholder')}
                className="w-32 bg-gray-900 border border-gray-800 rounded px-2 py-1 text-xs text-gray-200" />
              <select value={v.type ?? 'string'} onChange={(e) => set(i, { type: e.target.value as FlowInputVar['type'] })}
                className="bg-gray-900 border border-gray-800 rounded px-1.5 py-1 text-xs text-gray-200">
                <option value="string">string</option>
                <option value="number">number</option>
                <option value="boolean">boolean</option>
                <option value="json">json</option>
              </select>
              <input value={v.description ?? ''} onChange={(e) => set(i, { description: e.target.value })} placeholder={t('inputVars.descPlaceholder')}
                className="flex-1 min-w-[120px] bg-gray-900 border border-gray-800 rounded px-2 py-1 text-xs text-gray-200" />
              <label className="flex items-center gap-1 text-xs text-gray-400 whitespace-nowrap" title={t('inputVars.requiredTitle')}>
                <input type="checkbox" checked={v.required ?? false} onChange={(e) => set(i, { required: e.target.checked })} /> {t('inputVars.requiredShort')}
              </label>
              <button onClick={() => del(i)} className="text-gray-600 hover:text-red-400"><X size={13} /></button>
            </div>
          ))}
        </div>
      )}
      <button onClick={add} className="text-xs text-gray-500 hover:text-gray-300 flex items-center gap-1 mt-1.5">
        <Plus size={12} /> {t('inputVars.addVar')}
      </button>
    </div>
  );
}

// ── Run modal ──────────────────────────────────────────────────────────
function RunModal({ flowId, vars, onClose }: { flowId: string; vars: FlowInputVar[]; onClose: () => void }) {
  const { t } = useTranslation('flows');
  const [values, setValues] = useState<Record<string, string>>({});
  const [result, setResult] = useState<FlowRun | null>(null);
  const [parseErr, setParseErr] = useState<string | null>(null);

  /** Coerces the form values into the declared types (json→parse, number→Number, etc.). */
  const coerce = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const v of vars) {
      const raw = values[v.name] ?? '';
      if (raw === '' && !v.required) continue;
      if (v.type === 'number') out[v.name] = raw === '' ? undefined : Number(raw);
      else if (v.type === 'boolean') out[v.name] = raw === 'true';
      else if (v.type === 'json') out[v.name] = raw === '' ? undefined : JSON.parse(raw);
      else out[v.name] = raw;
    }
    return out;
  };

  const runM = useMutation({
    mutationFn: () => flowsApi.run(flowId, coerce()),
    onSuccess: (r) => setResult(r),
  });

  const submit = () => {
    setParseErr(null);
    try { coerce(); } catch (e: any) { setParseErr(t('run.jsonInvalid', { msg: e.message })); return; }
    runM.mutate();
  };

  return (
    <Overlay onClose={onClose} title={t('run.title')}>
      {!result ? (
        <>
          {vars.length === 0 ? (
            <p className="text-sm text-gray-500 mb-4">{t('run.noVars')}</p>
          ) : vars.map((v) => (
            <div key={v.name} className="mb-3">
              <Lbl>
                {v.name}{v.required && <span className="text-red-400"> *</span>}
                {v.type && v.type !== 'string' && <span className="text-gray-600 text-[10px] ml-1">{v.type}</span>}
              </Lbl>
              {v.description && <p className="text-[11px] text-gray-600 mb-1">{v.description}</p>}
              {v.type === 'boolean' ? (
                <Sel value={values[v.name] ?? 'false'} onChange={(val) => setValues((s) => ({ ...s, [v.name]: val }))}
                  options={[{ value: 'false', label: 'false' }, { value: 'true', label: 'true' }]} />
              ) : v.type === 'json' ? (
                <Txt value={values[v.name] ?? ''} onChange={(val) => setValues((s) => ({ ...s, [v.name]: val }))} rows={3} placeholder='{"k": "v"}' />
              ) : (
                <Inp value={values[v.name] ?? ''} onChange={(val) => setValues((s) => ({ ...s, [v.name]: val }))} placeholder={v.type === 'number' ? '123' : ''} />
              )}
            </div>
          ))}
          {parseErr && <p className="text-red-400 text-sm mb-2">{parseErr}</p>}
          <button onClick={submit} disabled={runM.isPending}
            className="btn-primary px-4 py-2 text-sm flex items-center gap-2">
            {runM.isPending ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />} {t('run.start')}
          </button>
          {runM.isError && <p className="text-red-400 text-sm mt-2">{(runM.error as any)?.response?.data?.message ?? t('run.errFallback')}</p>}
        </>
      ) : (
        <RunResult run={result} onAgain={() => setResult(null)} />
      )}
    </Overlay>
  );
}

function RunResult({ run, onAgain }: { run: FlowRun; onAgain?: () => void }) {
  const { t } = useTranslation('flows');
  return (
    <div>
      <div className={`text-sm font-medium mb-3 flex items-center gap-2 ${run.status === 'completed' ? 'text-emerald-400' : 'text-red-400'}`}>
        {run.status === 'completed' ? <CheckCircle2 size={16} /> : <XCircle size={16} />} {t('run.status', { status: run.status })}
        {run.error && <span className="text-red-400 font-normal">— {run.error}</span>}
      </div>
      <div className="space-y-1.5">
        {run.nodeRuns.map((nr) => {
          const out = run.state.nodes[nr.nodeId]?.output;
          const Icon = nr.status === 'ok' ? CheckCircle2 : nr.status === 'error' ? XCircle : MinusCircle;
          const color = nr.status === 'ok' ? 'text-emerald-400' : nr.status === 'error' ? 'text-red-400' : 'text-gray-500';
          return (
            <div key={nr.nodeId} className="border border-gray-800 rounded-lg px-3 py-2 text-xs">
              <div className="flex items-center gap-2">
                <Icon size={13} className={color} />
                <span className="text-gray-300 font-medium">{nr.nodeId}</span>
                <span className="text-gray-600">{nr.type}</span>
                {nr.durationMs != null && <span className="text-gray-600 ml-auto">{nr.durationMs}ms</span>}
              </div>
              {nr.error && <div className="text-red-400 mt-1">{nr.error}</div>}
              {out != null && nr.status === 'ok' && (
                <pre className="text-gray-400 mt-1 whitespace-pre-wrap break-words max-h-32 overflow-y-auto">
                  {typeof out === 'string' ? out : JSON.stringify(out, null, 2)}
                </pre>
              )}
            </div>
          );
        })}
      </div>
      {onAgain && <button onClick={onAgain} className="mt-4 text-sm text-gray-400 hover:text-white">{t('run.again')}</button>}
    </div>
  );
}

// ── Run history modal ─────────────────────────────────────────────────────────
function RunsModal({ flowId, onClose }: { flowId: string; onClose: () => void }) {
  const { t } = useTranslation('flows');
  const q = useQuery({ queryKey: ['flow-runs', flowId], queryFn: () => flowsApi.runs(flowId) });
  const [open, setOpen] = useState<FlowRun | null>(null);
  return (
    <Overlay onClose={onClose} title={t('runs.title')}>
      {q.isLoading ? <Loader2 className="animate-spin" size={18} /> :
        open ? <><button onClick={() => setOpen(null)} className="text-sm text-gray-400 mb-3 flex items-center gap-1"><ArrowLeft size={14} /> {t('runs.back')}</button><RunResult run={open} /></> :
        (q.data ?? []).length === 0 ? <p className="text-sm text-gray-500">{t('runs.empty')}</p> : (
          <div className="space-y-1.5">
            {(q.data ?? []).map((r) => (
              <button key={r.id} onClick={() => setOpen(r)}
                className="w-full text-left border border-gray-800 rounded-lg px-3 py-2 text-xs hover:border-gray-700 flex items-center gap-2">
                {r.status === 'completed' ? <CheckCircle2 size={13} className="text-emerald-400" /> : <XCircle size={13} className="text-red-400" />}
                <span className="text-gray-300">{new Date(r.startedAt).toLocaleString()}</span>
                <span className="text-gray-600 ml-auto">{r.triggeredBy}</span>
              </button>
            ))}
          </div>
        )}
    </Overlay>
  );
}

// ── Cron generator ───────────────────────────────────────────────────────────
type CronFreq = 'minute' | 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'custom';
const DOW: [string, string][] = [['1', 'Lun'], ['2', 'Mar'], ['3', 'Mer'], ['4', 'Gio'], ['5', 'Ven'], ['6', 'Sab'], ['0', 'Dom']];

function parseCron(cron: string): { freq: CronFreq; minute: number; hour: number; dow: string } {
  const def = { freq: 'daily' as CronFreq, minute: 0, hour: 8, dow: '1' };
  const p = (cron || '').trim().split(/\s+/);
  if (p.length !== 5) return cron ? { ...def, freq: 'custom' } : def;
  const [m, h, dom, mon, dw] = p;
  const num = (s: string) => (/^\d+$/.test(s) ? Number(s) : NaN);
  if (m === '*' && h === '*' && dom === '*' && mon === '*' && dw === '*') return { ...def, freq: 'minute' };
  if (h === '*' && dom === '*' && mon === '*' && dw === '*' && !isNaN(num(m))) return { ...def, freq: 'hourly', minute: num(m) };
  if (dom === '*' && mon === '*' && !isNaN(num(m)) && !isNaN(num(h))) {
    if (dw === '*') return { ...def, freq: 'daily', minute: num(m), hour: num(h) };
    if (dw === '1-5') return { ...def, freq: 'weekdays', minute: num(m), hour: num(h) };
    if (!isNaN(num(dw))) return { ...def, freq: 'weekly', minute: num(m), hour: num(h), dow: dw };
  }
  return { ...def, freq: 'custom' };
}
function buildCron(freq: CronFreq, s: { minute: number; hour: number; dow: string }): string {
  switch (freq) {
    case 'minute': return '* * * * *';
    case 'hourly': return `${s.minute} * * * *`;
    case 'daily': return `${s.minute} ${s.hour} * * *`;
    case 'weekdays': return `${s.minute} ${s.hour} * * 1-5`;
    case 'weekly': return `${s.minute} ${s.hour} * * ${s.dow}`;
    default: return '';
  }
}

/** Visual cron generator (frequency + time/day) — no hand-written cron syntax. */
function CronBuilder({ value, onChange }: { value: string; onChange: (cron: string) => void }) {
  const { t } = useTranslation('flows');
  const init = useMemo(() => parseCron(value), []); // only at mount
  const [freq, setFreq] = useState<CronFreq>(init.freq);
  const [minute, setMinute] = useState(init.minute);
  const [hour, setHour] = useState(init.hour);
  const [dow, setDow] = useState(init.dow);
  const [raw, setRaw] = useState(value || '');

  const emit = (f: CronFreq, st: { minute: number; hour: number; dow: string }, rawVal: string) =>
    onChange(f === 'custom' ? rawVal : buildCron(f, st));
  const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  const setTime = (t: string) => {
    const [h, m] = t.split(':').map((x) => Number(x) || 0);
    setHour(h); setMinute(m); emit(freq, { minute: m, hour: h, dow }, raw);
  };
  const sel = 'bg-gray-900 border border-gray-800 rounded-lg px-2 py-1.5 text-sm text-gray-200';

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <select value={freq} onChange={(e) => { const f = e.target.value as CronFreq; setFreq(f); emit(f, { minute, hour, dow }, raw); }} className={sel}>
        <option value="minute">{t('cron.minute')}</option>
        <option value="hourly">{t('cron.hourly')}</option>
        <option value="daily">{t('cron.daily')}</option>
        <option value="weekdays">{t('cron.weekdays')}</option>
        <option value="weekly">{t('cron.weekly')}</option>
        <option value="custom">{t('cron.custom')}</option>
      </select>
      {freq === 'hourly' && (
        <label className="text-xs text-gray-500 flex items-center gap-1">{t('cron.atMinute')}
          <input type="number" min={0} max={59} value={minute}
            onChange={(e) => { const m = Math.min(59, Math.max(0, Number(e.target.value) || 0)); setMinute(m); emit(freq, { minute: m, hour, dow }, raw); }}
            className={`${sel} w-16`} />
        </label>
      )}
      {(freq === 'daily' || freq === 'weekdays' || freq === 'weekly') && (
        <label className="text-xs text-gray-500 flex items-center gap-1">{t('cron.at')}
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={sel} />
        </label>
      )}
      {freq === 'weekly' && (
        <select value={dow} onChange={(e) => { setDow(e.target.value); emit(freq, { minute, hour, dow: e.target.value }, raw); }} className={sel}>
          {DOW.map(([v]) => <option key={v} value={v}>{t(`cron.dow.${v}`)}</option>)}
        </select>
      )}
      {freq === 'custom' && (
        <input value={raw} onChange={(e) => { setRaw(e.target.value); onChange(e.target.value); }} placeholder="* * * * *" className={`${sel} font-mono text-xs w-44`} />
      )}
      <code className="text-[11px] text-gray-500 font-mono">{freq === 'custom' ? (raw || '—') : buildCron(freq, { minute, hour, dow })}</code>
    </div>
  );
}

// ── Primitive UI ───────────────────────────────────────────────────────────────
function Overlay({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 w-full max-w-lg max-h-[calc(100dvh-2rem)] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-white font-semibold">{title}</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-white"><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}
function Lbl({ children }: { children: React.ReactNode }) {
  return <label className="block text-xs text-gray-500 mb-1 mt-3 first:mt-0">{children}</label>;
}
function Inp({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
    className="w-full bg-gray-900 border border-gray-800 rounded-lg px-2.5 py-1.5 text-sm text-gray-200" />;
}
function Txt({ value, onChange, rows, placeholder }: { value: string; onChange: (v: string) => void; rows?: number; placeholder?: string }) {
  return <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={rows ?? 3} placeholder={placeholder}
    className="w-full bg-gray-900 border border-gray-800 rounded-lg px-2.5 py-1.5 text-sm text-gray-200 mb-2 font-mono text-xs" />;
}
function Sel({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  const { t } = useTranslation('flows');
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}
      className="w-full bg-gray-900 border border-gray-800 rounded-lg px-2 py-1.5 text-sm text-gray-200 mb-3">
      {!options.some((o) => o.value === '') && <option value="">{t('bind.choose')}</option>}
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}
// ── Layered binding picker (predecessors + real output of last run) ──────────
/** Picker entry: a bindable path, with source group, indentation and preview. */
interface BindEntry { path: string; label: string; group: string; depth: number; preview?: string }

/** Transitive predecessors of `target`, walking up the edges (what is upstream). */
function predecessorsOf(target: string, edges: RfEdge[]): Set<string> {
  const incoming = new Map<string, string[]>();
  for (const e of edges) {
    const arr = incoming.get(e.target) ?? [];
    arr.push(e.source);
    incoming.set(e.target, arr);
  }
  const seen = new Set<string>();
  const stack = [...(incoming.get(target) ?? [])];
  while (stack.length) {
    const n = stack.pop()!;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const p of incoming.get(n) ?? []) stack.push(p);
  }
  return seen;
}

/** Compact preview of a real value (to display alongside the path in the picker). */
function previewOf(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (v === null) return 'null';
  if (typeof v === 'string') return JSON.stringify(v.length > 32 ? v.slice(0, 32) + '…' : v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.length}]`;
  if (typeof v === 'object') {
    const k = Object.keys(v as object);
    return `{${k.slice(0, 3).join(', ')}${k.length > 3 ? ', …' : ''}}`;
  }
  return undefined;
}

/** Recursively expands a real output into navigable paths (limited depth/count). */
function flattenPaths(value: unknown, base: string, group: string, depth: number, maxDepth: number, acc: BindEntry[]): void {
  if (depth > maxDepth || acc.length > 200) return;
  const visit = (key: string, label: string, item: unknown) => {
    const path = `${base}.${key}`;
    acc.push({ group, path, label, depth, preview: previewOf(item) });
    if (item && typeof item === 'object') flattenPaths(item, path, group, depth + 1, maxDepth, acc);
  };
  if (Array.isArray(value)) value.slice(0, 5).forEach((item, i) => visit(String(i), `[${i}]`, item));
  else if (value && typeof value === 'object')
    Object.entries(value as Record<string, unknown>).slice(0, 20).forEach(([k, item]) => visit(k, k, item));
}

/**
 * Builds the picker entries for the selected node:
 *  - start variables (`input.<var>`)
 *  - ONLY the upstream nodes (transitive predecessors); if the node is not yet connected,
 *    fall back to all other nodes so the picker stays usable while building.
 * For each node: the root `nodes.<id>.output` + (if there is a last run) the tree of
 * real fields with a value preview.
 */
function buildBindings(selectedId: string, nodes: RfNode[], edges: RfEdge[], inputVars: string[], lastRun: FlowRun | null): BindEntry[] {
  const out: BindEntry[] = [];
  for (const v of inputVars) out.push({ group: 'input', path: `input.${v}`, label: v, depth: 0 });

  const preds = predecessorsOf(selectedId, edges);
  const others = nodes.filter((n) => n.id !== selectedId);
  const usable = preds.size ? others.filter((n) => preds.has(n.id)) : others;

  // Output type known statically for some nodes → hint even before the first run.
  const typeHint: Record<string, string> = { llm: 'string', condition: 'boolean' };

  for (const n of usable) {
    const group = (n.data?.label as string) || n.id;
    const root = `nodes.${n.id}.output`;
    const sample = lastRun?.state?.nodes?.[n.id]?.output;
    out.push({ group, path: root, label: 'output', depth: 0, preview: previewOf(sample) ?? typeHint[n.type ?? ''] });
    if (sample && typeof sample === 'object') flattenPaths(sample, root, group, 1, 4, out);
  }
  return out;
}

// ── Declared input schema (tool/skill/sub-flow) ─────────────────────────────
/** Input parameter normalized from the three sources (tool params / skill JSON-schema / flow inputVar). */
interface InputField { name: string; type?: string; description?: string; required?: boolean }

/** Custom tool → InputField[] (direct map of the ToolParameter). */
function toolSchema(parameters?: ToolParameter[]): InputField[] {
  return (parameters ?? []).map((p) => ({ name: p.name, type: p.type, description: p.description, required: p.required }));
}
/** Skill script inputSchema (JSON-schema { properties, required }) → InputField[]. */
function skillSchema(inputSchema?: Record<string, unknown> | null): InputField[] {
  const props = (inputSchema?.properties ?? {}) as Record<string, { type?: string; description?: string }>;
  const required = (inputSchema?.required ?? []) as string[];
  return Object.entries(props).map(([name, p]) => ({
    name, type: p?.type, description: p?.description, required: required.includes(name),
  }));
}
/** Sub-flow inputSchema (FlowInputVar[]) → InputField[]. */
function flowSchema(inputSchema?: FlowInputVar[]): InputField[] {
  return (inputSchema ?? []).map((v) => ({ name: v.name, type: v.type, description: v.description, required: v.required }));
}

/**
 * Schema-driven input form: one fixed row for each declared parameter (locked
 * name + description + required badge), editable binding on the right. Keys
 * present in `value` but not declared end up in the "extra" section (free KvEditor,
 * for advanced uses like SQL free-query). If the schema is empty → fall back to the KvEditor.
 */
function SchemaInputForm({ schema, value, onChange, bindings }: {
  schema: InputField[];
  value: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
  bindings: BindEntry[];
}) {
  const { t } = useTranslation('flows');
  if (!schema.length) return <KvEditor value={value} onChange={onChange} bindings={bindings} />;

  const declared = new Set(schema.map((f) => f.name));
  const extras = Object.fromEntries(Object.entries(value).filter(([k]) => !declared.has(k)));
  const setField = (name: string, v: string) => onChange({ ...value, [name]: v });
  const setExtras = (ex: Record<string, string>) => {
    const kept = Object.fromEntries(Object.entries(value).filter(([k]) => declared.has(k)));
    onChange({ ...kept, ...ex });
  };

  return (
    <div className="space-y-2">
      {schema.map((f) => (
        <div key={f.name}>
          <div className="flex items-center gap-1.5 mb-0.5">
            <code className="text-xs font-mono text-gray-300">{f.name}</code>
            {f.type && <span className="text-[10px] text-gray-600">{f.type}</span>}
            {f.required && <span className="text-[10px] px-1 rounded bg-red-500/15 text-red-300 border border-red-500/30">{t('bind.requiredShort')}</span>}
          </div>
          {f.description && <p className="text-[11px] text-gray-600 mb-1 leading-snug">{f.description}</p>}
          <BindInp value={value[f.name] ?? ''} onChange={(v) => setField(f.name, v)} bindings={bindings}
            placeholder={f.required ? '{{ input.x }}' : t('bind.optional')} />
        </div>
      ))}
      {Object.keys(extras).length > 0 && (
        <div className="pt-1 border-t border-gray-800">
          <p className="text-[11px] text-gray-600 mb-1">{t('bind.extraParams')}</p>
          <KvEditor value={extras} onChange={setExtras} bindings={bindings} />
        </div>
      )}
    </div>
  );
}

/**
 * Dropdown that inserts a binding token `{{ path }}`. Entries grouped by
 * source (input / upstream node), indented by depth, with a preview of the
 * real value from the last run. Text filter when there are many entries.
 */
function BindPicker({ bindings, onPick }: { bindings: BindEntry[]; onPick: (token: string) => void }) {
  const { t } = useTranslation('flows');
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  if (!bindings.length) return null;
  const ql = q.trim().toLowerCase();
  const filtered = ql ? bindings.filter((b) => b.path.toLowerCase().includes(ql)) : bindings;
  return (
    <div className="relative flex-shrink-0">
      <button type="button" title={t('bind.insert')} onClick={() => setOpen((o) => !o)}
        className="px-1.5 py-1 rounded border border-gray-700 text-gray-400 hover:text-gray-200"><Braces size={12} /></button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-72 max-h-72 overflow-y-auto bg-gray-900 border border-gray-700 rounded-lg shadow-xl py-1">
          {bindings.length > 8 && (
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('bind.filter')}
              className="w-[calc(100%-0.5rem)] mx-1 mb-1 bg-gray-950 border border-gray-800 rounded px-2 py-1 text-[11px] text-gray-200" />
          )}
          {filtered.length === 0 && <div className="px-2 py-1 text-[11px] text-gray-600">{t('bind.none')}</div>}
          {filtered.map((b, i) => (
            <div key={b.path}>
              {(i === 0 || filtered[i - 1].group !== b.group) && (
                <div className="px-2 pt-1.5 pb-0.5 text-[10px] uppercase tracking-wide text-gray-600 truncate">{b.group}</div>
              )}
              <button type="button" onClick={() => { onPick(`{{ ${b.path} }}`); setOpen(false); }}
                className="w-full flex items-center gap-2 px-2 py-1 hover:bg-gray-800">
                <span style={{ paddingLeft: b.depth * 10 }} className="text-[11px] font-mono text-gray-300 truncate">{b.label}</span>
                {b.preview != null && <span className="ml-auto text-[10px] text-gray-600 font-mono truncate max-w-[45%]">{b.preview}</span>}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
function BindInp({ value, onChange, bindings, placeholder }: { value: string; onChange: (v: string) => void; bindings: BindEntry[]; placeholder?: string }) {
  return (
    <div className="flex items-center gap-1 mb-1">
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        className="flex-1 bg-gray-900 border border-gray-800 rounded-lg px-2.5 py-1.5 text-sm text-gray-200" />
      <BindPicker bindings={bindings} onPick={(tok) => onChange((value ?? '') + tok)} />
    </div>
  );
}
function BindTxt({ value, onChange, rows, bindings, placeholder }: { value: string; onChange: (v: string) => void; rows?: number; bindings: BindEntry[]; placeholder?: string }) {
  return (
    <div className="mb-2">
      <div className="flex justify-end mb-1"><BindPicker bindings={bindings} onPick={(tok) => onChange((value ?? '') + tok)} /></div>
      <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={rows ?? 3} placeholder={placeholder}
        className="w-full bg-gray-900 border border-gray-800 rounded-lg px-2.5 py-1.5 text-sm text-gray-200 font-mono text-xs" />
    </div>
  );
}
function KvEditor({ value, onChange, bindings }: { value: Record<string, string>; onChange: (v: Record<string, string>) => void; bindings?: BindEntry[] }) {
  const { t } = useTranslation('flows');
  const entries = Object.entries(value);
  const setKey = (i: number, k: string) => {
    const e = [...entries]; e[i] = [k, e[i][1]]; onChange(Object.fromEntries(e));
  };
  const setVal = (i: number, v: string) => {
    const e = [...entries]; e[i] = [e[i][0], v]; onChange(Object.fromEntries(e));
  };
  const del = (i: number) => { const e = entries.filter((_, j) => j !== i); onChange(Object.fromEntries(e)); };
  return (
    <div className="space-y-1.5">
      {entries.map(([k, v], i) => (
        <div key={i} className="flex items-center gap-1">
          <input value={k} onChange={(e) => setKey(i, e.target.value)} placeholder="arg"
            className="w-24 bg-gray-900 border border-gray-800 rounded px-2 py-1 text-xs text-gray-200" />
          <input value={v} onChange={(e) => setVal(i, e.target.value)} placeholder="{{ input.x }}"
            className="flex-1 bg-gray-900 border border-gray-800 rounded px-2 py-1 text-xs text-gray-200" />
          {bindings && <BindPicker bindings={bindings} onPick={(tok) => setVal(i, (v ?? '') + tok)} />}
          <button onClick={() => del(i)} className="text-gray-600 hover:text-red-400"><X size={13} /></button>
        </div>
      ))}
      <button onClick={() => onChange({ ...value, '': '' })} className="text-xs text-gray-500 hover:text-gray-300 flex items-center gap-1">
        <Plus size={12} /> {t('bind.addArg')}
      </button>
    </div>
  );
}
