// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * MCP resources — servers that declare the `resources` capability get one extra
 * agent tool, mcp_<slug>_read_resource, listing their resources and URI
 * templates and reading them via resources/read. Servers without the capability
 * keep the previous behavior: no extra round trips, no extra tool.
 */
import { describe, it, expect, vi } from 'vitest';
import { McpServersService } from '../../src/mcp-servers/mcp-servers.service';

const server = { id: 's1', name: 'Host Monitor', description: 'host metrics', transport: 'http',
  url: 'http://h/mcp', enabled: true, updatedAt: new Date('2026-01-01') } as any;

function makeService(opts: { capabilities?: Record<string, unknown>; rpc?: Record<string, any> }) {
  const svc: any = Object.create(McpServersService.prototype);
  svc.logger = { log() {}, debug() {}, warn() {}, error() {} };
  svc.remoteDiscovery = new Map();
  svc.httpSessions = new Map([[server.id, { session: { protocolVersion: 'x', capabilities: opts.capabilities }, at: Date.now() }]]);
  svc.teams = { teamIdsForUser: vi.fn(async () => []) };
  svc.serverRepo = { find: vi.fn(async () => [server]) };
  svc.loadSecrets = vi.fn(async () => ({}));
  const rpc = { 'tools/list': { tools: [{ name: 'ping', inputSchema: { type: 'object' } }] }, ...opts.rpc };
  svc.httpRpc = vi.fn(async (_s: any, _sec: any, method: string, params: any) => {
    const r = rpc[method];
    if (r instanceof Error) throw r;
    return typeof r === 'function' ? r(params) : r;
  });
  return svc;
}

const methods = (svc: any) => svc.httpRpc.mock.calls.map((c: any[]) => c[2]);

describe('MCP resources exposed as a read_resource tool', () => {
  it('no resources capability → no extra calls, no extra tool (unchanged)', async () => {
    const svc = makeService({ capabilities: { tools: {} } });
    const tools = await svc.loadToolsForUser('u');
    expect(tools.map((t: any) => t.name)).toEqual(['mcp_host_monitor_ping']);
    expect(methods(svc)).toEqual(['tools/list']);
  });

  it('resources capability → tool listing resources and templates', async () => {
    const svc = makeService({
      capabilities: { tools: {}, resources: {} },
      rpc: {
        'resources/list': { resources: [{ uri: 'mon://stats', name: 'all_stats', description: 'All stats' }] },
        'resources/templates/list': { resourceTemplates: [{ uriTemplate: 'mon://stats/{plugin}', name: 'plugin_stats' }] },
      },
    });
    const tools = await svc.loadToolsForUser('u');
    expect(tools.map((t: any) => t.name)).toEqual(['mcp_host_monitor_ping', 'mcp_host_monitor_read_resource']);
    const desc = tools[1].description;
    expect(desc).toContain('mon://stats — all_stats: All stats');
    expect(desc).toContain('mon://stats/{plugin} — plugin_stats');
  });

  it('reads a resource: text contents returned, binary omitted', async () => {
    const svc = makeService({
      capabilities: { resources: {} },
      rpc: {
        'resources/list': { resources: [{ uri: 'mon://stats' }] },
        'resources/templates/list': new Error('Method not found'),
        'resources/read': (p: any) => ({ contents: [
          { uri: p.uri, mimeType: 'application/json', text: '{"cpu": 12}' },
          { uri: `${p.uri}/img`, mimeType: 'image/png', blob: 'AAAA' },
        ] }),
      },
    });
    const tools = await svc.loadToolsForUser('u');
    const read = tools.find((t: any) => t.name.endsWith('_read_resource'));
    const out = await read.invoke({ uri: 'mon://stats/cpu' });
    expect(out).toContain('{"cpu": 12}');
    expect(out).toContain('[binary resource omitted (image/png)]');
    expect(svc.httpRpc).toHaveBeenLastCalledWith(server, {}, 'resources/read', { uri: 'mon://stats/cpu' }, { timeoutMs: 30_000 });
  });

  it('resources capability but empty lists → no extra tool', async () => {
    const svc = makeService({
      capabilities: { resources: {} },
      rpc: { 'resources/list': { resources: [] }, 'resources/templates/list': { resourceTemplates: [] } },
    });
    const tools = await svc.loadToolsForUser('u');
    expect(tools.map((t: any) => t.name)).toEqual(['mcp_host_monitor_ping']);
  });
});
