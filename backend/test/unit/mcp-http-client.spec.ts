// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * MCP Streamable HTTP client against a strict in-process mock server that
 * mirrors the official SDK behavior: `initialize` assigns an `Mcp-Session-Id`,
 * every subsequent request WITHOUT that header is rejected with 400 (the exact
 * failure mode the old plain-POST implementation hit), and responses are
 * SSE-formatted. Also covers the host policy: 127.0.0.1 must pass only when
 * the policy allows private hosts (metadata/link-local stays blocked upstream).
 */
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  mcpInitialize, mcpRpc, parseSseJsonResponse, MCP_PROTOCOL_VERSION,
} from '../../src/mcp-servers/mcp-http-client';

const SESSION_ID = 'test-session-123';
const TOOLS = [
  { name: 'echo', description: 'Echoes the input', inputSchema: { type: 'object', properties: {} } },
];

let server: Server;
let url: string;
const seen: { initializedNotified: boolean } = { initializedNotified: false };

function sse(payload: unknown): string {
  return `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      if (body.method === 'initialize') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Mcp-Session-Id': SESSION_ID,
        });
        res.end(sse({
          jsonrpc: '2.0', id: body.id,
          result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'mock' } },
        }));
        return;
      }
      // Strict: everything after initialize requires the session header.
      if (req.headers['mcp-session-id'] !== SESSION_ID) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id ?? null, error: { code: -32000, message: 'Bad Request: No valid session ID provided' } }));
        return;
      }
      if (body.method === 'notifications/initialized') {
        seen.initializedNotified = true;
        res.writeHead(202).end();
        return;
      }
      if (body.method === 'tools/list') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(sse({ jsonrpc: '2.0', id: body.id, result: { tools: TOOLS } }));
        return;
      }
      if (body.method === 'tools/call') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(sse({
          jsonrpc: '2.0', id: body.id,
          result: { content: [{ type: 'text', text: `echo:${JSON.stringify(body.params?.arguments)}` }] },
        }));
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const PRIVATE_OK = { allowPrivateHosts: true, allowlist: [] };

describe('mcp-http-client — streamable HTTP handshake', () => {
  it('captures the session id, negotiates the version and notifies initialized', async () => {
    const session = await mcpInitialize({ url, headers: {}, policy: PRIVATE_OK });
    expect(session.sessionId).toBe(SESSION_ID);
    expect(session.protocolVersion).toBe('2025-03-26'); // server-negotiated, not ours
    expect(MCP_PROTOCOL_VERSION).not.toBe('2025-03-26');
    expect(seen.initializedNotified).toBe(true);
  });

  it('tools/list succeeds WITH the session and parses the SSE body', async () => {
    const session = await mcpInitialize({ url, headers: {}, policy: PRIVATE_OK });
    const result = await mcpRpc({ url, headers: {}, policy: PRIVATE_OK }, session, 'tools/list', {});
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('echo');
  });

  it('tools/call round-trips arguments through the session', async () => {
    const session = await mcpInitialize({ url, headers: {}, policy: PRIVATE_OK });
    const result = await mcpRpc({ url, headers: {}, policy: PRIVATE_OK }, session, 'tools/call', {
      name: 'echo', arguments: { x: 1 },
    });
    expect(result.content[0].text).toBe('echo:{"x":1}');
  });

  it('a session-less request is rejected by the strict server (old-client failure mode)', async () => {
    await expect(
      mcpRpc({ url, headers: {}, policy: PRIVATE_OK }, { protocolVersion: MCP_PROTOCOL_VERSION }, 'tools/list', {}),
    ).rejects.toThrow(/400/);
  });
});

describe('mcp-http-client — host policy', () => {
  it('blocks a loopback target without a permissive policy (historical strict default)', async () => {
    await expect(mcpInitialize({ url, headers: {} })).rejects.toThrow(/Internal destination/);
  });

  it('allows a loopback target listed in the allowlist even when private hosts are off', async () => {
    const session = await mcpInitialize({
      url, headers: {},
      policy: { allowPrivateHosts: false, allowlist: ['127.0.0.1'] },
    });
    expect(session.sessionId).toBe(SESSION_ID);
  });
});

describe('parseSseJsonResponse', () => {
  it('joins multi-line data fields and picks the message with the expected id', () => {
    const text = 'event: message\ndata: {"id":9,\ndata: "result":{"v":1}}\n\n'
      + 'event: message\ndata: {"id":7,"result":{"v":2}}\n\n';
    expect(parseSseJsonResponse(text, 7).result.v).toBe(2);
    expect(parseSseJsonResponse(text, 9).result.v).toBe(1);
  });

  it('skips comments/pings and throws when no JSON message exists', () => {
    expect(() => parseSseJsonResponse(': ping\n\n')).toThrow(/no JSON-RPC/);
  });
});
