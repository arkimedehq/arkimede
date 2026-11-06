// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file ha-socket.ts
 *
 * A minimal client of Home Assistant's WebSocket API (https://developers.home-assistant.io/docs/api/websocket): the
 * `auth` handshake with a long-lived token, commands answered by id (`get_states`, the registries, `call_service`),
 * event subscriptions. One connection; `close()` ends it. Reconnecting is the caller's (home-assistant.service.ts).
 */
import WebSocket from 'ws';

const COMMAND_TIMEOUT_MS = 20_000;

export class HaSocketError extends Error {}

export class HaSocket {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private readonly listeners = new Map<number, (event: any) => void>();
  /** Called once when the connection ends (closed by either side, or failed). */
  onClose: ((reason: string) => void) | null = null;
  /** Home Assistant's version, after `connect`. */
  version = '';

  /** The WebSocket URL of a Home Assistant base URL (its MCP server URL works: only the origin is kept). */
  static urlOf(baseUrl: string): string {
    const u = new URL(baseUrl);
    return `${u.protocol === 'https:' ? 'wss:' : 'ws:'}//${u.host}/api/websocket`;
  }

  /** Opens the connection and authenticates; rejects on a refused token or a failed connection. */
  connect(url: string, token: string, timeoutMs = 15_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { handshakeTimeout: timeoutMs });
      this.ws = ws;
      let ready = false;
      const fail = (reason: string) => {
        if (!ready) reject(new HaSocketError(reason));
        this.shutdown(reason);
      };
      const timer = setTimeout(() => fail('authentication timed out'), timeoutMs);
      ws.on('message', (raw) => {
        let msg: any;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: token }));
        else if (msg.type === 'auth_ok') {
          ready = true;
          clearTimeout(timer);
          this.version = String(msg.ha_version ?? '');
          resolve();
        } else if (msg.type === 'auth_invalid') {
          clearTimeout(timer);
          fail(`token refused: ${msg.message ?? 'invalid'}`);
        } else this.dispatch(msg);
      });
      ws.on('error', (err) => { clearTimeout(timer); fail(err.message); });
      ws.on('close', () => { clearTimeout(timer); fail('connection closed'); });
    });
  }

  /** A command; resolves with its `result` (rejects with Home Assistant's error). */
  command<T = any>(msg: Record<string, unknown>, timeoutMs = COMMAND_TIMEOUT_MS): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new HaSocketError('not connected'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new HaSocketError(`${String(msg.type)} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ ...msg, id }));
    });
  }

  /** Subscribes to an event type; `handler` gets each event's payload. */
  async subscribe(eventType: string, handler: (event: any) => void): Promise<void> {
    const id = this.nextId; // the id `command` is about to use
    this.listeners.set(id, handler);
    try {
      await this.command({ type: 'subscribe_events', event_type: eventType });
    } catch (err) {
      this.listeners.delete(id);
      throw err;
    }
  }

  close(): void {
    this.shutdown('closed');
  }

  private dispatch(msg: any): void {
    if (msg.type === 'event') {
      this.listeners.get(msg.id)?.(msg.event);
      return;
    }
    if (msg.type !== 'result') return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.success) p.resolve(msg.result);
    else p.reject(new HaSocketError(msg.error?.message ?? 'command failed'));
  }

  private shutdown(reason: string): void {
    const ws = this.ws;
    if (!ws) return;
    this.ws = null;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new HaSocketError(reason)); }
    this.pending.clear();
    this.listeners.clear();
    try { ws.removeAllListeners(); ws.on('error', () => {}); ws.close(); } catch { /* already closed */ }
    const onClose = this.onClose;
    this.onClose = null;
    onClose?.(reason);
  }
}
