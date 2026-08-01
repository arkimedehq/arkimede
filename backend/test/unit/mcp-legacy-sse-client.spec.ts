// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Legacy HTTP+SSE MCP client against a strict in-process mock of the spec
 * transport: GET on the SSE url opens an event stream (Bearer-guarded here),
 * the server sends an `endpoint` event with the POST url, and JSON-RPC
 * responses arrive as `message` events ON THE STREAM (POSTs return 202).
 */
import { createServer, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createSseEventParser, McpLegacySseClient, withLegacySseSession,
} from '../../src/mcp-servers/mcp-http-client';

const TOKEN = 'Bearer sse-test-token';
const TOOLS = [{ name: 'turn_on', description: 'Turns on a device' }];

let server: Server;
let url: string;
const streams = new Map<string, ServerResponse>();

beforeAll(async () => {
  server = createServer((req, res) => {
    const u = new URL(req.url!, 'http://x');
    if (req.method === 'GET' && u.pathname === '/sse') {
      if (req.headers.authorization !== TOKEN) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end('{"message":"Unauthorized"}');
      }
      const sid = Math.random().toString(36).slice(2, 8);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      streams.set(sid, res);
      // Relative endpoint, as legacy servers typically send it.
      res.write(`event: endpoint\ndata: /messages/${sid}\n\n`);
      return;
    }
    if (req.method === 'POST' && u.pathname.startsWith('/messages/')) {
      const sid = u.pathname.split('/').pop()!;
      const stream = streams.get(sid);
      if (!stream) { res.writeHead(404).end(); return; }
      let raw = '';
      req.on('data', (c) => raw += c);
      req.on('end', () => {
        const body = JSON.parse(raw);
        res.writeHead(202).end(); // legacy transport: responses go on the stream
        if (body.method === 'initialize') {
          stream.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} } } })}\n\n`);
        } else if (body.method === 'tools/list') {
          stream.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: TOOLS } })}\n\n`);
        } else if (body.method === 'tools/call') {
          stream.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: `called:${body.params?.name}` }] } })}\n\n`);
        }
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/sse`;
});

afterAll(() => new Promise<void>((resolve) => {
  for (const s of streams.values()) s.end();
  server.close(() => resolve());
}));

const PRIVATE_OK = { allowPrivateHosts: true, allowlist: [] };

describe('McpLegacySseClient — legacy event-stream flow', () => {
  it('completes handshake + tools/list + tools/call over one stream session', async () => {
    const result = await withLegacySseSession(
      { url, headers: { Authorization: TOKEN }, policy: PRIVATE_OK },
      async (client) => {
        const list = await client.request('tools/list', {}, 5_000);
        const call = await client.request('tools/call', { name: 'turn_on', arguments: {} }, 5_000);
        return { list, call };
      },
    );
    expect(result.list.tools[0].name).toBe('turn_on');
    expect(result.call.content[0].text).toBe('called:turn_on');
  });

  it('reports the exact HTTP failure when the token is missing (401)', async () => {
    const client = new McpLegacySseClient({ url, headers: {}, policy: PRIVATE_OK });
    await expect(client.connect(3_000)).rejects.toThrow(/401/);
    await client.close();
  });
});

describe('createSseEventParser', () => {
  it('reassembles events split across arbitrary chunk boundaries', () => {
    const parse = createSseEventParser();
    const full = 'event: endpoint\ndata: /messages/1\n\nevent: message\ndata: {"id":1}\n\n';
    const events = [
      ...parse(full.slice(0, 11)),
      ...parse(full.slice(11, 30)),
      ...parse(full.slice(30)),
    ];
    expect(events).toEqual([
      { event: 'endpoint', data: '/messages/1' },
      { event: 'message', data: '{"id":1}' },
    ]);
  });
});
