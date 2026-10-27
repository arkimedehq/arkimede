// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * AgentService.streamResponse reports the progress of a run (opts.onProgress) while
 * it happens: each model call as it starts (before any token), the tool whose
 * arguments the model is writing (with their size so far), the start of the text.
 * A model called inside a tool is not one of the agent's steps.
 *
 * Runs the real LangGraph agent loop with a scripted streaming model.
 */
import { describe, expect, it } from 'vitest';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessageChunk } from '@langchain/core/messages';
import { ChatGenerationChunk } from '@langchain/core/outputs';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { AgentService, type AgentProgressEvent } from '../../src/agent/agent.service';

/** Streams one scripted response per call, as a provider does (token callbacks with the chunk). */
class ScriptedModel extends BaseChatModel {
  private calls = 0;
  constructor(private readonly script: AIMessageChunk[][]) { super({}); }
  _llmType() { return 'scripted'; }
  bindTools() { return this as any; }
  async _generate(): Promise<any> { throw new Error('stream only'); }
  async *_streamResponseChunks(_m: unknown, _o: unknown, runManager?: any) {
    const chunks = this.script[this.calls++] ?? [new AIMessageChunk({ content: '?' })];
    for (const message of chunks) {
      const chunk = new ChatGenerationChunk({ message, text: typeof message.content === 'string' ? message.content : '' });
      yield chunk;
      await runManager?.handleLLMNewToken(chunk.text, undefined, undefined, undefined, undefined, { chunk });
    }
  }
}

const toolCall = (name: string, parts: string[]) => [
  new AIMessageChunk({ content: '', tool_call_chunks: [{ name, id: 'call-1', index: 0, args: '', type: 'tool_call_chunk' }] }),
  ...parts.map((args) => new AIMessageChunk({ content: '', tool_call_chunks: [{ index: 0, args, type: 'tool_call_chunk' }] })),
];

function serviceWith(agent: unknown, model: unknown): AgentService {
  const svc: any = Object.create(AgentService.prototype);
  svc.logger = { log() {}, debug() {}, warn() {}, error() {} };
  svc.llmProviderService = { isReasoningModel: async () => false };
  svc.resolveAgent = async () => ({
    agent, model, effectiveHistory: [], effectiveMaxHistoryTokens: 0, provider: 'scripted', modelName: 'scripted',
    contextBreakdown: { systemTok: 0, skillsTok: 0, toolsTok: 0, toolsCount: 0, historyTok: 0, queryTok: 0 },
  });
  svc.buildMessages = async (input: string) => [{ role: 'user', content: input }];
  return svc as AgentService;
}

async function run(svc: AgentService) {
  const events: AgentProgressEvent[] = [];
  const order: string[] = [];
  let text = '';
  await svc.streamResponse(
    'archive this', 'u1', undefined, 'c1', [], [], [], [],
    (chunk) => { text += chunk; order.push('chunk'); },
    (call) => order.push(`tool_call:${call.name}`),
    undefined,
    (name) => order.push(`tool_result:${name}`),
    { onProgress: (e) => { events.push(e); order.push(e.type); } },
  );
  return { events, order, text };
}

describe('streamResponse progress', () => {
  it('reports each step as it starts, the tool being prepared, and the text', async () => {
    const archive = tool(async ({ text }) => `saved ${text.length}`, {
      name: 'archive', description: 'archives a text', schema: z.object({ text: z.string() }),
    });
    const model = new ScriptedModel([
      toolCall('archive', ['{"text":"ab', 'cd"}']),
      [new AIMessageChunk({ content: 'Done' }), new AIMessageChunk({ content: '.' })],
    ]);
    const { events, order, text } = await run(serviceWith(createReactAgent({ llm: model as any, tools: [archive] }), model));

    expect(text).toBe('Done.');
    expect(events).toEqual([
      { type: 'model_start' },
      { type: 'tool_preparing', name: 'archive', argsChars: 0 },
      { type: 'tool_preparing', name: 'archive', argsChars: 11 },
      { type: 'tool_preparing', name: 'archive', argsChars: 15 },
      { type: 'model_start' },
      { type: 'text' },
    ]);
    // Preparing comes before the step ends (tool_call), the text before its chunks.
    expect(order.indexOf('tool_preparing')).toBeLessThan(order.indexOf('tool_call:archive'));
    expect(order.lastIndexOf('text')).toBeLessThan(order.indexOf('chunk'));
  });

  it('does not count a model called inside a tool as a step', async () => {
    const inner = new ScriptedModel([[new AIMessageChunk({ content: 'summary' })]]);
    const summarize = tool(async (_input, config) => {
      const out = await inner.invoke('summarize', config);
      return String(out.content);
    }, { name: 'summarize', description: 'summarizes', schema: z.object({}) });
    const model = new ScriptedModel([toolCall('summarize', ['{}']), [new AIMessageChunk({ content: 'ok' })]]);
    const { events } = await run(serviceWith(createReactAgent({ llm: model as any, tools: [summarize] }), model));

    expect(events.filter((e) => e.type === 'model_start')).toHaveLength(2);
  });

  it('a failing progress listener never breaks the run', async () => {
    const model = new ScriptedModel([[new AIMessageChunk({ content: 'hi' })]]);
    const svc = serviceWith(createReactAgent({ llm: model as any, tools: [] }), model);
    let text = '';
    await svc.streamResponse('x', 'u1', undefined, 'c1', [], [], [], [], (c) => { text += c; }, () => {}, undefined, undefined, {
      onProgress: () => { throw new Error('display broke'); },
    });
    expect(text).toBe('hi');
  });
});
