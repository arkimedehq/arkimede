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
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { type Tool } from './client';
import { recordareClient } from './recordare.config';
import { RecordareOutboxService } from './recordare-outbox.service';
import { RecordareIdentityService } from './recordare-identity.service';

/** Recordare's tools not offered to Arkimede's agent (the ingest captures the conversation). */
const NOT_OFFERED = new Set(['log_episode']);
/** How long the listed tools are reused (they change only with a Recordare upgrade). */
const TOOLS_TTL_MS = 10 * 60 * 1_000;
/** Bound on the pre-answer memory context (the answer never waits longer for it). */
const CONTEXT_TIMEOUT_MS = 2_500;

@Injectable()
export class RecordareMcpService {
  private readonly logger = new Logger(RecordareMcpService.name);
  private tools: { at: number; list: Tool[] } | null = null;

  constructor(
    private readonly outbox: RecordareOutboxService,
    @Optional() private readonly identity?: RecordareIdentityService,
  ) {}

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

  /**
   * The user's memories relevant to `message` (Recordare's `<memory-context>` block) for an agent with
   * memoryContext on — or null: consent known off, nothing relevant, Recordare slow or down. The current turn is
   * sent first (bounded), so Recordare knows the conversation (its viewer rule needs it).
   */
  async contextBlock(userId: string, chatId: string, message: string): Promise<string | null> {
    const client = recordareClient();
    if (!client || this.identity?.cachedConsent(userId) === false) return null;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        (async () => {
          await this.outbox.flushChat(chatId, 1_500);
          return (await client.context(userId, chatId, message)).block;
        })(),
        new Promise<null>((r) => { timer = setTimeout(() => r(null), CONTEXT_TIMEOUT_MS); }),
      ]);
    } catch (err: any) {
      this.logger.warn(`Recordare memory context failed (user ${userId}): ${err?.message ?? err}`);
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
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
    // Consent known to be off in Recordare: reads would return nothing — offer no tools.
    // Unknown (first contact, Recordare down) → offered; the cache is refreshed meanwhile.
    if (this.identity?.cachedConsent(userId) === false) return [];
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
