// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Remote MCP discovery backoff — an intermittently offline http/sse server must
 * not cost a network round trip on every chat request: after a failure the
 * request path answers from the last known tool list (or none) without touching
 * the network, re-probes in the background once the backoff expires, and a
 * config change resets the state. Servers load concurrently, in stable order.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpServersService } from '../../src/mcp-servers/mcp-servers.service';

const T0 = new Date('2026-01-01T00:00:00Z');

function server(id: string, name: string, updatedAt = T0) {
  return { id, name, transport: 'http', url: `http://${id}/mcp`, enabled: true, updatedAt } as any;
}

function makeService(servers: any[], fetch: (s: any) => Promise<any[]>) {
  const svc: any = Object.create(McpServersService.prototype);
  svc.logger = { log() {}, debug() {}, warn() {}, error() {} };
  svc.remoteDiscovery = new Map();
  svc.httpSessions = new Map();
  svc.teams = { teamIdsForUser: vi.fn(async () => []) };
  svc.serverRepo = { find: vi.fn(async () => servers) };
  svc.loadSecrets = vi.fn(async () => ({}));
  svc.fetchMcpTools = vi.fn(fetch);
  return svc;
}

const names = (tools: any[]) => tools.map((t) => t.name);
const flush = () => new Promise((r) => setImmediate(r));

describe('MCP remote discovery backoff', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(T0); });
  afterEach(() => vi.useRealTimers());

  it('healthy server: live discovery on every request (unchanged behavior)', async () => {
    const svc = makeService([server('a', 'Alpha')], async () => [{ name: 'ping' }]);
    expect(names(await svc.loadToolsForUser('u'))).toEqual(['mcp_alpha_ping']);
    expect(names(await svc.loadToolsForUser('u'))).toEqual(['mcp_alpha_ping']);
    expect(svc.fetchMcpTools).toHaveBeenCalledTimes(2);
  });

  it('offline server is skipped without network during the backoff window', async () => {
    const svc = makeService([server('a', 'Alpha')], async () => { throw new Error('fetch failed'); });
    expect(await svc.loadToolsForUser('u')).toEqual([]);
    expect(await svc.loadToolsForUser('u')).toEqual([]);
    expect(svc.fetchMcpTools).toHaveBeenCalledTimes(1);
  });

  it('keeps the last known tool list while offline and recovers via background probe', async () => {
    let online = true;
    const svc = makeService([server('a', 'Alpha')], async () => {
      if (!online) throw new Error('fetch failed');
      return [{ name: 'ping' }];
    });
    await svc.loadToolsForUser('u');                       // learn the list
    online = false;
    expect(names(await svc.loadToolsForUser('u'))).toEqual(['mcp_alpha_ping']); // failure → cached list
    expect(names(await svc.loadToolsForUser('u'))).toEqual(['mcp_alpha_ping']); // backoff → no network
    expect(svc.fetchMcpTools).toHaveBeenCalledTimes(2);

    online = true;
    vi.setSystemTime(new Date(T0.getTime() + 31_000));      // backoff expired
    expect(names(await svc.loadToolsForUser('u'))).toEqual(['mcp_alpha_ping']); // not delayed
    await flush();                                          // background probe settles
    expect(svc.fetchMcpTools).toHaveBeenCalledTimes(3);
    await svc.loadToolsForUser('u');                        // healthy again → live
    expect(svc.fetchMcpTools).toHaveBeenCalledTimes(4);
  });

  it('a config change (updatedAt) resets the backoff', async () => {
    const servers = [server('a', 'Alpha')];
    const svc = makeService(servers, async () => { throw new Error('fetch failed'); });
    await svc.loadToolsForUser('u');
    servers[0] = server('a', 'Alpha', new Date(T0.getTime() + 1000));
    await svc.loadToolsForUser('u');
    expect(svc.fetchMcpTools).toHaveBeenCalledTimes(2);
  });

  it('loads servers concurrently and keeps their order', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const svc = makeService([server('a', 'Alpha'), server('b', 'Beta')], async (s) => {
      if (s.id === 'a') await gate;                         // first server slow
      return [{ name: 'x' }];
    });
    const pending = svc.loadToolsForUser('u');
    await flush();
    expect(svc.fetchMcpTools).toHaveBeenCalledTimes(2);     // second started before first finished
    release();
    expect(names(await pending)).toEqual(['mcp_alpha_x', 'mcp_beta_x']);
  });
});
