// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * networks.ts — single source of truth for the job/sandbox network model.
 *
 * ONE vocabulary shared by the two execution paths (skill jobs via the broker, and the
 * run_in_sandbox tool). `internal` is the always-on FLOOR (the backend `/internal/*` API,
 * no WAN); the other tiers add EXTERNAL reach on top (multi-homing):
 *
 *   none      no network at all (max isolation; sandbox only — skills always need `internal`).
 *   internal  backend baseline only (arkimede-internal, internal:true → no route to the WAN).
 *   internet  internal + the egress network (sandboxnet + squid) → only allowlisted domains.
 *   open      internal + the full-internet network (default `bridge`) → no allowlist.
 *
 * `granted` are reserved/custom Docker networks (LAN/VPN, admin-granted per skill) attached
 * ON TOP of the chosen tier. Every resolved name is re-validated by the broker against
 * BROKER_ALLOWED_NETWORKS (double gate) — this module only decides intent.
 */
export type NetworkMode = 'none' | 'internal' | 'internet' | 'open';

// Baseline internal network (backend, no WAN). Name must match the compose network and be in
// the broker's BROKER_ALLOWED_NETWORKS.
const INTERNAL_NET = process.env.JOB_INTERNAL_NETWORK || 'arkimede-internal';
// Egress network (sandboxnet + squid proxy) for the `internet` tier. Empty/'none' → the tier
// degrades to the internal baseline (no external route), backend still reachable.
const EGRESS_NET   = process.env.JOB_EGRESS_NETWORK || '';
// Full-internet network for the `open` tier (no allowlist). Default the Docker `bridge`.
const OPEN_NET     = process.env.SANDBOX_OPEN_NETWORK || 'bridge';
// Operator "global" bucket: extra networks attached to EVERY networked job.
const GLOBAL_NETS  = (process.env.BROKER_GLOBAL_NETWORKS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

/**
 * Resolves a network tier (+ granted reserved nets) to the concrete Docker network list to
 * hand the broker (multi-homing; nets[0] is the `docker run/create --network`, the rest are
 * attached via `docker network connect`). `undefined` is treated as `internal` (the skill-job
 * default: backend baseline). Deduped, baseline first.
 */
export function resolveNetworks(mode: NetworkMode | undefined, granted?: string[]): string[] {
  if (mode === 'none') return ['none'];
  const nets = [INTERNAL_NET];
  for (const g of GLOBAL_NETS) if (!nets.includes(g)) nets.push(g);
  if (mode === 'internet' && EGRESS_NET && EGRESS_NET !== 'none') nets.push(EGRESS_NET);
  if (mode === 'open' && OPEN_NET && OPEN_NET !== 'none') nets.push(OPEN_NET);
  for (const g of granted ?? []) {
    const t = String(g).trim();
    if (t && !nets.includes(t)) nets.push(t);
  }
  return [...new Set(nets)];
}

/** True when the tier routes external traffic through the egress proxy (only `internet`).
 * `open` is direct (no proxy); `internal`/`none` have no external traffic. */
export function usesEgressProxy(mode: NetworkMode | undefined): boolean {
  return mode === 'internet';
}
