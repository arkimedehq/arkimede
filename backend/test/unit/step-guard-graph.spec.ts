import { describe, expect, it } from 'vitest';
import { AIMessage, BaseMessage, HumanMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatResult } from '@langchain/core/outputs';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { StepGuard, isStepLimitError } from '../../src/agent/step-guard';

/** A model that always calls the same tool, and records the last message it read. */
class LoopingModel extends BaseChatModel {
  seen: BaseMessage[][] = [];
  _llmType() { return 'looping'; }
  bindTools() { return this as any; }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.seen.push(messages);
    const id = `c${this.seen.length}`;
    const message = new AIMessage({ content: '', tool_calls: [{ id, name: 'fail', args: {}, type: 'tool_call' }] });
    return { generations: [{ text: '', message }] };
  }
}

describe('step guard on a real ReAct graph', () => {
  it('notes the loop and the last call, then the limit error is recognised', async () => {
    const model = new LoopingModel({});
    const fail = tool(async () => 'quota exceeded', { name: 'fail', description: 'always fails', schema: z.object({}) });
    const guard = new StepGuard();
    guard.setRecursionLimit(10);
    const agent = createReactAgent({ llm: model as any, tools: [fail], messageModifier: guard.wrap(async (m) => m) });

    const err = await agent.invoke({ messages: [new HumanMessage('do it')] }, { recursionLimit: 10 }).catch((e) => e);
    expect(isStepLimitError(err)).toBe(true);
    expect(model.seen).toHaveLength(5);                               // 10 steps = 5 model calls
    const lastText = (msgs: BaseMessage[]) => String(msgs[msgs.length - 1].content);
    expect(lastText(model.seen[2])).not.toMatch(/same result/);       // 2 identical results so far
    expect(lastText(model.seen[3])).toMatch(/same result/);           // the 3rd identical result
    expect(lastText(model.seen[4])).toMatch(/last step/);
    expect(guard.hasRun()).toBe(true);
    expect(String(guard.finalAnswerMessages().at(-1)!.content)).toContain('You called fail({})');
  });
});
