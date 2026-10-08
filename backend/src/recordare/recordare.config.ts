// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file recordare.config.ts
 *
 * Recordare (external episodic memory / digital-twin service) — configuration and
 * the one client every Recordare component uses: the shared client library
 * (`./client`, synced from Recordare's packages/client — never edited here).
 *
 * OFF unless both RECORDARE_URL and RECORDARE_API_KEY are set: then nothing is
 * enqueued, no worker runs, no tool is offered — Arkimede behaves as before.
 * The URL is set by the operator (trusted), so private hosts are allowed
 * (Recordare usually runs on the same network); cloud-metadata hosts stay
 * blocked by safeFetch, which the client uses for every request (MCP included).
 */
import { context, propagation } from '@opentelemetry/api';
import { HttpHostPolicy, safeFetch } from '../common/ssrf-guard';
import { RecordareClient } from './client';

export interface RecordareConfig {
  /** Base URL without trailing slash (e.g. http://recordare:8080). */
  url: string;
  /** Client API key (rk_…), sent as Bearer. Secret. */
  apiKey: string;
}

/** Operator-configured endpoint: private hosts allowed, metadata still blocked. */
export const RECORDARE_HOST_POLICY: HttpHostPolicy = { allowPrivateHosts: true, allowlist: [] };

/** Current configuration, or null when Recordare is not configured (read per call: env-driven, cheap). */
export function recordareConfig(): RecordareConfig | null {
  const url = process.env.RECORDARE_URL?.trim();
  const apiKey = process.env.RECORDARE_API_KEY?.trim();
  if (!url || !apiKey) return null;
  return { url: url.replace(/\/+$/, ''), apiKey };
}

let shared: { key: string; client: RecordareClient } | null = null;

/**
 * The shared client for the current configuration, or null when Recordare is not configured. Requests go through
 * safeFetch and carry the active W3C trace context (traceparent), so Arkimede's spans and Recordare's work line up.
 */
export function recordareClient(): RecordareClient | null {
  const cfg = recordareConfig();
  if (!cfg) return null;
  const key = `${cfg.url}\u0000${cfg.apiKey}`;
  if (shared?.key !== key) {
    void shared?.client.close();
    shared = {
      key,
      client: new RecordareClient({
        baseUrl: cfg.url,
        apiKey: cfg.apiKey,
        fetch: (input, init) => safeFetch(String(input), init, RECORDARE_HOST_POLICY),
        headers: () => {
          const carrier: Record<string, string> = {};
          propagation.inject(context.active(), carrier);
          return carrier;
        },
        mcp: { clientInfo: { name: 'arkimede', version: '1' } },
      }),
    };
  }
  return shared.client;
}
