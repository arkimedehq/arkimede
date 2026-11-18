import { describe, expect, it } from 'vitest';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import {
  StepGuard, isStepLimitError, lastReplyTruncated, maxModelCalls, modelCallsMade, repeatedResults, runTranscript,
  stepNotes,
} from '../../src/agent/step-guard';

const call = (name: string, args: Record<string, unknown>, id: string) =>
  new AIMessage({ content: '', tool_calls: [{ id, name, args, type: 'tool_call' }] });
const result = (name: string, content: string, id: string) => new ToolMessage({ content, tool_call_id: id, name });

/** A run that called `name` n times, each getting `out`. */
function loop(n: number, name = 'run_in_sandbox', out = '{"exit_code":1,"stderr":"quota exceeded"}') {
  const msgs: any[] = [new HumanMessage('earlier turn'), new AIMessage('ok'), new HumanMessage('analyse the photos')];
  for (let i = 0; i < n; i++) msgs.push(call(name, { code: `rm -rf x${i}` }, `c${i}`), result(name, out, `c${i}`));
  return msgs;
}

describe('step guard', () => {
  it('counts only the model calls of the current run', () => {
    expect(modelCallsMade(loop(0))).toBe(0);
    expect(modelCallsMade(loop(4))).toBe(4);
  });

  it('sees the same result from the same tool repeated, not a varied run', () => {
    expect(repeatedResults(loop(2))).toBe(false);
    expect(repeatedResults(loop(3))).toBe(true);
    const varied = loop(2);
    varied.push(call('run_in_sandbox', {}, 'x'), result('run_in_sandbox', '{"exit_code":0}', 'x'));
    expect(repeatedResults(varied)).toBe(false);
    // Same output from different tools is not a loop.
    const mixed = loop(2);
    mixed.push(call('other_tool', {}, 'y'), result('other_tool', '{"exit_code":1,"stderr":"quota exceeded"}', 'y'));
    expect(repeatedResults(mixed)).toBe(false);
  });

  it('ignores repeats from an earlier turn', () => {
    const msgs = [...loop(3), new AIMessage('done'), new HumanMessage('new request')];
    expect(repeatedResults(msgs)).toBe(false);
  });

  it('sees a reply cut at the output limit, for each provider', () => {
    const cut = (meta: Record<string, unknown>) =>
      [new HumanMessage('q'), new AIMessage({ content: 'partial', response_metadata: meta })];
    expect(lastReplyTruncated(cut({ finish_reason: 'length' }))).toBe(true);      // OpenAI-compatible
    expect(lastReplyTruncated(cut({ stop_reason: 'max_tokens' }))).toBe(true);    // Anthropic
    expect(lastReplyTruncated(cut({ finishReason: 'MAX_TOKENS' }))).toBe(true);   // Gemini
    expect(lastReplyTruncated(cut({ done_reason: 'length' }))).toBe(true);        // Ollama
    expect(lastReplyTruncated(cut({ finish_reason: 'tool_calls' }))).toBe(false);
    const invalid = new AIMessage({ content: '', invalid_tool_calls: [{ name: 'x', args: '{"code": "pri', id: 'i', error: 'bad json', type: 'invalid_tool_call' }] });
    expect(lastReplyTruncated([new HumanMessage('q'), invalid])).toBe(true);
  });

  it('notes nothing on a healthy run, and the last call at the limit', () => {
    expect(stepNotes(loop(2), 50)).toEqual([]);
    expect(stepNotes(loop(3), 50)).toHaveLength(1);
    const last = stepNotes(loop(1, 'a', 'x'), 2);
    expect(last).toHaveLength(1);
    expect(last[0]).toMatch(/last step/);
    expect(stepNotes(loop(1, 'a', 'x'), 0)).toEqual([]);   // no limit known → no last-call note
  });

  it('maps a recursion limit to model calls (one agent and one tools step each)', () => {
    expect(maxModelCalls(100)).toBe(50);
    expect(maxModelCalls(1)).toBe(1);
  });

  it('recognises the step limit error and nothing else', () => {
    expect(isStepLimitError(Object.assign(new Error('Recursion limit of 100 reached without hitting a stop condition.'), { name: 'GraphRecursionError' }))).toBe(true);
    expect(isStepLimitError(new Error('Recursion limit of 25 reached without hitting a stop condition.'))).toBe(true);
    expect(isStepLimitError(new Error('429 rate limit'))).toBe(false);
    expect(isStepLimitError(undefined)).toBe(false);
  });

  it('tells the run in words: the request, each call and its result', () => {
    const { request, steps } = runTranscript(loop(2));
    expect(request).toBe('analyse the photos');
    expect(steps).toContain('You called run_in_sandbox({"code":"rm -rf x0"})');
    expect(steps).toContain('→ {"exit_code":1,"stderr":"quota exceeded"}');
    expect(steps).not.toContain('earlier turn');
    const long = runTranscript(loop(40), 5).steps.split('\n');
    expect(long[0]).toBe('(earlier steps omitted)');
    expect(long).toHaveLength(11);
  });

  it('wraps the modifier: notes at the end only when due, system prompt kept for the last call', async () => {
    const guard = new StepGuard();
    guard.setRecursionLimit(100);
    const inner = async (m: any[]) => [new SystemMessage('You are Arkimede.'), ...m];
    const wrapped = guard.wrap(inner);

    const healthy = await wrapped(loop(1));
    expect(healthy).toHaveLength(1 + loop(1).length);
    expect(guard.hasRun()).toBe(true);

    const looping = await wrapped(loop(3));
    const note = looping[looping.length - 1];
    expect(note._getType()).toBe('human');
    expect(String(note.content)).toMatch(/same result/);

    const final = guard.finalAnswerMessages();
    expect(final[0]._getType()).toBe('system');
    expect(String(final[1].content)).toContain('analyse the photos');
    expect(String(final[1].content)).toContain('without tools');
  });

  it('has nothing to account for before the first call', () => {
    expect(new StepGuard().hasRun()).toBe(false);
  });
});
