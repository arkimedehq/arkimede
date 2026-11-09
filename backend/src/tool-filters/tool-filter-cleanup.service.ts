// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * A deleted tool source, as the `names` tool filters (agents, automations) refer to it:
 * - `prefix`: the source's tool-name prefix ("mcp_home_", "skill_files_"), for sources whose
 *   tools share it — its wildcard ("mcp_home_*") and its single tools are removed;
 * - `names`: exact tool names (a custom tool, a flow, an agent exposed as a tool).
 * `remaining` lists the prefixes/names that sources still present produce: a prefix or name
 * still produced by another source (a namesake of another user) is kept, and so are the
 * entries under a longer prefix of another source ("mcp_home_assistant_" under "mcp_home_").
 */
export interface ToolSourceRemoval {
  prefix?: string;
  names?: string[];
  remaining: string[];
}

/** The filter entries left once a source is gone (pure: see ToolSourceRemoval). */
export function pruneToolFilterNames(entries: string[], removal: ToolSourceRemoval): string[] {
  const remaining = new Set(removal.remaining);
  const prefix = removal.prefix && !remaining.has(removal.prefix) ? removal.prefix : null;
  const keepPrefixes = prefix ? removal.remaining.filter((p) => p.length > prefix.length && p.startsWith(prefix)) : [];
  const names = new Set((removal.names ?? []).filter((n) => !remaining.has(n)));
  return entries.filter((entry) => {
    if (names.has(entry)) return false;
    if (prefix && entry.startsWith(prefix) && !keepPrefixes.some((k) => entry.startsWith(k))) return false;
    return true;
  });
}

/** Tables whose rows carry a `toolFilter` ({ mode, names? }) jsonb column. */
const FILTER_TABLES = ['agents', 'scheduled_tasks'] as const;

/**
 * Removes a deleted source's entries from every `names` tool filter, so they do not stay
 * behind matching nothing. Called on an actual deletion only: a source that is merely
 * unreachable (an MCP server down) or disabled keeps its entries.
 * Best-effort: a failure is logged and never fails the deletion.
 */
@Injectable()
export class ToolFilterCleanupService {
  private readonly logger = new Logger(ToolFilterCleanupService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async removeSource(label: string, removal: ToolSourceRemoval): Promise<number> {
    let changed = 0;
    try {
      for (const table of FILTER_TABLES) {
        const rows: Array<{ id: string; toolFilter: { mode: string; names?: string[] } }> = await this.dataSource.query(
          `SELECT id, "toolFilter" FROM "${table}" WHERE "toolFilter"->>'mode' = 'names'`,
        );
        for (const row of rows) {
          const names = row.toolFilter.names ?? [];
          const next = pruneToolFilterNames(names, removal);
          if (next.length === names.length) continue;
          await this.dataSource.query(
            `UPDATE "${table}" SET "toolFilter" = $1::jsonb WHERE id = $2`,
            [JSON.stringify({ ...row.toolFilter, names: next }), row.id],
          );
          changed++;
        }
      }
      if (changed) this.logger.log(`Tool filters: "${label}" removed from ${changed} agent/automation filter(s)`);
    } catch (err: any) {
      this.logger.warn(`Tool filters: cleaning up "${label}" failed: ${err?.message ?? err}`);
    }
    return changed;
  }
}
