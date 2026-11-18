// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Step guard for the agent's tool loop (one per run). It wraps the agent's message modifier and, at the end of what
 * the model reads, adds a short note when the run is going nowhere:
 *   - the same tool returned the same result several times in a row (a loop on an error);
 *   - the previous reply was cut at the model's output limit (a tool call too long to fit);
 *   - this is the last model call the step limit allows: answer now.
 * When the limit is reached anyway, finalAnswerMessages() gives what a last call without tools needs to tell the user
 * what was done and what blocked it, instead of the graph's error.
 *
 * Notes go at the end, after the tool results (as the files of tool-media.ts do), so the cached prefix is untouched.
 */

import { AIMessage, BaseMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import {
  STEP_FINAL_ANSWER_PROMPT, STEP_LAST_CALL_NOTE, STEP_REPEATED_NOTE, STEP_TRUNCATED_NOTE,
} from '../prompts/prompts';

/** Identical results in a row (same tool, same output) that make the guard speak. */
export const REPEATED_RESULTS = 3;

type Modifier = (messages: BaseMessage[]) => Promise<BaseMessage[]>;

const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((b: any) => (typeof b === 'string' ? b : b?.type === 'text' ? b.text : '')).join('')
      : JSON.stringify(content ?? '');

/** The run's own messages: those after the user's message that started it (the last human message of the state). */
export function runMessages(messages: BaseMessage[]): BaseMessage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]._getType() === 'human') return messages.slice(i + 1);
  }
  return messages;
}

/** Model calls already made in this run. */
export function modelCallsMade(messages: BaseMessage[]): number {
  return runMessages(messages).filter((m) => m._getType() === 'ai').length;
}

/** True when the last `n` tool results of the run come from the same tool with the same output. */
export function repeatedResults(messages: BaseMessage[], n = REPEATED_RESULTS): boolean {
  const tools = runMessages(messages).filter((m) => m._getType() === 'tool');
  if (tools.length < n) return false;
  const last = tools.slice(-n);
  const key = (m: BaseMessage) => `${(m as any).name ?? ''}\u0000${textOf(m.content)}`;
  return last.every((m) => key(m) === key(last[0]));
}

/** True when the run's last model reply stopped at the output limit (any provider's way of saying it). */
export function lastReplyTruncated(messages: BaseMessage[]): boolean {
  const run = runMessages(messages);
  const ai = [...run].reverse().find((m) => m._getType() === 'ai') as AIMessage | undefined;
  if (!ai) return false;
  const meta: any = (ai as any).response_metadata ?? {};
  const reason = meta.finish_reason ?? meta.stop_reason ?? meta.finishReason ?? meta.done_reason;
  return reason === 'length' || reason === 'max_tokens' || reason === 'MAX_TOKENS'
    || ((ai as any).invalid_tool_calls?.length ?? 0) > 0;
}

/** The notes for the model's next call (empty = none). `maxCalls` = model calls the step limit allows. */
export function stepNotes(messages: BaseMessage[], maxCalls: number): string[] {
  const notes: string[] = [];
  if (lastReplyTruncated(messages)) notes.push(STEP_TRUNCATED_NOTE);
  if (repeatedResults(messages)) notes.push(STEP_REPEATED_NOTE(REPEATED_RESULTS));
  if (maxCalls > 0 && modelCallsMade(messages) + 1 >= maxCalls) notes.push(STEP_LAST_CALL_NOTE);
  return notes;
}

/** True for LangGraph's error when a run reaches its recursion (step) limit. */
export function isStepLimitError(err: unknown): boolean {
  const e = err as any;
  return e?.name === 'GraphRecursionError' || e?.lc_error_code === 'GRAPH_RECURSION_LIMIT'
    || /Recursion limit of \d+ reached/.test(String(e?.message ?? ''));
}

/** Model calls a LangGraph recursion limit allows a ReAct agent: one agent step and one tools step per call. */
export function maxModelCalls(recursionLimit: number): number {
  return Math.max(1, Math.floor(recursionLimit / 2));
}

/** Clips a string for the final answer's summary of the run. */
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);

/**
 * A plain-text account of the run (what the user asked, each tool call and its result, the model's words), for a
 * last call without tools: plain text works with every provider, whatever its rules on tool messages.
 */
export function runTranscript(messages: BaseMessage[], maxSteps = 30): { request: string; steps: string } {
  let start = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]._getType() === 'human') { start = i; break; }
  }
  const request = start < messages.length ? textOf(messages[start].content) : '';
  const lines: string[] = [];
  for (const m of messages.slice(start + 1)) {
    const type = m._getType();
    if (type === 'ai') {
      const text = textOf(m.content).trim();
      if (text) lines.push(`You said: ${clip(text, 300)}`);
      for (const tc of (m as AIMessage).tool_calls ?? []) {
        lines.push(`You called ${tc.name}(${clip(JSON.stringify(tc.args ?? {}), 300)})`);
      }
    } else if (type === 'tool') {
      lines.push(`  → ${clip(textOf(m.content).replace(/\s+/g, ' ').trim(), 400)}`);
    }
  }
  const kept = lines.length > maxSteps * 2 ? ['(earlier steps omitted)', ...lines.slice(-maxSteps * 2)] : lines;
  return { request: clip(request, 2000), steps: kept.join('\n') };
}

export class StepGuard {
  private limit = 0;
  private last: BaseMessage[] = [];
  private system: SystemMessage | null = null;

  /** The run's recursion limit (set before the run starts; 0 = no last-call note). */
  setRecursionLimit(limit: number): void {
    this.limit = limit;
  }

  /** The agent's modifier with the guard's notes. */
  wrap(inner: Modifier): Modifier {
    return async (messages: BaseMessage[]) => {
      this.last = messages;
      const out = await inner(messages);
      if (out[0]?._getType() === 'system') this.system = out[0] as SystemMessage;
      const notes = stepNotes(messages, this.limit ? maxModelCalls(this.limit) : 0);
      return notes.length ? [...out, new HumanMessage(notes.join('\n\n'))] : out;
    };
  }

  /** True once the run has made a model call (so there is something to account for). */
  hasRun(): boolean {
    return this.last.length > 0;
  }

  /** Messages for a last call without tools, after the step limit: the system prompt and the run told in words. */
  finalAnswerMessages(): BaseMessage[] {
    const { request, steps } = runTranscript(this.last);
    const ask = new HumanMessage(STEP_FINAL_ANSWER_PROMPT(request, steps));
    return this.system ? [this.system, ask] : [ask];
  }
}
