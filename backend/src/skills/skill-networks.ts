/**
 * Reserved-network catalog (Phase 3) + skill → executor network params.
 *
 * The operator describes the assignable reserved networks (LAN/VPN/subnets) in the
 * `SKILL_NETWORK_CATALOG` env as a JSON array of { id, dockerNetwork, label, description }.
 * The admin then grants some of these (by `id`) to individual skills (Skill.grantedNetworks).
 * At invocation we resolve the granted ids → real Docker network names and hand them to the
 * executor, which multi-homes the job onto them (the broker re-validates each).
 *
 * Domain egress (Skill.networkDomains, author-declared) is a SEPARATE channel: it maps to the
 * `network: 'internet'` tier (squid allowlist), not to a reserved network.
 */

/**
 * Network tier vocabulary shared by skill jobs and the sandbox (mirrors the executor's
 * runners/networks.ts). `internal` is the always-on floor (backend, no WAN); the tiers add
 * external reach: `internet` = squid allowlist, `open` = full internet. `none` = no network.
 */
export type NetworkMode = 'none' | 'internal' | 'internet' | 'open';

export interface SkillNetwork {
  /** Stable id referenced by Skill.grantedNetworks and the admin UI. */
  id: string;
  /** Real Docker network name (must also be in the broker's BROKER_ALLOWED_NETWORKS). */
  dockerNetwork: string;
  /** Human-readable label for the admin UI. */
  label: string;
  /** Optional description (e.g. "SMB 192.168.1.0/24"). */
  description: string;
  /** Presentation category: 'lan' = a well-known LAN/VPN preset, 'custom' = arbitrary
   * operator-defined reserved network. Defaults to 'custom' (or 'lan' when id === 'lan'). */
  kind: 'lan' | 'custom';
}

let cached: SkillNetwork[] | null = null;

/** Parsed reserved-network catalog from SKILL_NETWORK_CATALOG (cached). Empty on absence/parse error. */
export function networkCatalog(): SkillNetwork[] {
  if (cached) return cached;
  const raw = process.env.SKILL_NETWORK_CATALOG || '[]';
  try {
    const arr = JSON.parse(raw);
    cached = Array.isArray(arr)
      ? arr
          .filter((e) => e && typeof e.id === 'string' && typeof e.dockerNetwork === 'string')
          .map((e) => ({
            id: String(e.id),
            dockerNetwork: String(e.dockerNetwork),
            label: typeof e.label === 'string' && e.label ? e.label : String(e.id),
            description: typeof e.description === 'string' ? e.description : '',
            kind: (e.kind === 'lan' || String(e.id) === 'lan') ? 'lan' as const : 'custom' as const,
          }))
      : [];
  } catch {
    cached = [];
  }
  return cached;
}

/** Valid catalog ids (for validating admin grants). */
export function validNetworkIds(): Set<string> {
  return new Set(networkCatalog().map((e) => e.id));
}

/** Resolves granted catalog ids → Docker network names (silently drops unknown ids). */
export function resolveGrantedNetworks(grantedIds: string[] | undefined): string[] {
  if (!grantedIds?.length) return [];
  const byId = new Map(networkCatalog().map((e) => [e.id, e.dockerNetwork]));
  return grantedIds.map((id) => byId.get(id)).filter((n): n is string => !!n);
}

/**
 * Network params for a skill invocation:
 *  - `network: 'internet'` if the skill declared external domains (runtime.network) → egress
 *    via the squid allowlist; omitted otherwise (the executor defaults to the `internal`
 *    baseline: backend only, no WAN);
 *  - `grantedNetworks`: the resolved Docker names of the reserved networks granted to it.
 * The baseline internal BE network is added by the executor for every job.
 */
export function skillNetworkParams(skill: {
  networkDomains?: string[] | null;
  grantedNetworks?: string[] | null;
}): { network?: 'internet'; grantedNetworks?: string[] } {
  const out: { network?: 'internet'; grantedNetworks?: string[] } = {};
  if (skill.networkDomains?.length) out.network = 'internet';
  const granted = resolveGrantedNetworks(skill.grantedNetworks ?? undefined);
  if (granted.length) out.grantedNetworks = granted;
  return out;
}
