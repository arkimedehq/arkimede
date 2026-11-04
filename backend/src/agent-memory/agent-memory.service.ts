// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file agent-memory.service.ts
 *
 * The agent's memory, one service for every way an agent runs: the chat, the
 * voice and OpenAI-compatible entry points, the automations (AgentService) and
 * the delegated agents and team members (MultiAgentService). It follows the
 * memory-first contract (Recordare INTEGRATION.md §4, D54): a memory charter in
 * the stable part of the system prompt, what came to mind before every turn,
 * and the memory tools, listed first.
 *
 * Which memory:
 *   - Recordare, when it is configured, the user's episodic memory is on, the
 *     run has a conversation (Recordare scopes writes and the recall log by it)
 *     and Recordare answers the turn's context call. Its charter comes from
 *     Recordare (cached by version).
 *   - Otherwise A-MEM, the platform's own memory, with an equivalent charter
 *     (prompts.ts amemCharter) — when the user keeps A-MEM notes.
 *   - Otherwise none: the turn goes on without memory.
 * The A-MEM notes the user keeps (personal, team / org) stay in the prompt and
 * their tools stay available beside Recordare: copies of Recordare notes and
 * shared notes live only there.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { User } from '../users/users.entity';
import { type MemoryUse, UserMemoryService } from '../user-memory/user-memory.service';
import { RecordareMcpService } from '../recordare/recordare-mcp.service';
import { amemCharter, memoryBlock, userMemoryBlock } from '../prompts/prompts';

/** The user's memory switches (a subset of User). */
export type MemoryUser = Pick<User, 'id' | 'autoMemoryEnabled' | 'sharedMemoryEnabled' | 'episodicMemoryEnabled'>;

export interface AgentMemoryRequest {
  userId: string;
  /** The user's switches when the caller already loaded them (saves a query). */
  user?: MemoryUser | null;
  /** The conversation the turn belongs to; without one the memory is A-MEM. */
  conversationId?: string;
  /** The Arkimede chat of the turn, when there is one (A-MEM links a proposed note to it). */
  chatId?: string;
  /** The message about to be answered (what to recall for). */
  query?: string;
  /** Extra topical signal for A-MEM's retrieval (e.g. the tail of the rolling summary). */
  querySignal?: string;
}

export interface AgentMemory {
  source: 'recordare' | 'amem' | 'none';
  /** Stable part of the system prompt (cached prefix): the charter and the pinned notes. */
  prompt: string | null;
  /** Per-turn blocks (not cached): what came to mind for this message. */
  turnBlocks: string[];
  /** The memory tools, in a stable order: list them before the agent's other tools. */
  tools: DynamicStructuredTool[];
}

const NO_MEMORY: AgentMemory = { source: 'none', prompt: null, turnBlocks: [], tools: [] };

@Injectable()
export class AgentMemoryService {
  private readonly logger = new Logger(AgentMemoryService.name);

  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @Optional() @Inject(UserMemoryService) private readonly userMemory: UserMemoryService | null = null,
    @Optional() @Inject(RecordareMcpService) private readonly recordare: RecordareMcpService | null = null,
  ) {}

  /** The memory of one agent turn. Never throws: a failing memory leaves the turn without it. */
  async forTurn(req: AgentMemoryRequest): Promise<AgentMemory> {
    try {
      return await this.resolve(req);
    } catch (err: any) {
      this.logger.warn(`Agent memory unavailable (user ${req.userId}): ${err?.message ?? err}`);
      return NO_MEMORY;
    }
  }

  private async resolve(req: AgentMemoryRequest): Promise<AgentMemory> {
    const user = req.user ?? await this.userRepo.findOne({
      where: { id: req.userId },
      select: { id: true, autoMemoryEnabled: true, sharedMemoryEnabled: true, episodicMemoryEnabled: true },
    });
    if (!user) return NO_MEMORY;

    // Two independent choices (Recordare D34): the personal notes and the team / org ones.
    const use: MemoryUse = { personal: !!user.autoMemoryEnabled, shared: !!user.sharedMemoryEnabled };
    const usesNotes = (use.personal || use.shared) && !!this.userMemory;
    const query = req.query?.trim() ?? '';
    const wantsRecordare = !!(user.episodicMemoryEnabled && req.conversationId && this.recordare?.available);

    const [notes, recordare] = await Promise.all([
      usesNotes ? this.notes(user.id, use, query, req.querySignal) : null,
      wantsRecordare ? this.recordareTurn(user.id, req.conversationId!, query) : null,
    ]);
    const noteTools = usesNotes ? this.userMemory!.buildMemoryTools(user.id, req.chatId, use) : [];

    if (recordare) {
      return {
        source: 'recordare',
        prompt: join([recordare.charter, notes?.pinned]),
        turnBlocks: [notes?.recalled, recordare.block].filter((b): b is string => !!b),
        tools: [...recordare.tools, ...noteTools],
      };
    }
    if (usesNotes) {
      return {
        source: 'amem',
        prompt: join([amemCharter(use.personal), notes?.pinned]),
        turnBlocks: notes?.recalled ? [notes.recalled] : [],
        tools: noteTools,
      };
    }
    return NO_MEMORY;
  }

  /** A-MEM: the pinned notes (stable) and the notes retrieved for this message (per turn). */
  private async notes(userId: string, use: MemoryUse, query: string, signal?: string): Promise<{ pinned: string | null; recalled: string | null }> {
    const [pinned, recalled] = await Promise.all([
      this.userMemory!.getPinnedContents(userId, use).catch((err: any) => {
        this.logger.warn(`Failed to load user memory: ${err?.message ?? err}`);
        return [] as string[];
      }),
      // Hybrid FTS+vector retrieval over the confirmed notes (pinned ones excluded: already in the prompt).
      query
        ? this.userMemory!.retrieve(userId, signal?.trim() ? `${query}\n${signal.trim()}` : query, use).catch((err: any) => {
            this.logger.warn(`Memory retrieval failed: ${err?.message ?? err}`);
            return [];
          })
        : Promise.resolve([]),
    ]);
    return {
      pinned: pinned.length ? userMemoryBlock(pinned) : null,
      recalled: recalled.length ? memoryBlock(recalled) : null,
    };
  }

  /**
   * Recordare's part of the turn, or null when Recordare did not answer (the caller falls back to A-MEM).
   * The context call decides: it runs every turn and is bounded; the charter and the tools are cached.
   */
  private async recordareTurn(userId: string, conversationId: string, query: string) {
    const recordare = this.recordare!;
    const [ctx, tools] = await Promise.all([
      query ? recordare.context(userId, conversationId, query) : Promise.resolve({ reachable: true, block: null }),
      recordare.buildTools(userId, conversationId),
    ]);
    if (!ctx.reachable) return null;
    const charter = await recordare.charter(tools.length > 0);
    return { charter, block: ctx.block, tools };
  }
}

function join(parts: (string | null | undefined)[]): string | null {
  const kept = parts.filter((p): p is string => !!p?.trim());
  return kept.length ? kept.join('\n\n') : null;
}
