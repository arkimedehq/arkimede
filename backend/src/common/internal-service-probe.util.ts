// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Detects at runtime whether a bundled internal service (e.g. the whisper or
 * piper container) is deployed. A deployment may leave these services out
 * (compose overlay without them): the hostname then does not resolve or the
 * connection is refused, while a deployed service answers — even with an error
 * status while it is still loading its model, which still counts as present.
 *
 * Results are cached per URL for a short TTL: callers include per-request
 * status endpoints and the answer only changes when the deployment changes.
 */

const TTL_MS = 30_000;
const TIMEOUT_MS = 2_000;

const cache = new Map<string, { value: boolean; at: number }>();

/**
 * True if the service behind `baseUrl` (an OpenAI-compatible `/v1` base) is
 * reachable. Probes `<origin>/health`; any HTTP response means "deployed".
 */
export async function isInternalServiceAvailable(baseUrl: string): Promise<boolean> {
  const hit = cache.get(baseUrl);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  let value = false;
  try {
    const healthUrl = new URL('/health', baseUrl).toString();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      await fetch(healthUrl, { signal: ctrl.signal });
      value = true;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    value = false;
  }
  cache.set(baseUrl, { value, at: Date.now() });
  return value;
}
