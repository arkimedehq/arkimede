// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * The agent form's tool catalog (AgentService.buildToolCatalog): a native integration's tools (Home Assistant's `ha_*`)
 * are a group of their own with the source's wildcard, beside the MCP servers and skills; a source that is off or that
 * fails gives no group, and the others still load.
 */
import { describe, it, expect } from 'vitest';
import { AgentService } from '../../src/agent/agent.service';
import { ToolSourcesRegistry, type ToolSource } from '../../src/tool-sources/tool-sources.registry';

const tool = (name: string) => ({ name, description: `${name} tool` }) as any;

function catalog(sources: ToolSource[], mcpTools = [tool('mcp_home_assistant_HassTurnOn')]) {
  const registry = new ToolSourcesRegistry();
  sources.forEach((s) => registry.register(s));
  const none = { loadToolsForUser: async () => [] };
  const self = {
    customToolsService: none,
    mcpServersService: { loadToolsForUser: async () => mcpTools, findAll: async () => [{ name: 'home_assistant' }] },
    skillsService: { loadToolsForUser: async () => [], findAll: async () => [] },
    flowsService: none,
    multiAgentService: none,
    nativeTools: registry,
  };
  return AgentService.prototype.buildToolCatalog.call(self as any, 'u1');
}

const ha = (tools: string[]): ToolSource => ({ name: 'ha', label: 'Home Assistant', loadForUser: async () => tools.map(tool) });

describe('tool catalog — native integrations', () => {
  it('lists a native integration as its own group with the source wildcard', async () => {
    const { groups } = await catalog([ha(['ha_find_entities', 'ha_call_service'])]);
    expect(groups.map((g) => [g.source, g.label, g.wildcard])).toEqual([
      ['mcp', 'home_assistant', 'mcp_home_assistant_*'],
      ['integration', 'Home Assistant', 'ha_*'],
    ]);
    expect(groups[1].tools.map((t) => t.name)).toEqual(['ha_find_entities', 'ha_call_service']);
  });

  it('gives no group for a source that is off for the user, or that fails', async () => {
    const failing: ToolSource = { name: 'x', loadForUser: async () => { throw new Error('down'); } };
    const { groups } = await catalog([ha([]), failing], []);
    expect(groups).toEqual([]);
  });

  it('labels a source by its name when it has no label', async () => {
    const reg = new ToolSourcesRegistry();
    reg.register({ name: 'acme', loadForUser: async () => [tool('acme_ping')] });
    expect((await reg.loadGroupsForUser('u1')).map((g) => g.label)).toEqual(['acme']);
    expect((await reg.loadForUser('u1')).map((t) => t.name)).toEqual(['acme_ping']);
  });
});
