// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * OpenTelemetry GenAI traces: the LangChain handler turns runs into `chat` /
 * `execute_tool` spans nested by runId / parentRunId, `invoke_agent` spans wrap
 * agent runs, errors set ERROR, nothing but metadata reaches a span, and with
 * no endpoint configured nothing is started at all.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SpanStatusCode } from '@opentelemetry/api';
import {
  BasicTracerProvider, InMemorySpanExporter, ReadableSpan, SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { z } from 'zod';
import { GenAiTraceHandler } from '../../src/observability/genai-trace.handler';
import {
  initGenAiTracing, shutdownGenAiTracing, getGenAiTraceHandler, registerGenAiModel,
  withAgentSpan, withRunParent,
} from '../../src/observability/genai-tracing';
import { runWithLlmCallContext } from '../../src/usage/llm-call-context';

const SECRET_PROMPT = 'my secret prompt text';
const SECRET_ARGS = '{"city":"secret-city"}';
const SECRET_RESULT = 'secret tool result';

/** Attribute keys that must never appear (content). */
const CONTENT_KEYS = [
  'gen_ai.input.messages', 'gen_ai.output.messages', 'gen_ai.system_instructions',
  'gen_ai.tool.call.arguments', 'gen_ai.tool.call.result',
];

function assertMetadataOnly(spans: ReadableSpan[]): void {
  for (const s of spans) {
    for (const k of CONTENT_KEYS) expect(s.attributes[k]).toBeUndefined();
    const values = JSON.stringify(s.attributes);
    for (const secret of [SECRET_PROMPT, 'secret-city', SECRET_RESULT]) expect(values).not.toContain(secret);
    expect(s.events).toHaveLength(0);
  }
}

const byName = (spans: ReadableSpan[], name: string) => spans.filter((s) => s.name === name);
const parentOf = (s: ReadableSpan) => s.parentSpanContext?.spanId;

// ── Handler, driven directly ────────────────────────────────────────────────

describe('GenAiTraceHandler', () => {
  let exporter: InMemorySpanExporter;
  let handler: GenAiTraceHandler;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    handler = new GenAiTraceHandler(provider.getTracer('test'));
  });

  const llm = { lc: 1, type: 'constructor', id: ['langchain', 'chat_models', 'openai', 'ChatOpenAI'], kwargs: {} } as any;
  const tool = { lc: 1, type: 'not_implemented', id: ['langchain', 'tools', 'DynamicStructuredTool'] } as any;

  it('an LLM run produces a chat span with model, provider and tokens, and no content', () => {
    handler.registerModel('deepseek-chat', 'deepseek');
    handler.handleChatModelStart(llm, [[new HumanMessage(SECRET_PROMPT)]], 'r1', undefined,
      { invocation_params: { model: 'deepseek-chat' } }, [], { ls_provider: 'openai' });
    handler.handleLLMEnd({
      generations: [[{
        text: 'reply',
        message: new AIMessage({
          content: 'reply',
          usage_metadata: { input_tokens: 12, output_tokens: 34, total_tokens: 46, input_token_details: { cache_read: 5 } },
          response_metadata: { model_name: 'deepseek-chat-v3' },
        }),
      } as any]],
    }, 'r1');

    const [span] = exporter.getFinishedSpans();
    expect(span.name).toBe('chat deepseek-chat');
    expect(span.attributes['gen_ai.operation.name']).toBe('chat');
    expect(span.attributes['gen_ai.request.model']).toBe('deepseek-chat');
    expect(span.attributes['gen_ai.response.model']).toBe('deepseek-chat-v3');
    expect(span.attributes['gen_ai.provider.name']).toBe('deepseek');
    expect(span.attributes['gen_ai.usage.input_tokens']).toBe(12);
    expect(span.attributes['gen_ai.usage.output_tokens']).toBe(34);
    expect(span.attributes['gen_ai.usage.cache_read.input_tokens']).toBe(5);
    expect(span.status.code).not.toBe(SpanStatusCode.ERROR);
    assertMetadataOnly([span]);
  });

  it('does not trust ls_provider "openai" (ChatOpenAI serves other providers) but maps known ones', () => {
    handler.handleChatModelStart(llm, [], 'a', undefined, { invocation_params: { model: 'x' } }, [], { ls_provider: 'openai' });
    handler.handleLLMEnd({ generations: [] }, 'a');
    handler.handleChatModelStart(llm, [], 'b', undefined, { invocation_params: { model: 'claude' } }, [], { ls_provider: 'anthropic' });
    handler.handleLLMEnd({ generations: [] }, 'b');
    const [a, b] = exporter.getFinishedSpans();
    expect(a.attributes['gen_ai.provider.name']).toBeUndefined();
    expect(b.attributes['gen_ai.provider.name']).toBe('anthropic');
  });

  it('a tool run produces an execute_tool span, without arguments or result', () => {
    handler.handleToolStart(tool, SECRET_ARGS, 't1', undefined, [], {}, 'get_weather', 'call_1');
    handler.handleToolEnd(SECRET_RESULT, 't1');
    const [span] = exporter.getFinishedSpans();
    expect(span.name).toBe('execute_tool get_weather');
    expect(span.attributes['gen_ai.operation.name']).toBe('execute_tool');
    expect(span.attributes['gen_ai.tool.name']).toBe('get_weather');
    expect(span.attributes['gen_ai.tool.type']).toBe('function');
    expect(span.attributes['gen_ai.tool.call.id']).toBe('call_1');
    assertMetadataOnly([span]);
  });

  it('nests by parentRunId, through chain runs that produce no span', () => {
    handler.handleChainStart({} as any, {}, 'root', 'chain');
    handler.handleChainStart({} as any, {}, 'node', 'chain', [], {}, 'agent', 'root');
    handler.handleChatModelStart(llm, [], 'llm', 'node', { invocation_params: { model: 'm' } });
    handler.handleLLMEnd({ generations: [] }, 'llm');
    handler.handleToolStart(tool, '{}', 'tool', 'node', [], {}, 'outer_tool');
    handler.handleChatModelStart(llm, [], 'inner', 'tool', { invocation_params: { model: 'm2' } });
    handler.handleLLMEnd({ generations: [] }, 'inner');
    handler.handleToolEnd('ok', 'tool');
    handler.handleChainEnd({}, 'node');
    handler.handleChainEnd({}, 'root');

    const spans = exporter.getFinishedSpans();
    expect(spans.map((s) => s.name).sort()).toEqual(['chat m', 'chat m2', 'execute_tool outer_tool']);
    const toolSpan = byName(spans, 'execute_tool outer_tool')[0];
    const inner = byName(spans, 'chat m2')[0];
    expect(parentOf(inner)).toBe(toolSpan.spanContext().spanId);
    expect(inner.spanContext().traceId).toBe(toolSpan.spanContext().traceId);
    expect(parentOf(byName(spans, 'chat m')[0])).toBeUndefined(); // chains add no span: root-level
  });

  it('errors set status ERROR with error.type only (no message)', () => {
    handler.handleChatModelStart(llm, [], 'e1', undefined, { invocation_params: { model: 'm' } });
    const err = new TypeError(`bad request: ${SECRET_PROMPT}`);
    handler.handleLLMError(err, 'e1');
    handler.handleToolStart(tool, '{}', 'e2', undefined, [], {}, 'broken');
    handler.handleToolError(new Error('boom'), 'e2');
    const [llmSpan, toolSpan] = exporter.getFinishedSpans();
    expect(llmSpan.status.code).toBe(SpanStatusCode.ERROR);
    expect(llmSpan.status.message).toBeUndefined();
    expect(llmSpan.attributes['error.type']).toBe('TypeError');
    expect(toolSpan.status.code).toBe(SpanStatusCode.ERROR);
    assertMetadataOnly([llmSpan, toolSpan]);
  });

  it('a duplicate start (handler inherited + local) yields one span; stray ends are ignored', () => {
    handler.handleChatModelStart(llm, [], 'd', undefined, { invocation_params: { model: 'm' } });
    handler.handleChatModelStart(llm, [], 'd', undefined, { invocation_params: { model: 'm' } });
    handler.handleLLMEnd({ generations: [] }, 'd');
    handler.handleLLMEnd({ generations: [] }, 'd');
    handler.handleToolEnd('x', 'never-started');
    expect(exporter.getFinishedSpans()).toHaveLength(1);
  });

  it('never throws into LangChain, whatever it receives', () => {
    expect(() => {
      handler.handleChatModelStart(null as any, null, 'x', undefined, null as any, undefined, null as any);
      handler.handleLLMEnd(null as any, 'x');
      handler.handleToolStart(null as any, null as any, 'y');
      handler.handleToolEnd(undefined, 'y');
      handler.handleChainStart(null as any, null, 'z');
      handler.handleChainError(null, 'z');
    }).not.toThrow();
  });

  it('takes user.id from the LLM call context for root runs', async () => {
    await runWithLlmCallContext({ userId: 'user-42' }, async () => {
      handler.handleChatModelStart(llm, [], 'u', undefined, { invocation_params: { model: 'm' } });
    });
    handler.handleLLMEnd({ generations: [] }, 'u');
    expect(exporter.getFinishedSpans()[0].attributes['user.id']).toBe('user-42');
  });
});

// ── Off: nothing started ────────────────────────────────────────────────────

describe('tracing off (no OTLP endpoint)', () => {
  it('starts nothing, attaches no handler, and passes calls through', async () => {
    const saved = { a: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, b: process.env.OTEL_EXPORTER_OTLP_ENDPOINT };
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    try {
      const exporter = new InMemorySpanExporter();
      expect(initGenAiTracing({ spanProcessor: new SimpleSpanProcessor(exporter) })).toBe(false);
      expect(getGenAiTraceHandler()).toBeNull();
      expect(() => registerGenAiModel('m', 'openai')).not.toThrow();
      expect(await withAgentSpan({ name: 'a' }, async () => 7)).toBe(7);
      expect(await withRunParent('nope', async () => 8)).toBe(8);
      await expect(withAgentSpan({ name: 'a' }, async () => { throw new Error('same error'); })).rejects.toThrow('same error');
      expect(exporter.getFinishedSpans()).toHaveLength(0);
    } finally {
      if (saved.a !== undefined) process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = saved.a;
      if (saved.b !== undefined) process.env.OTEL_EXPORTER_OTLP_ENDPOINT = saved.b;
    }
  });
});

// ── On: a real LangGraph agent with a scripted model and a dummy tool ────────

/** Scripted chat model: first a tool call, then a final answer; with usage. */
class ScriptedChatModel extends BaseChatModel {
  model = 'scripted-1';
  private turn = 0;
  constructor(private readonly toolName: string) { super({}); }
  _llmType() { return 'scripted'; }
  bindTools() { return this as any; }
  invocationParams() { return { model: this.model }; }
  async _generate(): Promise<any> {
    const first = this.turn++ % 2 === 0;
    const message = new AIMessage({
      content: first ? '' : 'final answer',
      tool_calls: first ? [{ id: `call_${this.turn}`, name: this.toolName, args: { city: 'secret-city' }, type: 'tool_call' }] : [],
      usage_metadata: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
    });
    return { generations: [{ text: '', message }] };
  }
}

describe('tracing on: agent → chat → tool', () => {
  let exporter: InMemorySpanExporter;

  beforeEach(() => {
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'http://127.0.0.1:9/v1/traces'; // never contacted
    exporter = new InMemorySpanExporter();
    expect(initGenAiTracing({ spanProcessor: new SimpleSpanProcessor(exporter) })).toBe(true);
  });

  afterEach(async () => {
    await shutdownGenAiTracing();
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  });

  function buildAgent(toolName: string, func: (input: any, runManager?: any) => Promise<string>) {
    const tool = new DynamicStructuredTool({
      name: toolName, description: 'dummy', schema: z.object({ city: z.string() }), func,
    });
    return createReactAgent({ llm: new ScriptedChatModel(toolName), tools: [tool] });
  }

  it('invoke_agent wraps the chat and execute_tool spans of one trace, with user.id', async () => {
    const handler = getGenAiTraceHandler()!;
    const agent = buildAgent('get_weather', async () => SECRET_RESULT);
    const out: any = await withAgentSpan({ name: 'Arkimede', userId: 'u-1', conversationId: 'chat-1' }, () =>
      agent.invoke({ messages: [new HumanMessage(SECRET_PROMPT)] }, { callbacks: [handler] }));
    expect(out.messages.at(-1).content).toBe('final answer'); // result unchanged

    const spans = exporter.getFinishedSpans();
    const [agentSpan] = byName(spans, 'invoke_agent Arkimede');
    const chats = byName(spans, 'chat scripted-1');
    const [toolSpan] = byName(spans, 'execute_tool get_weather');
    expect(agentSpan.attributes['gen_ai.operation.name']).toBe('invoke_agent');
    expect(agentSpan.attributes['gen_ai.agent.name']).toBe('Arkimede');
    expect(agentSpan.attributes['gen_ai.conversation.id']).toBe('chat-1');
    expect(chats).toHaveLength(2);
    expect(toolSpan).toBeDefined();
    const traceId = agentSpan.spanContext().traceId;
    for (const s of [...chats, toolSpan]) {
      expect(s.spanContext().traceId).toBe(traceId);
      expect(parentOf(s)).toBe(agentSpan.spanContext().spanId);
      expect(s.attributes['user.id']).toBe('u-1');
    }
    expect(chats[0].attributes['gen_ai.usage.input_tokens']).toBe(10);
    assertMetadataOnly(spans);
  });

  it('a sub-agent invoked from a tool nests under that tool span (withRunParent)', async () => {
    const handler = getGenAiTraceHandler()!;
    const sub = buildAgent('sub_tool', async () => 'sub result');
    const parent = buildAgent('agent_helper', async (_input, runManager) =>
      withRunParent(runManager?.runId, () =>
        withAgentSpan({ name: 'Helper', id: 'agent-7' }, async () => {
          const r: any = await sub.invoke({ messages: [new HumanMessage('task')] }, { callbacks: [handler] });
          return String(r.messages.at(-1).content);
        })));
    await withAgentSpan({ name: 'Arkimede', userId: 'u-2' }, () =>
      parent.invoke({ messages: [new HumanMessage('go')] }, { callbacks: [handler] }));

    const spans = exporter.getFinishedSpans();
    const [toolSpan] = byName(spans, 'execute_tool agent_helper');
    const [helper] = byName(spans, 'invoke_agent Helper');
    const [subTool] = byName(spans, 'execute_tool sub_tool');
    expect(parentOf(helper)).toBe(toolSpan.spanContext().spanId);
    expect(helper.attributes['gen_ai.agent.id']).toBe('agent-7');
    expect(helper.attributes['user.id']).toBe('u-2'); // inherited from the outer agent
    expect(parentOf(subTool)).toBe(helper.spanContext().spanId);
  });

  it('an agent error sets ERROR on invoke_agent and is rethrown unchanged', async () => {
    await expect(withAgentSpan({ name: 'Failing' }, async () => { throw new RangeError('x'); })).rejects.toBeInstanceOf(RangeError);
    const [span] = byName(exporter.getFinishedSpans(), 'invoke_agent Failing');
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes['error.type']).toBe('RangeError');
  });
});
