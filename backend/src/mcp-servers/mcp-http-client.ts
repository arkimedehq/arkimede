// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file mcp-http-client.ts
 *
 * Minimal MCP client over the Streamable HTTP transport (single-endpoint POST
 * JSON-RPC), backward compatible with "plain" JSON-RPC servers.
 *
 * Streamable HTTP (MCP spec 2025-03-26+) differs from plain POSTing in three ways:
 *   1. `initialize` returns an `Mcp-Session-Id` response header that MUST be echoed
 *      on every subsequent request (servers reply 400 "No valid session ID" otherwise);
 *   2. the client MUST send a `notifications/initialized` notification after the
 *      handshake before using the session;
 *   3. any response may be `application/json` OR a `text/event-stream` body whose
 *      events carry the JSON-RPC messages.
 * Plain servers simply don't return a session header — the same flow degrades
 * gracefully (no session echoed, notification failure tolerated).
 *
 * All requests go through safeFetch (anti-SSRF, redirect re-validation) with the
 * caller-provided host policy.
 */
import { HttpHostPolicy, safeFetch } from '../common/ssrf-guard';

/** Protocol version requested by this client; the server may negotiate it down. */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

export interface McpHttpTarget {
  url: string;
  headers: Record<string, string>;
  policy?: HttpHostPolicy;
}

export interface McpHttpSession {
  /** Session id assigned by streamable-HTTP servers; undefined for plain servers. */
  sessionId?: string;
  /** Negotiated protocol version (echoed via the MCP-Protocol-Version header). */
  protocolVersion: string;
}

/**
 * Parses a `text/event-stream` body and returns the first JSON-RPC message with
 * the given id (or, failing that, the first parsable data payload). SSE events
 * are separated by blank lines; multi-line `data:` fields are joined per spec.
 */
export function parseSseJsonResponse(text: string, expectId?: number): any {
  let fallback: any;
  for (const rawEvent of text.split(/\r?\n\r?\n/)) {
    const dataLines = rawEvent
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart());
    if (dataLines.length === 0) continue;
    try {
      const parsed = JSON.parse(dataLines.join('\n'));
      if (expectId === undefined || parsed?.id === expectId) return parsed;
      fallback ??= parsed;
    } catch {
      // Not JSON (comment/ping event) — keep scanning.
    }
  }
  if (fallback !== undefined) return fallback;
  throw new Error('SSE: no JSON-RPC message found in the event stream');
}

/** Reads a JSON-RPC response body, whatever the content type. */
async function readRpcBody(resp: Response, expectId?: number): Promise<any> {
  const contentType = resp.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
    return parseSseJsonResponse(await resp.text(), expectId);
  }
  const text = await resp.text();
  if (!text.trim()) return undefined; // 202 Accepted on notifications
  return JSON.parse(text);
}

function rpcHeaders(target: McpHttpTarget, session?: McpHttpSession): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...(session ? { 'MCP-Protocol-Version': session.protocolVersion } : {}),
    ...(session?.sessionId ? { 'Mcp-Session-Id': session.sessionId } : {}),
    ...target.headers,
  };
}

/**
 * Performs the MCP handshake: `initialize` (capturing the session id and the
 * negotiated protocol version) followed by `notifications/initialized`.
 */
export async function mcpInitialize(
  target: McpHttpTarget,
  opts: { timeoutMs?: number; clientName?: string } = {},
): Promise<McpHttpSession> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const resp = await safeFetch(target.url, {
    method: 'POST',
    headers: rpcHeaders(target),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        clientInfo: { name: opts.clientName ?? 'arkimede', version: '1.0.0' },
      },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  }, target.policy);

  if (!resp.ok) {
    throw new Error(`MCP initialize failed: ${resp.status} ${resp.statusText}`);
  }

  const sessionId = resp.headers.get('mcp-session-id') ?? undefined;
  let negotiated = MCP_PROTOCOL_VERSION;
  try {
    const body = await readRpcBody(resp, 1);
    if (body?.error) throw new Error(`MCP initialize error: ${JSON.stringify(body.error)}`);
    if (typeof body?.result?.protocolVersion === 'string') {
      negotiated = body.result.protocolVersion;
    }
  } catch (err: any) {
    if (String(err?.message).startsWith('MCP initialize error')) throw err;
    // Unparsable initialize body: keep the requested version (plain servers).
  }
  const session: McpHttpSession = { sessionId, protocolVersion: negotiated };

  // Required by the spec before using the session; plain servers may reject the
  // notification (e.g. 404/405) — tolerated, the session simply stays "plain".
  try {
    const notif = await safeFetch(target.url, {
      method: 'POST',
      headers: rpcHeaders(target, session),
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      signal: AbortSignal.timeout(timeoutMs),
    }, target.policy);
    await notif.body?.cancel().catch(() => undefined);
  } catch {
    // Network/SSRF errors already surfaced during initialize; ignore here.
  }

  return session;
}

/**
 * Sends a JSON-RPC request on an initialized session and returns its `result`.
 * Throws on transport errors, JSON-RPC errors, and expired sessions (the server
 * answers 400/404 in that case — the caller may re-initialize and retry).
 */
export async function mcpRpc(
  target: McpHttpTarget,
  session: McpHttpSession,
  method: string,
  params: Record<string, unknown>,
  opts: { timeoutMs?: number } = {},
): Promise<any> {
  const id = Math.floor(Math.random() * 1_000_000) + 2;
  const resp = await safeFetch(target.url, {
    method: 'POST',
    headers: rpcHeaders(target, session),
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
  }, target.policy);

  if (!resp.ok) {
    const err: any = new Error(`MCP ${method} failed: ${resp.status} ${resp.statusText}`);
    err.status = resp.status;
    throw err;
  }
  const body = await readRpcBody(resp, id);
  if (body?.error) {
    throw new Error(`MCP ${method} error: ${JSON.stringify(body.error)}`);
  }
  return body?.result ?? body;
}

/** True when the failure smells like an expired/missing session worth one retry. */
export function isSessionError(err: any): boolean {
  return err?.status === 400 || err?.status === 404;
}

// ── Legacy HTTP+SSE transport (MCP spec 2024-11-05) ─────────────────────────────
//
// The client opens a GET event stream on the configured URL; the server sends an
// `endpoint` event with the URL to POST JSON-RPC messages to, and every response
// arrives as a `message` event ON THE STREAM (the POSTs themselves just return
// 202 Accepted).

/** Incremental SSE parser: feed chunks, get complete {event, data} records back. */
export function createSseEventParser(): (chunk: string) => { event: string; data: string }[] {
  let buffer = '';
  return (chunk: string) => {
    buffer += chunk;
    const events: { event: string; data: string }[] = [];
    for (;;) {
      const sep = buffer.search(/\r?\n\r?\n/);
      if (sep < 0) break;
      const rawEvent = buffer.slice(0, sep);
      buffer = buffer.slice(sep).replace(/^\r?\n\r?\n/, '');
      let event = 'message';
      const dataLines: string[] = [];
      for (const line of rawEvent.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
      if (dataLines.length) events.push({ event, data: dataLines.join('\n') });
    }
    return events;
  };
}

/**
 * Minimal client for the legacy HTTP+SSE transport. Sequential usage:
 * `connect()` → `request('initialize', …)` → `notify('notifications/initialized')`
 * → more requests → `close()`. One instance = one session.
 */
export class McpLegacySseClient {
  private postUrl?: string;
  private abort = new AbortController();
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private streamDone: Promise<void> = Promise.resolve();

  constructor(private readonly target: McpHttpTarget) {}

  /** Opens the event stream and waits for the server's `endpoint` event. */
  async connect(timeoutMs = 10_000): Promise<void> {
    const resp = await safeFetch(this.target.url, {
      method: 'GET',
      headers: { Accept: 'text/event-stream', ...this.target.headers },
      signal: this.abort.signal,
    }, this.target.policy);
    if (!resp.ok || !resp.body) {
      throw new Error(`MCP SSE connect failed: ${resp.status} ${resp.statusText}`);
    }

    let resolveEndpoint!: (v: string) => void;
    let rejectEndpoint!: (e: Error) => void;
    const endpointPromise = new Promise<string>((res, rej) => { resolveEndpoint = res; rejectEndpoint = rej; });

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    const parse = createSseEventParser();
    this.streamDone = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const evt of parse(decoder.decode(value, { stream: true }))) {
            if (evt.event === 'endpoint') {
              resolveEndpoint(evt.data);
            } else if (evt.event === 'message') {
              try {
                const msg = JSON.parse(evt.data);
                const waiter = typeof msg?.id === 'number' ? this.pending.get(msg.id) : undefined;
                if (waiter) {
                  this.pending.delete(msg.id);
                  if (msg.error) waiter.reject(new Error(`MCP error: ${JSON.stringify(msg.error)}`));
                  else waiter.resolve(msg.result);
                }
              } catch { /* non-JSON message event — ignore */ }
            }
          }
        }
      } catch (err: any) {
        if (err?.name !== 'AbortError') {
          const failure = new Error(`MCP SSE stream error: ${err?.message ?? err}`);
          rejectEndpoint(failure);
          for (const w of this.pending.values()) w.reject(failure);
          this.pending.clear();
        }
      } finally {
        const closed = new Error('MCP SSE stream closed');
        rejectEndpoint(closed);
        for (const w of this.pending.values()) w.reject(closed);
        this.pending.clear();
      }
    })();

    const timer = setTimeout(() => rejectEndpoint(new Error('MCP SSE: no endpoint event received (timeout)')), timeoutMs);
    try {
      // The endpoint may be relative — resolve it against the stream URL. A
      // cross-host absolute endpoint is still re-validated by safeFetch+policy.
      this.postUrl = new URL(await endpointPromise, this.target.url).toString();
    } finally {
      clearTimeout(timer);
    }
  }

  /** Sends a JSON-RPC request and awaits its response from the event stream. */
  async request(method: string, params: Record<string, unknown>, timeoutMs = 15_000): Promise<any> {
    if (!this.postUrl) throw new Error('MCP SSE: not connected');
    const id = this.nextId++;
    const waiter = new Promise<any>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`MCP ${method}: no response on the event stream (timeout)`));
      }, timeoutMs);
    });
    const resp = await safeFetch(this.postUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.target.headers },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    }, this.target.policy);
    if (!resp.ok && resp.status !== 202) {
      this.pending.delete(id);
      throw new Error(`MCP ${method} failed: ${resp.status} ${resp.statusText}`);
    }
    await resp.body?.cancel().catch(() => undefined);
    return waiter;
  }

  /** Sends a JSON-RPC notification (no response expected). */
  async notify(method: string): Promise<void> {
    if (!this.postUrl) throw new Error('MCP SSE: not connected');
    const resp = await safeFetch(this.postUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.target.headers },
      body: JSON.stringify({ jsonrpc: '2.0', method }),
      signal: AbortSignal.timeout(5_000),
    }, this.target.policy);
    await resp.body?.cancel().catch(() => undefined);
  }

  /** Full handshake on an open stream: initialize + notifications/initialized. */
  async initialize(clientName = 'arkimede'): Promise<void> {
    await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      clientInfo: { name: clientName, version: '1.0.0' },
    });
    await this.notify('notifications/initialized');
  }

  async close(): Promise<void> {
    this.abort.abort();
    await this.streamDone.catch(() => undefined);
  }
}

/**
 * One-shot helper for the legacy transport: connect → handshake → run `fn` →
 * close. Every JSON-RPC exchange of the session goes through the same stream.
 */
export async function withLegacySseSession<T>(
  target: McpHttpTarget,
  fn: (client: McpLegacySseClient) => Promise<T>,
  opts: { clientName?: string } = {},
): Promise<T> {
  const client = new McpLegacySseClient(target);
  try {
    await client.connect();
    await client.initialize(opts.clientName);
    return await fn(client);
  } finally {
    await client.close();
  }
}
