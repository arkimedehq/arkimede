// GENERATED from recordare packages/client/src/http.ts @ 4bd90f7 — do not edit here: change the library and run
// packages/client/scripts/sync-to.sh again.
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { USER_HEADER } from './contract.js';
import { type Problem, RecordareHttpError, RecordareUnavailableError } from './errors.js';

/** The standard fetch signature; a host may pass its own (e.g. one enforcing an outbound-host policy). */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface ClientOptions {
  /** Recordare's address, e.g. `http://recordare:8080`. */
  baseUrl: string;
  /** The platform's client key (or a personal token for a single-person client). */
  apiKey: string;
  fetch?: FetchLike;
  /** Per request; default 15 s. */
  timeoutMs?: number;
  /**
   * Extra headers for every request, e.g. W3C trace context (`traceparent`, `tracestate`) from the host's
   * OpenTelemetry, so the host's spans and Recordare's work line up.
   */
  headers?: () => Record<string, string>;
}

export interface RequestOptions {
  /** The client's user the request acts for. */
  user?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

/** Parses `Retry-After` (seconds or an HTTP date) into milliseconds from now. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

export class Http {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(readonly options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  url(path: string): string {
    return `${this.baseUrl}/${path.replace(/^\/+/, '')}`;
  }

  /** Headers every request carries: credential, user, the host's extra headers. */
  headers(user?: string, extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.options.apiKey}`,
      ...(user ? { [USER_HEADER]: user } : {}),
      ...(this.options.headers?.() ?? {}),
      ...extra,
    };
  }

  get fetch(): FetchLike {
    return this.fetchImpl;
  }

  /** One JSON request; the parsed body (undefined when empty). Throws RecordareHttpError / RecordareUnavailableError. */
  async request<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, opts: RequestOptions = {}): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(path), {
        method,
        headers: this.headers(opts.user, {
          ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          Accept: 'application/json, application/problem+json',
          ...opts.headers,
        }),
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
      });
    } catch (err) {
      throw new RecordareUnavailableError(`Recordare ${method} ${path}: ${(err as Error)?.name ?? 'error'}`, err);
    }
    const text = await res.text();
    if (!res.ok) {
      let problem: Problem = { status: res.status, title: res.statusText };
      try { problem = { ...problem, ...(JSON.parse(text) as Problem) }; } catch { /* not JSON */ }
      throw new RecordareHttpError(res.status, problem, parseRetryAfter(res.headers.get('retry-after')));
    }
    return (text.trim() ? JSON.parse(text) : undefined) as T;
  }
}
