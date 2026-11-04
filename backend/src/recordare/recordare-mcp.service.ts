// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file recordare-mcp.service.ts
 *
 * Recordare recall for the agent (Recordare INTEGRATION.md §4): LangChain tools
 * built from the tools Recordare's MCP endpoint lists (names, descriptions and
 * JSON Schemas are Recordare's own), called through the shared client library
 * (official MCP SDK, streamable HTTP).
 *
 * Why native tools and not an mcp_servers row: Recordare needs the user AND the
 * conversation of the agent run — `X-Recordare-User` (the session owner) and
 * `X-Recordare-Conversation` (the viewer context: without it a read returns
 * nothing). The client binds both to the MCP session in code; neither the LLM
 * nor the user can change them.
 *
 * Tool names are prefixed `recordare_` so they never collide with Arkimede's own
 * `search_memory` / `save_memory` (A-MEM) or `search_conversations`.
 * `log_episode` is deliberately NOT offered: the ingest already captures the
 * conversation, logging on top of it would duplicate episodes.
 *
 * Also the memory-first contract (Recordare D54): the memory charter for the
 * system prompt (cached until its version changes) and the memory context of
 * each turn. A failed context call marks Recordare down for a short while, so
 * the following turns fall back to Arkimede's own memory at once
 * (agent-memory.service.ts).
 */
import { Injectable, Logger } from '@nestjs/common';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { type Charter, type Tool } from '@arkimedehq/recordare-client';
import { recordareClient } from './recordare.config';
import { RecordareOutboxService } from './recordare-outbox.service';

/** Recordare's tools not offered to Arkimede's agent (the ingest captures the conversation). */
const NOT_OFFERED = new Set(['log_episode']);
/** How long the listed tools are reused (they change only with a Recordare upgrade). */
const TOOLS_TTL_MS = 10 * 60 * 1_000;
/** Bound on the pre-answer memory context (the answer never waits longer for it). */
const CONTEXT_TIMEOUT_MS = 2_500;
/** How often the cached charter is checked for a new version. */
const CHARTER_TTL_MS = 10 * 60 * 1_000;
/** After a failed context call, Recordare is skipped for this long (no 2.5 s wait on every turn of an outage). */
const DOWN_MS = 30 * 1_000;
/** Consecutive context timeouts that count as an outage (one is a busy moment, e.g. while it ingests a turn). */
const TIMEOUTS_DOWN = 3;

/** The memory context of one turn: `reachable` false when Recordare is down (an error, or timeouts in a row). */
export interface RecordareTurnContext {
  reachable: boolean;
  block: string | null;
}

@Injectable()
export class RecordareMcpService {
  private readonly logger = new Logger(RecordareMcpService.name);
  private tools: { at: number; list: Tool[] } | null = null;
  private charters = new Map<'tools' | 'context-only', { at: number; charter: Charter }>();
  private downUntil = 0;
  private timeouts = 0;

  constructor(private readonly outbox: RecordareOutboxService) {}

  /** True when Recordare is configured on this installation. */
  get enabled(): boolean {
    return recordareClient() !== null;
  }

  /** Calls one Recordare MCP tool for `userId` in conversation `conversationId`; returns its text. */
  async callTool(userId: string, conversationId: string, name: string, args: Record<string, unknown>): Promise<string> {
    const client = recordareClient();
    if (!client) throw new Error('Recordare is not configured');
    const res = await client.mcp.callTool(userId, conversationId, name, args);
    return res.isError ? `Recordare error: ${res.text || 'unknown'}` : res.text;
  }

  /** False while Recordare is marked down after a failed context call. */
  get available(): boolean {
    return this.enabled && Date.now() >= this.downUntil;
  }

  /**
   * The memory charter (D54): how the agent uses its memory, for the stable part of the system prompt.
   * `withTools` false: the form for an agent without the memory tools. Cached and re-checked every
   * CHARTER_TTL_MS; the text changes only with its version. Null when Recordare never answered (or
   * predates the charter): the turn goes on without it.
   */
  async charter(withTools: boolean): Promise<string | null> {
    const client = recordareClient();
    if (!client) return null;
    const key = withTools ? 'tools' : 'context-only';
    const cached = this.charters.get(key);
    if (cached && Date.now() - cached.at < CHARTER_TTL_MS) return cached.charter.charter;
    try {
      const charter = await client.charter({ tools: withTools });
      if (cached?.charter.version !== charter.version) this.logger.log(`Recordare charter ${charter.version} (${key})`);
      this.charters.set(key, { at: Date.now(), charter });
      return charter.charter;
    } catch (err: any) {
      if (cached) {
        this.charters.set(key, { at: Date.now(), charter: cached.charter }); // keep it; check again later
        return cached.charter.charter;
      }
      this.logger.warn(`Recordare charter unavailable: ${err?.message ?? err}`);
      return null;
    }
  }

  /**
   * What came to mind for `message` (Recordare's `<memory-context>` block, opened by the self card) in
   * `conversationId`. The current turn is sent first (bounded), so Recordare leaves it out of the excerpts.
   * Never fails nor holds the answer longer than CONTEXT_TIMEOUT_MS. A timeout is a busy Recordare: no
   * block this turn, still reachable (its tools stay). An error, or TIMEOUTS_DOWN timeouts in a row, is
   * `reachable: false` and marks Recordare down for DOWN_MS.
   */
  async context(userId: string, conversationId: string, message: string): Promise<RecordareTurnContext> {
    const client = recordareClient();
    if (!client) return { reachable: false, block: null };
    let timer: NodeJS.Timeout | undefined;
    try {
      const res = await Promise.race([
        (async () => {
          await this.outbox.flushChat(conversationId, 1_500);
          return { reachable: true, block: (await client.context(userId, conversationId, message, { card: true })).block };
        })(),
        new Promise<null>((r) => { timer = setTimeout(() => r(null), CONTEXT_TIMEOUT_MS); }),
      ]);
      if (res) {
        this.timeouts = 0;
        return res;
      }
      this.logger.warn(`Recordare memory context timed out (user ${userId})`);
      if (++this.timeouts < TIMEOUTS_DOWN) return { reachable: true, block: null };
    } catch (err: any) {
      this.logger.warn(`Recordare memory context failed (user ${userId}): ${err?.message ?? err}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
    this.timeouts = 0;
    this.downUntil = Date.now() + DOWN_MS;
    return { reachable: false, block: null };
  }

  /** Recordare's tool list (cached); listing also opens the session of this user and chat. */
  private async listTools(userId: string, chatId: string): Promise<Tool[]> {
    if (this.tools && Date.now() - this.tools.at < TOOLS_TTL_MS) return this.tools.list;
    const client = recordareClient();
    if (!client) return [];
    const list = (await client.mcp.listTools(userId, chatId)).filter((t) => !NOT_OFFERED.has(t.name));
    this.tools = { at: Date.now(), list };
    return list;
  }

  /**
   * The Recordare tools for one agent run. `chatId` is the conversation the
   * answer is shown in (= the externalId Arkimede ingests the chat under).
   * Recordare unreachable → no tools for this run (the agent works without memory).
   */
  async buildTools(userId: string, chatId: string): Promise<DynamicStructuredTool[]> {
    let listed: Tool[];
    try {
      listed = await this.listTools(userId, chatId);
    } catch (err: any) {
      this.logger.warn(`Recordare tools unavailable (user ${userId}): ${err?.message ?? err}`);
      return [];
    }
    const run = (name: string) => async (args: Record<string, unknown>) => {
      try {
        // The current turn may still be in the outbox: send it first (bounded),
        // so Recordare knows the conversation and its participants.
        await this.outbox.flushChat(chatId);
        const clean = Object.fromEntries(Object.entries(args ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== ''));
        return await this.callTool(userId, chatId, name, clean);
      } catch (err: any) {
        this.logger.warn(`Recordare ${name} failed (user ${userId}): ${err?.message ?? err}`);
        return 'The episodic memory (Recordare) is not reachable right now.';
      }
    };
    return listed.map((t) => new DynamicStructuredTool({
      name: `recordare_${t.name}`,
      description: t.description ?? t.name,
      schema: t.inputSchema as any,
      func: run(t.name),
    }));
  }
}
