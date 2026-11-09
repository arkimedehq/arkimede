// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/** The tool name of an agent/team exposed as a tool: snake_case, `agent_`/`team_` prefix. */
export function agentToolName(prefix: 'agent' | 'team', name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50);
  return `${prefix}_${slug || 'no_name'}`;
}
