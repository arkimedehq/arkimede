// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file ssrf-guard.ts
 *
 * Anti-SSRF guard for user-controlled outbound HTTP calls
 * (custom `http` tool, `http`/`sse` MCP servers).
 *
 * Blocks internal/reserved destinations — in particular the EC2 metadata
 * endpoint (169.254.169.254), from which IAM credentials can be stolen — and
 * private/loopback/link-local addresses, from which internal services (DB,
 * Redis, the backend itself) can be reached bypassing authentication.
 *
 * Strategy: parse the URL, check the protocol (http/https only),
 * RESOLVE the hostname and check that NONE of the resolved IPs fall into
 * a reserved range (so a public hostname pointing to an internal IP is
 * blocked anyway).
 *
 * Known residual: DNS rebinding (the host resolves to a public IP at the check
 * and to a private one on the subsequent fetch). To fully close it, pinning
 * the resolved IP + fetch by-IP with a Host header would be needed — a future
 * evolution.
 */
import { ForbiddenException } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

/**
 * True unless the IP is unambiguously public (default-deny). Delegates the
 * classification to a real IP parser instead of string/regex prefix matching,
 * which missed non-dotted encodings — e.g. the IPv4-mapped `::ffff:7f00:1`
 * (= 127.0.0.1) or `::ffff:a9fe:a9fe` (= 169.254.169.254 metadata) slipped
 * through as "public". An IPv4-mapped address is unwrapped to its embedded v4
 * and classified there; anything whose range is not `unicast` (the only publicly
 * routable class for both families) — loopback, private, link-local, CGNAT,
 * unique-local, NAT64/6to4/teredo, reserved, unparseable — is treated as internal.
 */
export function isPrivateIp(ip: string): boolean {
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.parse(ip.replace(/^\[|\]$/g, ''));
  } catch {
    return true; // unparseable → fail-closed
  }
  if (addr.kind() === 'ipv6') {
    const v6 = addr as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) return v6.toIPv4Address().range() !== 'unicast';
    return v6.range() !== 'unicast';
  }
  return (addr as ipaddr.IPv4).range() !== 'unicast';
}

/**
 * True only for link-local / cloud-metadata ranges (169.254.0.0/16, fe80::/10) —
 * ALWAYS blocked, independent of any policy or allowlist. Uses a real IP parser so
 * that non-dotted encodings of the metadata address (e.g. `::ffff:a9fe:a9fe`, the
 * IPv4-mapped form of 169.254.169.254) cannot slip past the invariant.
 */
export function isLinkLocalIp(ip: string): boolean {
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.parse(ip.replace(/^\[|\]$/g, ''));
  } catch {
    return false; // unparseable → not classified as link-local (still caught by isPrivateIp/fail-closed)
  }
  if (addr.kind() === 'ipv6') {
    const v6 = addr as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) return v6.toIPv4Address().range() === 'linkLocal';
    return v6.range() === 'linkLocal';
  }
  return (addr as ipaddr.IPv4).range() === 'linkLocal';
}

/**
 * Destination policy for user-configured outbound HTTP (MCP servers today).
 * Link-local/metadata stays blocked regardless. The default (no policy) is the
 * historical strict behavior: only public hosts.
 */
export interface HttpHostPolicy {
  /** If true, private/loopback/CGNAT hosts are allowed (metadata is still blocked). */
  allowPrivateHosts: boolean;
  /** Host names, IPs or IPv4 CIDRs allowed even when allowPrivateHosts is false. */
  allowlist: string[];
}

/** IPv4 CIDR membership (e.g. "10.0.0.0/8"). IPv6/exact handled by the caller. */
function ipv4InCidr(ip: string, cidr: string): boolean {
  const [net, bitsStr] = cidr.split('/');
  if (isIP(ip) !== 4 || isIP(net) !== 4) return false;
  const bits = Number(bitsStr);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const toInt = (a: string) => a.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (toInt(ip) & mask) === (toInt(net) & mask);
}

/** True if `host`/`ip` matches an allowlist entry (hostname, IP, or IPv4 CIDR). */
export function matchesHostAllowlist(host: string, ip: string, allowlist: string[]): boolean {
  const h = host.toLowerCase();
  for (const entry of allowlist) {
    const a = entry.trim();
    if (!a) continue;
    if (a.toLowerCase() === h) return true;   // hostname
    if (a === ip) return true;                // exact IP
    if (a.includes('/') && ipv4InCidr(ip, a)) return true; // CIDR
  }
  return false;
}

/**
 * Throws ForbiddenException if the URL is not http/https or if the hostname resolves
 * (even only in part) to a disallowed address. Without a policy only public hosts
 * pass (historical strict behavior); with a policy, private hosts are gated by
 * `allowPrivateHosts`/`allowlist` while link-local/metadata is always blocked.
 */
export async function assertPublicUrl(rawUrl: string, policy?: HttpHostPolicy): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ForbiddenException(`Invalid URL: ${rawUrl}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ForbiddenException(`Protocol not allowed (only http/https): ${url.protocol}`);
  }

  const host = url.hostname.replace(/^\[|\]$/g, '');

  const check = (ip: string) => {
    const shown = ip === host ? host : `${host} → ${ip}`;
    if (isLinkLocalIp(ip)) {
      throw new ForbiddenException(`Metadata/link-local destination always blocked: ${shown}`);
    }
    if (isPrivateIp(ip)) {
      const allowed = policy
        ? policy.allowPrivateHosts || matchesHostAllowlist(host, ip, policy.allowlist)
        : false;
      if (!allowed) {
        throw new ForbiddenException(`Internal destination not allowed: ${shown}`);
      }
    }
  };

  // Literal IP → direct check
  if (isIP(host)) {
    check(host);
    return;
  }

  // Hostname → resolve and check ALL the IPs
  let addrs: { address: string }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new ForbiddenException(`Host non risolvibile: ${host}`);
  }
  for (const a of addrs) {
    check(a.address);
  }
}

/** Max redirect hops followed by safeFetch before giving up. */
const MAX_REDIRECTS = 5;
/** Headers dropped when a redirect crosses to a different origin (avoid credential leak). */
const CROSS_ORIGIN_STRIP = ['authorization', 'cookie', 'proxy-authorization'];

/**
 * fetch() with the anti-SSRF guard applied to the initial URL AND to every redirect
 * hop. The default fetch follows redirects transparently, which would bypass a
 * one-shot `assertPublicUrl` check (a public URL that 302s to 169.254.169.254 or
 * localhost). Here redirects are followed MANUALLY, re-validating each `Location`.
 *
 * Redirect method/body semantics (client-API oriented, not browser):
 *   - 303        → GET, body dropped (the literal meaning of 303).
 *   - 301/302/307/308 → method + body preserved (so an http→https upgrade of a POST
 *     keeps working — the common real case; the destination is re-validated anyway).
 * Credentials (Authorization/Cookie) are stripped on cross-origin hops, mirroring
 * what the browser/undici follow does automatically.
 */
export async function safeFetch(
  rawUrl: string,
  init: RequestInit = {},
  policy?: HttpHostPolicy,
): Promise<Response> {
  let url = rawUrl;
  let method = (init.method ?? 'GET').toUpperCase();
  let body = init.body;
  const headers = new Headers(init.headers as HeadersInit | undefined);

  for (let hop = 0; ; hop++) {
    await assertPublicUrl(url, policy);
    const resp = await fetch(url, { ...init, method, body, headers, redirect: 'manual' });

    const isRedirect = resp.status >= 300 && resp.status < 400 && resp.status !== 304;
    const loc = isRedirect ? resp.headers.get('location') : null;
    if (!loc) return resp;

    if (hop >= MAX_REDIRECTS) {
      throw new ForbiddenException(`Too many redirects (>${MAX_REDIRECTS})`);
    }

    const prevOrigin = new URL(url).origin;
    const next = new URL(loc, url); // resolves relative Location against the current URL

    if (resp.status === 303 && method !== 'HEAD') {
      method = 'GET';
      body = undefined;
      headers.delete('content-type');
      headers.delete('content-length');
    }
    if (next.origin !== prevOrigin) {
      for (const h of CROSS_ORIGIN_STRIP) headers.delete(h);
    }
    await resp.body?.cancel().catch(() => { /* body already consumed */ });
    url = next.toString();
  }
}
