// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file recordare.config.ts
 *
 * Recordare (external episodic memory / digital-twin service) — configuration and
 * the one client every Recordare component uses: the shared client library
 * (npm `@arkimedehq/recordare-client`).
 *
 * The connection comes from the admin's settings (Settings → Memory → Recordare, stored
 * encrypted in app_config and handed over here by AppConfigService) or, field by field when
 * a setting is empty, from RECORDARE_URL / RECORDARE_API_KEY / RECORDARE_WEBHOOK_SECRET.
 * OFF unless a URL and a key are known: then nothing is enqueued, no tool is offered —
 * Arkimede behaves as before. A change applies at once (read per call; listeners told).
 * The URL is set by the operator (trusted), so private hosts are allowed
 * (Recordare usually runs on the same network); cloud-metadata hosts stay
 * blocked by safeFetch, which the client uses for every request (MCP included).
 */
import { context, propagation } from '@opentelemetry/api';
import { HttpHostPolicy, safeFetch } from '../common/ssrf-guard';
import { RecordareClient } from '@arkimedehq/recordare-client';

export interface RecordareConfig {
  /** Base URL without trailing slash (e.g. http://recordare:8080). */
  url: string;
  /** Client API key (rk_…), sent as Bearer. Secret. */
  apiKey: string;
}

/** Operator-configured endpoint: private hosts allowed, metadata still blocked. */
export const RECORDARE_HOST_POLICY: HttpHostPolicy = { allowPrivateHosts: true, allowlist: [] };

/** The admin's stored settings (decrypted); an empty field falls back to the environment. */
export interface RecordareSettings {
  url: string | null;
  apiKey: string | null;
  webhookSecret: string | null;
}

let stored: RecordareSettings = { url: null, apiKey: null, webhookSecret: null };
const listeners = new Set<() => void>();
let lastWebhook: { at: string; type: string } | null = null;

/** Set by AppConfigService at start-up and on every change; the listeners are told. */
export function setRecordareSettings(settings: RecordareSettings): void {
  stored = { ...settings };
  for (const l of listeners) {
    try { l(); } catch { /* a listener's failure is its own */ }
  }
}

/** Called whenever the settings change (services start what needs Recordare); returns the unsubscribe. */
export function onRecordareSettingsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Where each value comes from: the settings, the environment, or nowhere. */
export function recordareSources(): { url: 'settings' | 'env' | null; apiKey: 'settings' | 'env' | null; webhookSecret: 'settings' | 'env' | null } {
  const src = (own: string | null, env: string | undefined) => (own?.trim() ? 'settings' : env?.trim() ? 'env' : null);
  return {
    url: src(stored.url, process.env.RECORDARE_URL),
    apiKey: src(stored.apiKey, process.env.RECORDARE_API_KEY),
    webhookSecret: src(stored.webhookSecret, process.env.RECORDARE_WEBHOOK_SECRET),
  };
}

/** Current configuration, or null when Recordare is not configured (read per call, cheap). */
export function recordareConfig(): RecordareConfig | null {
  const url = stored.url?.trim() || process.env.RECORDARE_URL?.trim();
  const apiKey = stored.apiKey?.trim() || process.env.RECORDARE_API_KEY?.trim();
  if (!url || !apiKey) return null;
  return { url: url.replace(/\/+$/, ''), apiKey };
}

/** The webhook endpoint's `whsec_` secret, or null (the webhook is then off). */
export function recordareWebhookSecret(): string | null {
  return stored.webhookSecret?.trim() || process.env.RECORDARE_WEBHOOK_SECRET?.trim() || null;
}

/** The last verified webhook delivery since start-up (shown to the admin), recorded by the webhook controller. */
export function noteRecordareWebhook(type: string, at = new Date()): void {
  lastWebhook = { at: at.toISOString(), type };
}

export function lastRecordareWebhook(): { at: string; type: string } | null {
  return lastWebhook;
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
