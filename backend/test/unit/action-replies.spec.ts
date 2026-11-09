// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Action replies (agent/action-replies.ts): which results count as a success, the gate's decisions step by step,
 * and the same decisions on a real LangGraph ReAct stream — ending on an action reply makes no second model call.
 */
import { describe, it, expect } from 'vitest';
import { AIMessage } from '@langchain/core/messages';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { z } from 'zod';
import { ActionReplyGate, actionSucceeded, isActionTool, markActionTool, withReplyArg } from '../../src/agent/action-replies';

describe('actionSucceeded', () => {
  it('reads a failure from the result, a success otherwise', () => {
    expect(actionSucceeded('{"ok":true,"entities":[]}')).toBe(true);
    expect(actionSucceeded('Slideshow started: 23 photos')).toBe(true);
    expect(actionSucceeded('{"error":"not exposed"}')).toBe(false);
    expect(actionSucceeded('{"needs_confirmation":true}')).toBe(false);
    expect(actionSucceeded('{"success":false,"error":"busy"}')).toBe(false);
    expect(actionSucceeded('{"ok":false}')).toBe(false);
    expect(actionSucceeded('MCP error: the TV did not come on')).toBe(false);
    expect(actionSucceeded('{"ok":true}', 'error')).toBe(false);
    expect(actionSucceeded([{ type: 'text', text: '{"error":"x"}' }])).toBe(false);
  });

  it('marks a tool as an action tool', () => {
    const t = markActionTool(new DynamicStructuredTool({ name: 'a', description: 'a', schema: z.object({}), func: async () => 'ok' }));
    expect(isActionTool(t)).toBe(true);
    expect(isActionTool(new DynamicStructuredTool({ name: 'b', description: 'b', schema: z.object({}), func: async () => 'ok' }))).toBe(false);
  });
});

describe('ActionReplyGate', () => {
  const actions = new Set(['light_on', 'show']);

  it('ends a step of successful actions on the reply written with them', () => {
    const g = new ActionReplyGate(actions);
    g.modelChunk(); g.text('Fatto, '); g.text('luce accesa'); g.toolCall('c1'); g.toolCall('c2');
    expect(g.toolResult('c1', 'light_on', '{"ok":true}')).toBeNull();
    expect(g.toolResult('c2', 'show', 'shown')).toEqual({ reply: 'Fatto, luce accesa' });
  });

  it('goes on when an action fails, a read tool ran or no reply was written — and drops the held text', () => {
    const failed = new ActionReplyGate(actions);
    failed.modelChunk(); failed.text('Fatto'); failed.toolCall('c1');
    expect(failed.toolResult('c1', 'light_on', '{"error":"not exposed"}')).toBeNull();
    failed.modelChunk(); failed.text('Non trovo quella luce.');
    expect(failed.flush()).toBe('Non trovo quella luce.');

    const read = new ActionReplyGate(actions);
    read.modelChunk(); read.text('Cerco…'); read.toolCall('c1'); read.toolCall('c2');
    read.toolResult('c1', 'light_on', '{"ok":true}');
    expect(read.toolResult('c2', 'search', '[...]')).toBeNull();
    read.modelChunk(); read.text('Ecco.');
    expect(read.flush()).toBe('Ecco.');

    const silent = new ActionReplyGate(actions);
    silent.modelChunk(); silent.toolCall('c1');
    expect(silent.toolResult('c1', 'light_on', '{"ok":true}')).toBeNull();
  });

  it('takes the reply from the calls\' reply argument, for models that write no text with a call', () => {
    const g = new ActionReplyGate(actions);
    g.modelChunk(); g.toolCall('c1'); g.toolCall('c2');
    expect(g.toolResult('c1', 'light_on', '{"ok":true}', undefined, { name: 'cucina', reply: 'Fatto, luce accesa.' })).toBeNull();
    expect(g.toolResult('c2', 'show', 'shown', undefined, { reply: 'Fatto, luce accesa.' })).toEqual({ reply: 'Fatto, luce accesa.' });
    const two = new ActionReplyGate(actions);
    two.modelChunk(); two.toolCall('c1'); two.toolCall('c2');
    two.toolResult('c1', 'light_on', '{"ok":true}', undefined, { reply: 'Fatto, luci in sala spente' });
    expect(two.toolResult('c2', 'light_on', '{"ok":true}', undefined, { reply: 'luce del corridoio accesa' }))
      .toEqual({ reply: 'Fatto, luci in sala spente. luce del corridoio accesa.' });
    const failed = new ActionReplyGate(actions);
    failed.modelChunk(); failed.toolCall('c1');
    expect(failed.toolResult('c1', 'light_on', '{"error":"x"}', undefined, { reply: 'Fatto.' })).toBeNull();
  });

  it('withReplyArg adds the reply argument and removes it before the tool runs', async () => {
    const seen: any[] = [];
    const tool = markActionTool(new DynamicStructuredTool({
      name: 'light_on', description: 'Turns a light on', schema: z.object({ name: z.string() }),
      func: async (args) => { seen.push(args); return '{"ok":true}'; },
    }));
    const wrapped: any = withReplyArg(tool);
    expect(isActionTool(wrapped)).toBe(true);
    expect(Object.keys(wrapped.schema.shape)).toEqual(['name', 'reply']);
    expect(await wrapped.invoke({ name: 'cucina', reply: 'Fatto.' })).toBe('{"ok":true}');
    expect(await wrapped.invoke({ name: 'sala' })).toBe('{"ok":true}');
    expect(seen).toEqual([{ name: 'cucina' }, { name: 'sala' }]);
  });

  it('a step without tools is the final answer, delivered at the end', () => {
    const g = new ActionReplyGate(actions);
    g.modelChunk(); g.text('Sono le 11.');
    expect(g.flush()).toBe('Sono le 11.');
    expect(g.flush()).toBe('');
  });
});

/** A chat model that answers with the given messages in order, tool calls included (the testing fakes drop them). */
class ScriptedModel extends BaseChatModel {
  private i = 0;
  constructor(private readonly responses: AIMessage[]) { super({}); }
  _llmType(): string { return 'scripted'; }
  async _generate() {
    const message = this.responses[this.i++] ?? new AIMessage('(no more responses)');
    return { generations: [{ message, text: typeof message.content === 'string' ? message.content : '' }] };
  }
  bindTools(): any { return this; }
}

describe('ActionReplyGate on a LangGraph ReAct stream', () => {
  /** Runs a ReAct agent the way AgentService.streamResponse consumes it, with the gate in between. */
  async function run(firstStep: AIMessage, toolResult: string) {
    let toolRuns = 0;
    const seenArgs: any[] = [];
    const light = withReplyArg(markActionTool(new DynamicStructuredTool({
      name: 'light_on', description: 'Turns a light on', schema: z.object({ name: z.string() }),
      func: async (args) => { toolRuns++; seenArgs.push(args); return toolResult; },
    })));
    const llm = new ScriptedModel([firstStep, new AIMessage('Second model call.')]);
    let modelCalls = 0;
    const agent = createReactAgent({ llm, tools: [light] });
    const gate = new ActionReplyGate(new Set(['light_on']));
    const out: string[] = [];
    const argsById = new Map<string, unknown>();
    let ended = false;
    const stream = await agent.stream({ messages: [{ role: 'user', content: 'accendi la luce' }] }, {
      streamMode: 'messages',
      callbacks: [{ handleChatModelStart: () => { modelCalls++; } } as any],
    });
    for await (const [message] of stream) {
      if (message._getType() === 'tool') {
        const id = (message as any).tool_call_id;
        const done = gate.toolResult(id, (message as any).name, message.content, (message as any).status, argsById.get(id));
        if (done) { out.push(done.reply); ended = true; break; }
        continue;
      }
      gate.modelChunk();
      for (const c of (message as any).tool_call_chunks ?? []) gate.toolCall(c.id);
      for (const tc of (message as any).tool_calls ?? []) { gate.toolCall(tc.id); argsById.set(tc.id, tc.args); }
      if (typeof message.content === 'string' && message.content) gate.text(message.content);
    }
    if (!ended) out.push(gate.flush());
    return { answer: out.join(''), ended, modelCalls, toolRuns, seenArgs };
  }

  const step = (content: string) => new AIMessage({ content, tool_calls: [{ id: 'call_1', name: 'light_on', args: { name: 'cucina' } }] });

  it('a successful action with a written reply ends the turn: one model call', async () => {
    const r = await run(step('Fatto, luce cucina accesa.'), '{"ok":true}');
    expect(r).toMatchObject({ answer: 'Fatto, luce cucina accesa.', ended: true, modelCalls: 1, toolRuns: 1 });
  });

  it('a failed action goes on to the next model call, the held text dropped', async () => {
    const r = await run(step('Fatto, luce cucina accesa.'), '{"error":"not exposed"}');
    expect(r).toMatchObject({ answer: 'Second model call.', ended: false, modelCalls: 2, toolRuns: 1 });
  });

  it('an action without a reply goes on as before', async () => {
    const r = await run(step(''), '{"ok":true}');
    expect(r).toMatchObject({ answer: 'Second model call.', ended: false, modelCalls: 2, toolRuns: 1 });
  });

  it('the reply in the call\'s argument ends the turn with no text written, and never reaches the tool', async () => {
    const call = new AIMessage({ content: '', tool_calls: [{ id: 'call_1', name: 'light_on', args: { name: 'cucina', reply: 'Fatto, luce cucina accesa.' } }] });
    const r = await run(call, '{"ok":true}');
    expect(r).toEqual({ answer: 'Fatto, luce cucina accesa.', ended: true, modelCalls: 1, toolRuns: 1, seenArgs: [{ name: 'cucina' }] });
  });
});
