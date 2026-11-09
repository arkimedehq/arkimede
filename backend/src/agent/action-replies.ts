// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Action replies (Agent.actionReplies, off by default): a turn whose last step only ACTS ends with the reply the
 * model wrote together with the action, with no extra model call just to say "done".
 *
 * An action tool does something and answers only whether it worked — turn a light on, show photos on a screen,
 * send a message — so once it succeeded there is nothing left for the model to read or reason about. A read tool
 * (search, state, memory, web) returns what the answer is made of: after it the model always runs again.
 * Each tool source marks its action tools (markActionTool): the native integrations in code, MCP servers through
 * the standard `readOnlyHint: false` annotation.
 *
 * With the option on, every action tool of the turn takes one more argument, `reply` (withReplyArg): the short reply
 * the model gives if the action succeeds — models always fill tool arguments, while some (DeepSeek) never write text
 * in the message that calls a tool. The argument is removed before the tool runs. The text the model writes in a step
 * is held instead of streamed. When the step called only action tools, all of them succeeded and a reply was given
 * (in `reply`, else as text with the calls), that reply is the answer and the turn ends. Otherwise the held text is
 * dropped and the turn goes on as usual (a failure, a read tool, no reply).
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

const ACTION_FLAG = 'arkimedeAction';

/** Marks a tool as an action tool (see above). Returns the tool. */
export function markActionTool<T extends { metadata?: Record<string, unknown> }>(tool: T): T {
  tool.metadata = { ...(tool.metadata ?? {}), [ACTION_FLAG]: true };
  return tool;
}

export function isActionTool(tool: { metadata?: Record<string, unknown> } | null | undefined): boolean {
  return tool?.metadata?.[ACTION_FLAG] === true;
}

/** The argument an action tool takes, with the option on, for the reply to give if it succeeds. */
export const REPLY_ARG = 'reply';

/**
 * The action tool with the `reply` argument added, removed again before the tool itself runs. Only tools built from
 * a function with an object schema can be wrapped (every native and MCP tool); any other is returned as it is — its
 * reply can still come as text with the call.
 */
export function withReplyArg<T extends { name: string }>(tool: T): T | DynamicStructuredTool<any> {
  const t = tool as any;
  if (typeof t.func !== 'function' || typeof t.schema?.extend !== 'function') return tool;
  const schema = t.schema.extend({
    [REPLY_ARG]: z.string().optional().describe('The short reply you give the user if this action succeeds, in their language'),
  });
  return markActionTool(new DynamicStructuredTool<any>({
    name: t.name,
    description: t.description,
    schema,
    responseFormat: t.responseFormat,
    metadata: t.metadata,
    func: async (args: Record<string, unknown>, runManager?: any, config?: any) => {
      const { [REPLY_ARG]: _reply, ...rest } = args ?? {};
      return t.func(rest, runManager, config);
    },
  }));
}

/**
 * Whether an action tool's result says it worked: not a thrown error, and no failure in the answer — an `error`,
 * a confirmation still needed, `ok: false` / `success: false`, or an MCP error text.
 */
export function actionSucceeded(content: unknown, status?: string): boolean {
  if (status === 'error') return false;
  const text = typeof content === 'string' ? content
    : Array.isArray(content) ? content.map((b: any) => (typeof b === 'string' ? b : b?.text ?? '')).join('\n')
      : JSON.stringify(content ?? '');
  const trimmed = text.trim();
  if (/^(MCP error|Error)\b/i.test(trimmed)) return false;
  let parsed: any;
  try { parsed = JSON.parse(trimmed); } catch { return true; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return true;
  if (parsed.error || parsed.needs_confirmation || parsed.ok === false || parsed.success === false || parsed.isError === true) return false;
  return true;
}

export type GateResult = { reply: string } | null;

/**
 * Decides, step by step, whether a turn ends on an action reply. Fed with the stream: the model's text, the ids of
 * the tool calls of its step, then each tool result. Pure, so the streaming loop only routes events to it.
 */
export class ActionReplyGate {
  private pending = '';
  private held = '';
  private calls = new Set<string>();
  private results = new Map<string, { name: string; ok: boolean; reply: string }>();
  private stepClosed = false;

  constructor(private readonly actionTools: ReadonlySet<string>) {}

  /** A model chunk: once the previous step's tools have all answered, it opens a new step. */
  modelChunk(): void {
    if (this.stepClosed) {
      this.calls.clear();
      this.results.clear();
      this.held = '';
      this.stepClosed = false;
    }
  }

  text(chunk: string): void {
    this.pending += chunk;
  }

  toolCall(id: string | undefined): void {
    if (id) this.calls.add(id);
  }

  /**
   * A tool result, with the call's arguments when known; the reply when it completes a step of successful action
   * tools with a reply (their `reply` arguments, else the text written with the calls).
   */
  toolResult(id: string | undefined, name: string, content: unknown, status?: string, input?: unknown): GateResult {
    if (!this.results.size) {
      // The step's text was written with its tool calls: held, not part of the final answer.
      this.held = this.pending;
      this.pending = '';
    }
    const key = id ?? `#${this.results.size}`;
    if (id) this.calls.add(id);
    const given = (input as any)?.[REPLY_ARG];
    this.results.set(key, {
      name, ok: this.actionTools.has(name) && actionSucceeded(content, status),
      reply: typeof given === 'string' ? given.trim() : '',
    });
    if (this.results.size < this.calls.size) return null;
    this.stepClosed = true;
    const all = [...this.results.values()];
    const replies = [...new Set(all.map((r) => r.reply).filter(Boolean))];
    // Several actions, several replies: one sentence each.
    const sentence = (r: string) => (/[.!?…]$/.test(r) ? r : `${r}.`);
    const reply = replies.length ? (replies.length > 1 ? replies.map(sentence).join(' ') : replies[0]) : this.held.trim();
    return reply && all.length && all.every((r) => r.ok) ? { reply } : null;
  }

  /** The text still to deliver when the turn ends normally (the final step's answer). */
  flush(): string {
    const out = this.pending;
    this.pending = '';
    return out;
  }
}
