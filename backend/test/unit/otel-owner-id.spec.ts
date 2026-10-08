// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * recordare.owner_id on GenAI spans: present on the very first span after a
 * start (warm cache from the stored ids), picked up mid-trace when it becomes
 * known, and carried by background LLM calls that act for a user.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { GenAiTraceHandler, setRecordareOwnerResolver } from '../../src/observability/genai-trace.handler';
import { RecordareIdentityService } from '../../src/recordare/recordare-identity.service';
import { getLlmCallContext, runWithLlmCallContext } from '../../src/usage/llm-call-context';

function tracer() {
  const exporter = new InMemorySpanExporter();
  const handler = new GenAiTraceHandler(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }).getTracer('t'));
  return { exporter, handler };
}

const chat = (h: GenAiTraceHandler, runId: string, parent?: string) => {
  h.handleChatModelStart({} as any, [], runId, parent, { invocation_params: { model: 'm' } });
  h.handleLLMEnd({ generations: [] }, runId);
};

afterEach(() => {
  setRecordareOwnerResolver(null);
  delete process.env.RECORDARE_URL;
  delete process.env.RECORDARE_API_KEY;
});

describe('recordare.owner_id on spans', () => {
  it('cold start with a stored ownerId: the first span already carries it (warm cache)', async () => {
    process.env.RECORDARE_URL = 'http://127.0.0.1:9'; // unreachable: the background consent check fails quietly
    process.env.RECORDARE_API_KEY = 'rk_test';
    const users = {
      find: async () => [{ id: 'admin', recordareOwnerId: 'owner-admin' }],
      findOne: async () => ({ id: 'admin', name: 'Admin', episodicMemoryEnabled: true, recordareOwnerId: 'owner-admin' }),
      update: async () => undefined,
    } as any;
    const identity = new RecordareIdentityService(users);
    await identity.onModuleInit(); // warms the cache + registers the resolver
    const { exporter, handler } = tracer();
    await runWithLlmCallContext({ userId: 'admin' }, async () => chat(handler, 'first'));
    const [span] = exporter.getFinishedSpans();
    expect(span.attributes['user.id']).toBe('admin');
    expect(span.attributes['recordare.owner_id']).toBe('owner-admin');
  });

  it('owner learnt mid-trace: later spans of the same trace get it', async () => {
    let known: string | undefined;
    setRecordareOwnerResolver(() => known);
    const { exporter, handler } = tracer();
    await runWithLlmCallContext({ userId: 'u1' }, async () => {
      handler.handleChainStart({} as any, {}, 'root', 'chain'); // root captured without owner
    });
    chat(handler, 'early', 'root');
    known = 'owner-1';
    chat(handler, 'late', 'root');
    handler.handleChainEnd({}, 'root');
    const [early, late] = exporter.getFinishedSpans();
    expect(early.attributes['recordare.owner_id']).toBeUndefined();
    expect(late.attributes['recordare.owner_id']).toBe('owner-1');
    expect(late.attributes['user.id']).toBe('u1');
  });

  it('a background call wrapped for the user (compaction, extraction, flow llm node) carries user and owner', async () => {
    setRecordareOwnerResolver((u) => (u === 'u2' ? 'owner-2' : undefined));
    const { exporter, handler } = tracer();
    // Same nesting as the fixed call sites: the outer scope names the user, the inner
    // one sets the scheduling class — the user id must survive the merge.
    await runWithLlmCallContext({ userId: 'u2' }, () =>
      runWithLlmCallContext({ priority: 'background', origin: 'system' }, async () => {
        expect(getLlmCallContext()).toMatchObject({ userId: 'u2', priority: 'background', origin: 'system' });
        chat(handler, 'bg');
      }));
    const [span] = exporter.getFinishedSpans();
    expect(span.attributes['user.id']).toBe('u2');
    expect(span.attributes['recordare.owner_id']).toBe('owner-2');
  });

  it('warm-up never fails the start', async () => {
    const identity = new RecordareIdentityService({ find: async () => { throw new Error('db down'); } } as any);
    expect(await identity.warm()).toBe(0);
  });
});
