// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * The agent runs in progress, one per chat, kept in memory so a chat shows what the
 * agent is doing even to a page that was not the one that sent the message (another
 * tab, another device, the same page after a reload).
 *
 * A run outlives the SSE connection that started it: closing that connection only
 * stops the live stream; the run goes on, saves its answer and ends here. Stopping
 * a run is explicit (cancel). Each change is pushed to the sockets watching the chat
 * (`chat_run` on the notifications gateway, room `chat:<id>`, same access rules as
 * sending a message); a page that opens the chat reads the current state with GET.
 *
 * In-memory on purpose: a run lives in the process that executes it, so a restart
 * ends both.
 */
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { NotificationsGateway } from '../notifications/notifications.gateway';
import { ChatsService } from '../chats/chats.service';

/** What the run is doing now. */
export type ChatRunPhase =
  | 'starting'   // history, attachments, context: before the first model call
  | 'model'      // a model call is in progress, nothing streamed yet
  | 'preparing'  // the model is writing the arguments of a tool call
  | 'tool'       // a tool is running
  | 'writing'    // the model is writing the answer
  | 'team';      // an agent team is running (no finer progress)

export interface ChatRunToolEvent {
  at: string;
  tool: string;
  ok: boolean;
  durationMs?: number;
}

/** A file the run produced (tracked as a File: downloaded by id, with its access rules). */
export interface ChatRunFile {
  name: string;
  fileId: string;
  downloadUrl: string;
}

/** The state sent to the pages (no inputs, outputs or text: only what is shown). */
export interface ChatRunState {
  chatId: string;
  runId: string;
  startedAt: string;
  /** Model calls started so far (the agent's steps). */
  step: number;
  phase: ChatRunPhase;
  phaseSince: string;
  /** The tool being prepared or run. */
  tool: string | null;
  /** Characters of tool arguments written so far (phase 'preparing'). */
  argsChars: number;
  /** The last finished tools, oldest first. */
  recent: ChatRunToolEvent[];
  /** The files produced so far (attached to the answer when the run ends). */
  files: ChatRunFile[];
}

export type ChatRunPatch = Partial<Pick<ChatRunState, 'phase' | 'tool' | 'argsChars'>> & { nextStep?: boolean };

/** Socket event carrying a run's state; `run: null` = the run ended (reload the messages). */
export const CHAT_RUN_EVENT = 'chat_run';
/** Socket event (to the user only) carrying memory proposals: `{ chatId, proposals }`. */
export const MEMORY_PROPOSAL_EVENT = 'memory_proposal';
export const RECENT_TOOLS = 10;
export const RUN_FILES = 20;
/** Minimum gap between two pushes that change only the arguments' size. */
export const PROGRESS_THROTTLE_MS = 1000;

interface Run {
  state: ChatRunState;
  abort: AbortController;
  lastPush: number;
}

@Injectable()
export class ChatRunsService implements OnModuleInit {
  private readonly runs = new Map<string, Run>();

  constructor(
    @Inject(NotificationsGateway) private readonly gateway: NotificationsGateway,
    @Inject(ChatsService) private readonly chats: ChatsService,
  ) {}

  onModuleInit(): void {
    // Watching a chat's run = being allowed to send messages in it.
    this.gateway.registerWatchable('chat', async (userId, chatId) => {
      await this.chats.findOneForWrite(chatId, userId);
      return true;
    });
  }

  /**
   * Starts the run of CHAT_ID; null when one is already in progress there (one run
   * per chat: two at once would interleave their answers in the same history).
   */
  start(chatId: string, now = Date.now()): { runId: string; signal: AbortSignal } | null {
    if (this.runs.has(chatId)) return null;
    const at = new Date(now).toISOString();
    const run: Run = {
      state: {
        chatId, runId: randomUUID(), startedAt: at, step: 0,
        phase: 'starting', phaseSince: at, tool: null, argsChars: 0, recent: [], files: [],
      },
      abort: new AbortController(),
      lastPush: now,
    };
    this.runs.set(chatId, run);
    this.push(run.state);
    return { runId: run.state.runId, signal: run.abort.signal };
  }

  /**
   * Applies PATCH to the run of CHAT_ID (if RUN_ID is still the one in progress) and
   * pushes it. A change of the arguments' size alone is pushed at most every
   * PROGRESS_THROTTLE_MS. Returns the state when it was pushed, else null.
   */
  update(chatId: string, runId: string, patch: ChatRunPatch, now = Date.now()): ChatRunState | null {
    const run = this.current(chatId, runId);
    if (!run) return null;
    const s = run.state;
    const phase = patch.phase ?? s.phase;
    const tool = patch.tool !== undefined ? patch.tool : s.tool;
    const changed = phase !== s.phase || tool !== s.tool || !!patch.nextStep;
    if (!changed && (patch.argsChars === undefined || patch.argsChars === s.argsChars)) return null;
    if (patch.nextStep) s.step += 1;
    if (changed) {
      s.phase = phase;
      s.tool = tool;
      s.phaseSince = new Date(now).toISOString();
      s.argsChars = 0;
    }
    if (patch.argsChars !== undefined) s.argsChars = patch.argsChars;
    if (!changed && now - run.lastPush < PROGRESS_THROTTLE_MS) return null;
    run.lastPush = now;
    this.push(s);
    return this.snapshot(s);
  }

  /** Records a finished tool (shown in the run's recent list) and pushes the state. */
  toolDone(chatId: string, runId: string, event: Omit<ChatRunToolEvent, 'at'>, now = Date.now()): ChatRunState | null {
    const run = this.current(chatId, runId);
    if (!run) return null;
    run.state.recent = [...run.state.recent, { at: new Date(now).toISOString(), ...event }].slice(-RECENT_TOOLS);
    run.lastPush = now;
    this.push(run.state);
    return this.snapshot(run.state);
  }

  /** Records a file the run produced (once per File id, the latest RUN_FILES) and pushes the state. */
  fileReady(chatId: string, runId: string, file: ChatRunFile, now = Date.now()): ChatRunState | null {
    const run = this.current(chatId, runId);
    if (!run || run.state.files.some((f) => f.fileId === file.fileId)) return null;
    run.state.files = [...run.state.files, file].slice(-RUN_FILES);
    run.lastPush = now;
    this.push(run.state);
    return this.snapshot(run.state);
  }

  /** Ends the run: the watchers reload the chat (MESSAGE_ID = the saved answer, if any). */
  finish(chatId: string, runId: string, messageId: string | null = null): void {
    if (!this.current(chatId, runId)) return;
    this.runs.delete(chatId);
    this.gateway.emitToWatchers('chat', chatId, CHAT_RUN_EVENT, { chatId, run: null, messageId });
  }

  /**
   * Memory proposals extracted after a turn of CHAT_ID: to USER_ID only (memory is
   * personal, unlike the run, which every writer of the chat follows).
   */
  memoryProposals(userId: string, chatId: string, proposals: { id: string; content: string }[]): void {
    if (proposals.length) this.gateway.emitToUser(userId, MEMORY_PROPOSAL_EVENT, { chatId, proposals });
  }

  /** Stops the run of CHAT_ID (the agent stops at its next step); false when none is in progress. */
  cancel(chatId: string): boolean {
    const run = this.runs.get(chatId);
    if (!run) return false;
    run.abort.abort();
    return true;
  }

  get(chatId: string): ChatRunState | null {
    const run = this.runs.get(chatId);
    return run ? this.snapshot(run.state) : null;
  }

  private snapshot(s: ChatRunState): ChatRunState {
    return { ...s, recent: [...s.recent], files: [...s.files] };
  }

  private current(chatId: string, runId: string): Run | null {
    const run = this.runs.get(chatId);
    return run && run.state.runId === runId ? run : null;
  }

  private push(state: ChatRunState): void {
    this.gateway.emitToWatchers('chat', state.chatId, CHAT_RUN_EVENT, { chatId: state.chatId, run: state });
  }
}
