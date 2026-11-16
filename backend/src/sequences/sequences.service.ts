// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * The sequences running now, per user (specs/RUN_SEQUENCE.md): start (checked, then in the background), stop, list.
 *
 * - A new sequence with the same restart key as a running one of the same user replaces it (the old one stops, its
 *   `finally` runs): asking again "faster" just works.
 * - At most `maxPerUser` at once per user.
 * - In memory on purpose, like the chat runs: a sequence lives in the process that runs it, a restart ends it.
 * - Each change is pushed to the sockets watching the chat it came from (`sequence`, room `chat:<id>`, throttled);
 *   when it ends, one line is written in that chat (completed / stopped / failed, with why) and the watchers reload.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { RUN_SEQUENCE_DESC, STOP_SEQUENCES_DESC } from '../prompts/prompts';
import { NotificationsGateway } from '../notifications/notifications.gateway';
import { Message } from '../messages/messages.entity';
import { Chat } from '../chats/chats.entity';
import { User } from '../users/users.entity';
import { checkProgram, isDeniedTool, limitsFromEnv, type SequenceLimits, type SequenceProgram } from './sequence-program';
import { runSequence, type SequenceOutcome, type SequenceProgress, type SequenceTool } from './sequence-engine';
import { reportProcedureRun, type ProcedureRef } from '../recordare/recordare-procedures';
import { type ProcedureRun } from '@arkimedehq/recordare-client';

/** What a list shows (no arguments). */
export interface SequenceState {
  kind: 'sequence';
  sequenceId: string;
  userId: string;
  chatId: string | null;
  title: string;
  startedAt: string;
  plannedSeconds: number;
  maxCalls: number;
  tools: string[];
  progress: SequenceProgress;
}

export interface StartOptions {
  userId: string;
  /** The chat the sequence came from (its end is reported there). */
  chatId?: string | null;
  /** The tools of the turn: a sequence calls only these. */
  tools: SequenceTool[];
  onProgress?: (state: SequenceState) => void;
  onEnd?: (state: SequenceState, outcome: SequenceOutcome) => void;
}

export type StartResult =
  | { ok: true; sequenceId: string; estimatedSeconds: number; calls: number; replaced: string[] }
  | { ok: false; errors: string[] };

/** Injection token for the limits (tests); the environment's otherwise. */
export const SEQUENCE_LIMITS = 'SEQUENCE_LIMITS';
/** Socket event to the chat's watchers: `{ chatId, sequenceId, sequence }`, `sequence: null` = it ended (reload). */
export const SEQUENCE_EVENT = 'sequence';
/** Minimum gap between two progress pushes of a sequence. */
export const SEQUENCE_PUSH_MS = 1000;

/** The line written in the chat when a sequence ends, in the user's language (Italian or English). */
export function endLine(state: SequenceState, outcome: SequenceOutcome, language?: string | null): string {
  const it = (language ?? '').toLowerCase().startsWith('it');
  const seconds = Math.round(outcome.elapsedMs / 1000);
  const status = it
    ? { completed: 'completata', stopped: 'fermata', failed: 'interrotta per errore', timeout: 'interrotta: tempo massimo raggiunto' }[outcome.status]
    : { completed: 'completed', stopped: 'stopped', failed: 'stopped by an error', timeout: 'stopped: time limit reached' }[outcome.status];
  const counts = it
    ? `${outcome.calls} azioni${outcome.failures ? ` (${outcome.failures} non riuscite)` : ''} in ${seconds} s`
    : `${outcome.calls} actions${outcome.failures ? ` (${outcome.failures} failed)` : ''} in ${seconds} s`;
  const why = outcome.status !== 'completed' && outcome.status !== 'stopped' && outcome.errors.length
    ? `\n\n${outcome.errors[outcome.errors.length - 1]}` : '';
  return `🔁 «${state.title}» ${status} — ${counts}${why}`;
}

/**
 * How a sequence that carries out a procedure of the memory went, as a procedure run: completed with every call
 * succeeding → done; failed, timed out or with failed calls → failed (at the procedure's step, with the errors). Null
 * when the user stopped it: stopping says nothing about the procedure.
 */
export function sequenceProcedureRun(outcome: SequenceOutcome, ref: ProcedureRef): Omit<ProcedureRun, 'conversation'> | null {
  if (outcome.status === 'stopped') return null;
  const step = ref.step !== undefined ? { step: ref.step } : {};
  if (outcome.status === 'completed' && outcome.failures === 0) return { outcome: 'done', ...step };
  const why = outcome.status === 'timeout' ? ['time limit reached'] : [];
  const failed = outcome.failures ? [`${outcome.failures} of ${outcome.calls} calls failed`] : [];
  const note = [...why, ...failed, ...outcome.errors].join('; ') || 'the sequence failed';
  return { outcome: 'failed', ...step, note };
}

interface Running {
  state: SequenceState;
  key: string;
  abort: AbortController;
  done: Promise<SequenceOutcome>;
  lastPush: number;
}

@Injectable()
export class SequencesService {
  private readonly logger = new Logger(SequencesService.name);
  private readonly running = new Map<string, Running>();
  readonly limits: SequenceLimits;

  constructor(
    @Optional() @Inject(SEQUENCE_LIMITS) limits?: SequenceLimits,
    @Optional() @Inject(NotificationsGateway) private readonly gateway?: NotificationsGateway | null,
    @Optional() @InjectRepository(Message) private readonly messages?: Repository<Message> | null,
    @Optional() @InjectRepository(Chat) private readonly chats?: Repository<Chat> | null,
    @Optional() @InjectRepository(User) private readonly users?: Repository<User> | null,
  ) {
    this.limits = limits ?? limitsFromEnv();
  }

  start(raw: unknown, opts: StartOptions): StartResult {
    const tools = new Map(opts.tools.map((t) => [t.name, t]));
    const checked = checkProgram(raw, tools.keys(), this.limits);
    if (checked.ok === false) return { ok: false, errors: checked.errors };
    const { program, plan } = checked;

    const mine = this.ofUser(opts.userId);
    const replaced = mine.filter((r) => r.key === plan.key);
    if (mine.length - replaced.length >= this.limits.maxPerUser) {
      return { ok: false, errors: [`already ${mine.length} sequences running (at most ${this.limits.maxPerUser}): stop one first`] };
    }
    for (const r of replaced) r.abort.abort();

    const state: SequenceState = {
      kind: 'sequence',
      sequenceId: randomUUID(),
      userId: opts.userId,
      chatId: opts.chatId ?? null,
      title: program.title?.trim() || plan.tools.join(', '),
      startedAt: new Date().toISOString(),
      plannedSeconds: plan.plannedSeconds,
      maxCalls: plan.maxCalls,
      tools: plan.tools,
      progress: { calls: 0, failures: 0, elapsedMs: 0 },
    };
    const abort = new AbortController();
    const done = this.run(program, state, tools, abort.signal, opts);
    this.running.set(state.sequenceId, { state, key: plan.key, abort, done, lastPush: 0 });
    this.push(state);
    this.logger.log(`Sequence ${state.sequenceId} started for ${opts.userId}: "${state.title}", up to ${plan.maxCalls} calls, ${plan.plannedSeconds} s planned${replaced.length ? `, replacing ${replaced.map((r) => r.state.sequenceId).join(', ')}` : ''}`);
    return {
      ok: true, sequenceId: state.sequenceId, estimatedSeconds: plan.plannedSeconds, calls: plan.maxCalls,
      replaced: replaced.map((r) => r.state.sequenceId),
    };
  }

  private async run(
    program: SequenceProgram, state: SequenceState, tools: Map<string, SequenceTool>, signal: AbortSignal, opts: StartOptions,
  ): Promise<SequenceOutcome> {
    // Yield first: the caller registers the sequence (and answers) before any call is made.
    await Promise.resolve();
    let outcome: SequenceOutcome;
    try {
      outcome = await runSequence(program, {
        tools, limits: this.limits, signal,
        onProgress: (p) => {
          state.progress = p;
          opts.onProgress?.({ ...state });
          const r = this.running.get(state.sequenceId);
          if (r && Date.now() - r.lastPush >= SEQUENCE_PUSH_MS) { r.lastPush = Date.now(); this.push(state); }
        },
      });
    } catch (e: any) {
      outcome = { ...state.progress, status: 'failed', errors: [e?.message ?? String(e)] };
    }
    state.progress = { calls: outcome.calls, failures: outcome.failures, elapsedMs: outcome.elapsedMs };
    this.running.delete(state.sequenceId);
    this.logger.log(`Sequence ${state.sequenceId} ${outcome.status}: ${outcome.calls} calls, ${outcome.failures} failed, ${Math.round(outcome.elapsedMs / 1000)} s${outcome.errors.length ? ` — ${outcome.errors.join('; ')}` : ''}`);
    try { opts.onEnd?.({ ...state }, outcome); } catch (e: any) { this.logger.warn(`Sequence end hook failed: ${e?.message ?? e}`); }
    const messageId = await this.writeEnd(state, outcome).catch((e) => {
      this.logger.warn(`Sequence ${state.sequenceId}: end line not written: ${e?.message ?? e}`);
      return null;
    });
    if (state.chatId) {
      this.gateway?.emitToWatchers('chat', state.chatId, SEQUENCE_EVENT, { chatId: state.chatId, sequenceId: state.sequenceId, sequence: null, messageId });
    }
    // After the chat line: the user sees the end first; the memory hears of it right after (never throws).
    if (program.procedure) await this.reportProcedure(state, outcome, program.procedure);
    return outcome;
  }

  private push(state: SequenceState): void {
    if (!state.chatId) return;
    this.gateway?.emitToWatchers('chat', state.chatId, SEQUENCE_EVENT, {
      chatId: state.chatId, sequenceId: state.sequenceId, sequence: this.snapshot(state),
    });
  }

  /** The outcome to the memory's procedure the sequence carried out, when the user's memory is Recordare (best effort). */
  private async reportProcedure(state: SequenceState, outcome: SequenceOutcome, ref: ProcedureRef): Promise<void> {
    const run = sequenceProcedureRun(outcome, ref);
    if (!run) return;
    const user = await this.users?.findOne({ where: { id: state.userId }, select: { id: true, episodicMemoryEnabled: true } }).catch(() => null);
    if (!user?.episodicMemoryEnabled) return;
    await reportProcedureRun(state.userId, ref.id, run, state.chatId);
  }

  /** One line in the chat the sequence came from (if it is the user's chat); the message id, or null. */
  private async writeEnd(state: SequenceState, outcome: SequenceOutcome): Promise<string | null> {
    if (!state.chatId || !this.messages || !this.chats) return null;
    const chat = await this.chats.findOne({ where: { id: state.chatId }, select: { id: true, userId: true } });
    if (!chat || chat.userId !== state.userId) return null;
    const user = await this.users?.findOne({ where: { id: state.userId }, select: { id: true, language: true } }).catch(() => null);
    const saved = await this.messages.save(this.messages.create({
      chatId: chat.id, role: 'assistant', content: endLine(state, outcome, user?.language),
    }));
    await this.chats.update(chat.id, { updatedAt: new Date() });
    return saved.id;
  }

  private snapshot(s: SequenceState): SequenceState {
    return { ...s, tools: [...s.tools], progress: { ...s.progress } };
  }

  private ofUser(userId: string): Running[] {
    return [...this.running.values()].filter((r) => r.state.userId === userId);
  }

  /** The user's running sequences, oldest first. */
  list(userId: string): SequenceState[] {
    return this.ofUser(userId).map((r) => this.snapshot(r.state));
  }

  /** Stops the user's sequence SEQUENCE_ID, or all of theirs; the ids stopped. */
  stop(userId: string, sequenceId?: string): string[] {
    const targets = this.ofUser(userId).filter((r) => !sequenceId || r.state.sequenceId === sequenceId);
    for (const r of targets) r.abort.abort();
    return targets.map((r) => r.state.sequenceId);
  }

  /**
   * The built-in tools `run_sequence` and `stop_sequences` for a turn, bound to the turn's tools (TURN_TOOLS): a
   * sequence calls only those, as the same instances (same user, same authorization). None when no tool of the turn
   * may run in a sequence.
   */
  buildTools(userId: string, chatId: string | null | undefined, turnTools: SequenceTool[]): DynamicStructuredTool[] {
    const callable = turnTools.filter((t) => !isDeniedTool(t.name));
    if (!callable.length) return [];
    // Steps typed loosely here (a recursive schema is not portable across providers' tool formats); checkProgram
    // validates them strictly and its errors tell the model what to fix.
    const step = z.record(z.unknown());
    return [
      new DynamicStructuredTool({
        name: 'run_sequence',
        description: RUN_SEQUENCE_DESC,
        schema: z.object({
          title: z.string().optional().describe('A few words the user sees, e.g. "Luci a intermittenza"'),
          key: z.string().optional().describe('What it acts on; the same key replaces a running sequence'),
          steps: z.array(step).describe('The steps, each an object with one key: call | wait | repeat | parallel | choose'),
          finally: z.array(step).optional().describe('Steps run at the end, also when stopped'),
          stopOnError: z.boolean().optional().describe('Stop at the first failed call (default: go on)'),
          procedure: z.object({
            id: z.string().describe('The procedure\'s id, as the memory gives it'),
            step: z.number().int().optional().describe('The step it carries out (none = the whole task)'),
          }).optional().describe('The memory\'s procedure this sequence carries out: how it went is reported to the memory when it ends'),
        }),
        func: async (program: Record<string, unknown>) => {
          const clean = Object.fromEntries(Object.entries(program).filter(([, v]) => v !== undefined));
          const r = this.start(clean, { userId, chatId, tools: callable });
          if (r.ok === false) return JSON.stringify({ error: 'program refused', errors: r.errors });
          return JSON.stringify({
            started: true, sequenceId: r.sequenceId, estimatedSeconds: r.estimatedSeconds, maxCalls: r.calls,
            ...(r.replaced.length ? { replaced: r.replaced } : {}),
          });
        },
      }),
      new DynamicStructuredTool({
        name: 'stop_sequences',
        description: STOP_SEQUENCES_DESC,
        schema: z.object({
          sequenceId: z.string().optional().describe('One sequence; omitted = all of the user\'s'),
        }),
        func: async ({ sequenceId }: { sequenceId?: string }) => {
          const before = this.list(userId);
          const stopped = this.stop(userId, sequenceId);
          if (!stopped.length) {
            return JSON.stringify(before.length
              ? { stopped: [], running: before.map((x) => ({ sequenceId: x.sequenceId, title: x.title })) }
              : { stopped: [], message: 'no sequence is running' });
          }
          return JSON.stringify({ stopped: before.filter((x) => stopped.includes(x.sequenceId)).map((x) => x.title) });
        },
      }),
    ];
  }

  /** Resolves when the sequence ends (tests, and a caller that waits); null when unknown. */
  whenDone(sequenceId: string): Promise<SequenceOutcome> | null {
    return this.running.get(sequenceId)?.done ?? null;
  }
}
