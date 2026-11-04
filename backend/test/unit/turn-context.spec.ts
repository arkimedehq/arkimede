// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * The per-request blocks (date/time, summary, memories…) ride on the turn's user
 * message, so the system prompt and the tool definitions before it stay identical
 * between requests and the provider's prefix cache can reuse them.
 */
import { describe, it, expect } from 'vitest';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { withTurnContext, TURN_MESSAGE_HEADING } from '../../src/agent/turn-context';
import { toolMediaModifier } from '../../src/agent/tool-media';

const CTX = '## Current date and time\nIt is now 2026-11-02T10:49:37+01:00 (Europe/Rome).';

describe('withTurnContext', () => {
  it('prefixes the last user message and leaves the earlier ones as they were', () => {
    const earlier = new HumanMessage('ciao');
    const msgs = [earlier, new AIMessage('ciao!'), new HumanMessage({ content: 'che ore sono?', id: 'm2' })];
    const out = withTurnContext(msgs, CTX);

    expect(out[0]).toBe(earlier);
    expect(out[1]).toBe(msgs[1]);
    expect(out[2].content).toBe(`${CTX}\n\n${TURN_MESSAGE_HEADING}\nche ore sono?`);
    expect(out[2].id).toBe('m2');
    expect(msgs[2].content).toBe('che ore sono?');          // input not mutated
  });

  it('keeps the turn message when tool calls follow it (agent loop iterations)', () => {
    const msgs = [
      new HumanMessage('accendi la luce'),
      new AIMessage({ content: '', tool_calls: [{ id: 't1', name: 'light_on', args: {} }] }),
      new ToolMessage({ content: 'ok', tool_call_id: 't1' }),
    ];
    const out = withTurnContext(msgs, CTX);
    expect(out[0].content).toContain('accendi la luce');
    expect(out[0].content).toContain(CTX);
    expect(out.slice(1)).toEqual(msgs.slice(1));
  });

  it('adds a text part in front of a multimodal message', () => {
    const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } };
    const out = withTurnContext([new HumanMessage({ content: [{ type: 'text', text: 'cosa vedi?' }, image] as any })], CTX);
    expect(out[0].content).toEqual([
      { type: 'text', text: `${CTX}\n\n${TURN_MESSAGE_HEADING}` },
      { type: 'text', text: 'cosa vedi?' },
      image,
    ]);
  });

  it('adds the context as a user message when there is none, and no-ops on empty context', () => {
    const sys = [new AIMessage('x')];
    expect(withTurnContext(sys, CTX).at(-1)!.content).toBe(CTX);
    const msgs = [new HumanMessage('a')];
    expect(withTurnContext(msgs, '  ')).toBe(msgs);
  });

  it('composed with the tool-media modifier: the system message stays the stable prompt', async () => {
    const modify = toolMediaModifier('STABLE SYSTEM PROMPT', { seesImages: false });
    const turn = (q: string) => modify(withTurnContext([new HumanMessage(q)], `${CTX} ${q.length}`));
    const [a, b] = await Promise.all([turn('che ore sono?'), turn('che tempo fa domani?')]);

    expect(a[0]).toBeInstanceOf(SystemMessage);
    expect(a[0].content).toBe('STABLE SYSTEM PROMPT');
    expect(b[0].content).toBe(a[0].content);               // identical prefix across requests
    expect(a[1].content).toContain(CTX);
    expect(b[1].content).toContain('che tempo fa domani?');
  });
});
