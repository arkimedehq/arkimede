/**
 * Cross-provider tool-call replay — reconstructing the history
 *   AIMessage(tool_calls) → ToolMessage(result) × N → AIMessage(text)
 * must produce a VALID payload (tool-call ↔ tool-result paired) for ALL
 * providers, and trimMessages(startOn:'human') must never break a pair.
 * Migrated from scripts/smoke-toolcall-replay.ts — pure logic (SDK converters),
 * no DB/network: it is a unit test, NOT integration.
 *
 * NB: uses langchain internal paths (dist/utils/…) — the same ones the
 * providers actually use. Absolute path via createRequire to bypass the
 * packages' "exports" map (the dist subpaths are not exported).
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { AIMessage, BaseMessage, HumanMessage, ToolMessage, trimMessages } from '@langchain/core/messages';

const require = createRequire(import.meta.url);
const dep = (rel: string) => require(join(process.cwd(), 'node_modules', rel));
const { _convertMessagesToAnthropicPayload } = dep('@langchain/anthropic/dist/utils/message_inputs.js');
const { convertMessagesToCompletionsMessageParams } = dep('@langchain/openai/dist/converters/completions.js');
const { convertToOllamaMessages } = dep('@langchain/ollama/dist/utils.js');
const { convertBaseMessagesToContent } = dep('@langchain/google-genai/dist/utils/common.js');

type ToolCallRecord = { name: string; input: any; output?: any };
type Msg = { id: string; role: 'user' | 'assistant'; content: string; toolCalls?: ToolCallRecord[] | null };

/** Exact replica of the assistant branch of buildMessages (agent.service.ts). */
function reconstruct(history: Msg[]): BaseMessage[] {
  const out: BaseMessage[] = [];
  for (const msg of history) {
    if (msg.role === 'user') { out.push(new HumanMessage(msg.content)); continue; }
    if (msg.toolCalls?.length) {
      const calls = msg.toolCalls.map((tc, i) => ({
        type: 'tool_call' as const, id: `call_${msg.id}_${i}`,
        name: tc.name || 'tool', args: tc.input && typeof tc.input === 'object' ? tc.input : {},
      }));
      out.push(new AIMessage({ content: '', tool_calls: calls }));
      calls.forEach((c, i) => {
        const o = msg.toolCalls![i].output;
        const content = o == null ? '(nessun risultato)' : (typeof o === 'string' ? o : JSON.stringify(o));
        out.push(new ToolMessage({ content, tool_call_id: c.id, name: c.name }));
      });
      if (msg.content?.trim()) out.push(new AIMessage({ content: msg.content }));
    } else { out.push(new AIMessage({ content: msg.content })); }
  }
  return out;
}

// Severe scenario: 1 tool on one turn + 2 tools on the next turn (multi-tool).
const history: Msg[] = [
  { id: 'm1', role: 'user', content: 'Tra 3 minuti controlla la mail e riassumi le ultime 5 email' },
  { id: 'm2', role: 'assistant', content: 'Ho preparato l’automazione. Confermi?',
    toolCalls: [{ name: 'schedule_task', input: { instruction: 'controlla la mail' }, output: 'PREPARATA — id=abc-123' }] },
  { id: 'm3', role: 'user', content: 'si, e intanto che ore sono a Tokyo?' },
  { id: 'm4', role: 'assistant', content: 'Automazione attivata. A Tokyo sono le 01:54.',
    toolCalls: [
      { name: 'confirm_scheduled_task', input: { taskId: 'abc-123', confirm: true }, output: 'ATTIVATA' },
      { name: 'get_current_datetime', input: { timezone: 'Asia/Tokyo' }, output: '2026-06-09T01:54:00+09:00' },
    ] },
  { id: 'm5', role: 'user', content: 'grazie' },
];

const msgs = reconstruct(history);

describe('replay tool-call → payload accoppiato per provider', () => {
  it('Anthropic: tool_use ↔ tool_result accoppiati (3+3)', () => {
    const payload = _convertMessagesToAnthropicPayload(msgs);
    const use: string[] = [], result: string[] = [];
    for (const m of payload.messages as any[]) {
      for (const b of (Array.isArray(m.content) ? m.content : [])) {
        if (b.type === 'tool_use') use.push(b.id);
        if (b.type === 'tool_result') result.push(b.tool_use_id);
      }
    }
    expect(use).toHaveLength(3);
    expect(result).toHaveLength(3);
    expect(use.every((id) => result.includes(id))).toBe(true);
  });

  it('OpenAI / compatible: assistant.tool_calls ↔ role:tool con id combacianti (3+3)', () => {
    const params = convertMessagesToCompletionsMessageParams({ messages: msgs, model: 'gpt-4o' });
    const callIds: string[] = [], toolIds: string[] = [];
    for (const m of params as any[]) {
      if (m.role === 'assistant' && Array.isArray(m.tool_calls)) for (const tc of m.tool_calls) callIds.push(tc.id);
      if (m.role === 'tool') toolIds.push(m.tool_call_id);
    }
    expect(callIds).toHaveLength(3);
    expect(toolIds).toHaveLength(3);
    expect(callIds.every((id) => toolIds.includes(id))).toBe(true);
  });

  it('Ollama: tool_calls e messaggi role:tool bilanciati (3+3)', () => {
    const om = convertToOllamaMessages(msgs) as any[];
    const nCalls = om.filter((m) => m.role === 'assistant' && m.tool_calls?.length).reduce((a, m) => a + m.tool_calls.length, 0);
    const nTool = om.filter((m) => m.role === 'tool').length;
    expect(nCalls).toBe(3);
    expect(nTool).toBe(3);
  });

  it('Gemini: functionCall ↔ functionResponse bilanciati (3+3)', () => {
    const contents = convertBaseMessagesToContent(msgs, false) as any[];
    let calls = 0, responses = 0;
    for (const c of contents) for (const p of (c.parts ?? [])) { if (p.functionCall) calls++; if (p.functionResponse) responses++; }
    expect(calls).toBe(3);
    expect(responses).toBe(3);
  });
});

describe('trimMessages(startOn:human) — nessun tool orfano a vari budget', () => {
  const est = (s: any) => Math.ceil((typeof s === 'string' ? s : JSON.stringify(s)).length / 4);
  const counter = (ms: BaseMessage[]) => ms.reduce((a, m) => a + est(m.content), 0);

  it.each([10000, 80, 30, 10])('budget=%i tok: parte da human e nessun tool orfano', async (budget) => {
    const trimmed = await trimMessages(msgs, { maxTokens: budget, tokenCounter: counter, strategy: 'last', startOn: 'human', allowPartial: false });
    if (trimmed.length) expect(trimmed[0].getType()).toBe('human');
    for (let i = 0; i < trimmed.length; i++) {
      if (trimmed[i].getType() === 'tool') {
        const prevAI = trimmed.slice(0, i).reverse().find((m) => m.getType() === 'ai' && (m as any).tool_calls?.length);
        expect(prevAI, `tool orfano a budget ${budget}`).toBeTruthy();
      }
    }
  });
});
