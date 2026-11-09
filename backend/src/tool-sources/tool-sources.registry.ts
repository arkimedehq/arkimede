// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file tool-sources.registry.ts
 *
 * Native tool sources — integrations built into Arkimede (Home Assistant) — register here and the agent loads their
 * tools for a user beside the custom tools, MCP servers, skills and flows (same selection, same per-agent filter). The
 * registry has no dependencies: an integration's module imports it and registers itself, so the agent never imports
 * the integration (no module cycle).
 */
import { Injectable, Logger } from '@nestjs/common';
import type { StructuredToolInterface } from '@langchain/core/tools';

export interface ToolSource {
  /** A stable name (also the tools' prefix, e.g. `ha`). */
  readonly name: string;
  /** How people call it (the agent form's tool picker shows it), e.g. `Home Assistant`. */
  readonly label?: string;
  /** The tools this user may use now; [] when the integration is off, unreachable or not for them. */
  loadForUser(userId: string): Promise<StructuredToolInterface[]>;
  /** A short line of live context for the turn (who is home…), or null; it goes in the per-request blocks. */
  contextFor?(userId: string): Promise<string | null>;
}

@Injectable()
export class ToolSourcesRegistry {
  private readonly logger = new Logger(ToolSourcesRegistry.name);
  private readonly sources = new Map<string, ToolSource>();

  register(source: ToolSource): void {
    this.sources.set(source.name, source);
  }

  unregister(name: string): void {
    this.sources.delete(name);
  }

  /** Every source's live context for this user, joined (null when none). */
  async contextFor(userId: string): Promise<string | null> {
    const parts = await Promise.all([...this.sources.values()].map(async (s) => {
      try {
        return (await s.contextFor?.(userId)) ?? null;
      } catch (err) {
        this.logger.warn(`tool source "${s.name}" context failed for user ${userId}: ${(err as Error).message}`);
        return null;
      }
    }));
    const lines = parts.filter((p): p is string => !!p);
    return lines.length ? lines.join('\n') : null;
  }

  /** Every source's tools for this user; a source that fails gives none (logged), the others still load. */
  async loadForUser(userId: string): Promise<StructuredToolInterface[]> {
    return (await this.loadGroupsForUser(userId)).flatMap((g) => g.tools);
  }

  /** The same tools, by source (name, label): the tool picker offers each source as a group. */
  async loadGroupsForUser(userId: string): Promise<Array<{ name: string; label: string; tools: StructuredToolInterface[] }>> {
    return Promise.all([...this.sources.values()].map(async (s) => {
      let tools: StructuredToolInterface[] = [];
      try {
        tools = await s.loadForUser(userId);
      } catch (err) {
        this.logger.warn(`tool source "${s.name}" failed for user ${userId}: ${(err as Error).message}`);
      }
      return { name: s.name, label: s.label ?? s.name, tools };
    }));
  }
}
