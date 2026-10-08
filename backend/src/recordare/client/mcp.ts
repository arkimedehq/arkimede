// GENERATED from recordare packages/client/src/mcp.ts @ 4bd90f7 — do not edit here: change the library and run
// packages/client/scripts/sync-to.sh again.
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Recall over MCP with the official SDK (streamable HTTP). Recordare fixes the owner when a session starts and resolves
 * the viewer context from the conversation header (docs/API.md §1), so a session belongs to one user AND one
 * conversation: both headers are bound here, in code — neither the LLM nor the user can change them. Sessions are
 * reused (bounded, least recently used closed first) and an expired one is re-opened once.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { type Tool } from '@modelcontextprotocol/sdk/types.js';
import { CONVERSATION_HEADER } from './contract.js';
import { type Http } from './http.js';

export interface McpOptions {
  /** Open sessions kept; default 100. */
  maxSessions?: number;
  /** Name and version this client announces to Recordare. */
  clientInfo?: { name: string; version: string };
}

export interface ToolResult {
  /** The tool's text content, joined. */
  text: string;
  isError: boolean;
}

export type { Tool };

/** A session that no longer exists on the server (expired, or Recordare restarted). */
function isSessionGone(err: unknown): boolean {
  return err instanceof StreamableHTTPError && (err.code === 404 || err.code === 400);
}

export class RecordareMcp {
  private readonly sessions = new Map<string, Promise<Client>>();

  constructor(private readonly http: Http, private readonly options: McpOptions = {}) {}

  /** The tools Recordare offers (names, descriptions, JSON Schemas): a host builds its agent's tools from these. */
  async listTools(user: string, conversation: string): Promise<Tool[]> {
    return this.withSession(user, conversation, async (c) => (await c.listTools()).tools);
  }

  /** Calls one tool for `user` in `conversation`. */
  async callTool(user: string, conversation: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    return this.withSession(user, conversation, async (c) => {
      const res = await c.callTool({ name, arguments: args });
      const content = Array.isArray(res.content) ? (res.content as Array<{ type: string; text?: string }>) : [];
      return { text: content.filter((p) => p.type === 'text').map((p) => p.text ?? '').join('\n'), isError: res.isError === true };
    });
  }

  async close(): Promise<void> {
    const all = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(all.map((p) => p.then((c) => c.close()).catch(() => undefined)));
  }

  private async withSession<T>(user: string, conversation: string, fn: (c: Client) => Promise<T>): Promise<T> {
    const key = `${user}\u0000${conversation}`;
    try {
      return await fn(await this.session(key, user, conversation));
    } catch (err) {
      if (!isSessionGone(err)) throw err;
      this.drop(key);
      return fn(await this.session(key, user, conversation));
    }
  }

  private session(key: string, user: string, conversation: string): Promise<Client> {
    const open = this.sessions.get(key);
    if (open) {
      // Most recently used last.
      this.sessions.delete(key);
      this.sessions.set(key, open);
      return open;
    }
    const opening = this.open(user, conversation);
    this.sessions.set(key, opening);
    opening.catch(() => this.sessions.delete(key));
    const max = this.options.maxSessions ?? 100;
    while (this.sessions.size > max) {
      const oldest = this.sessions.keys().next().value as string;
      this.drop(oldest);
    }
    return opening;
  }

  private async open(user: string, conversation: string): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(new URL(this.http.url('mcp')), {
      // Credential, user and conversation are fixed for the session; the host's extra headers (trace context) are read
      // again on every request.
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        for (const [k, v] of Object.entries(this.http.options.headers?.() ?? {})) headers.set(k, v);
        return this.http.fetch(input, { ...init, headers });
      },
      requestInit: { headers: { ...this.http.headers(user), [CONVERSATION_HEADER]: conversation } },
    });
    const client = new Client(this.options.clientInfo ?? { name: 'recordare-client', version: '0.1.0' });
    await client.connect(transport);
    return client;
  }

  private drop(key: string): void {
    const p = this.sessions.get(key);
    this.sessions.delete(key);
    void p?.then((c) => c.close()).catch(() => undefined);
  }
}
