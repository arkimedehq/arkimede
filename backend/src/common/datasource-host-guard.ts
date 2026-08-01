// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file datasource-host-guard.ts
 *
 * Anti-SSRF guard for DataSource / DB connections (SQL, Mongo, Redis, file-share).
 *
 * The HTTP channel (custom `http` tool, `http`/`sse` MCP) is already protected by
 * ssrf-guard.ts. DataSource drivers, instead, connect straight to a user-supplied
 * connection string — a side channel that lets a DB tool reach `localhost`, the
 * private LAN, or the cloud metadata endpoint (169.254.169.254 → IAM credential
 * theft). This guard extracts the target host(s) from the connection string,
 * resolves DNS, and enforces a policy.
 *
 * Policy:
 *   - link-local / cloud-metadata (169.254.0.0/16, IPv6 fe80::/10) → ALWAYS blocked,
 *     regardless of config or allowlist.
 *   - other private/loopback/CGNAT → blocked UNLESS `allowPrivateHosts` (default true,
 *     for self-hosted DBs on LAN/localhost) OR the host/IP matches the allowlist.
 *   - public hosts → allowed.
 *
 * DNS is resolved at every call (the guard sits on the resolve/test choke points):
 * re-resolving per run mitigates DNS-rebinding between check and connect.
 */
import { ForbiddenException } from '@nestjs/common';
import { lookup, resolveSrv } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isPrivateIp, isLinkLocalIp, matchesHostAllowlist, HttpHostPolicy } from './ssrf-guard';

// Same shape as the HTTP policy — one vocabulary for every outbound guard.
export type DataSourceHostPolicy = HttpHostPolicy;

// Re-exported for existing call sites/tests (implementation moved to ssrf-guard).
export { isLinkLocalIp };

/** Host part of a `host[:port]` token, handling IPv6 literals `[::1]:5432`. */
function extractHost(hostPort: string): string {
  let s = (hostPort || '').trim();
  if (!s) return '';
  if (s.startsWith('[')) {                 // IPv6 literal in brackets
    const end = s.indexOf(']');
    return end > 0 ? s.slice(1, end) : s.slice(1);
  }
  if (isIP(s) === 6) return s;             // bare IPv6 (no port)
  const colon = s.indexOf(':');            // host:port → strip port
  if (colon >= 0) s = s.slice(0, colon);
  return s;
}

/** Hosts from a URI-form connection string (supports multi-host authority, e.g. mongodb). */
function hostsFromUri(raw: string): string[] {
  const m = raw.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i);
  if (!m) return [];
  let authority = m[1];
  const at = authority.lastIndexOf('@');   // strip credentials (user:pass@)
  if (at >= 0) authority = authority.slice(at + 1);
  return authority.split(',').map(extractHost).filter(Boolean);
}

/** Hosts from a key=value ADO/ODBC string (mssql: `Server=host,port;...`). */
function hostsFromKeyValue(raw: string): string[] {
  const KEYS = ['server', 'data source', 'address', 'addr', 'network address', 'host', 'hostname'];
  const hosts: string[] = [];
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    if (!KEYS.includes(key)) continue;
    let val = part.slice(eq + 1).trim().replace(/^tcp:/i, ''); // strip protocol prefix
    val = val.split('\\')[0];  // host\instance
    val = val.split(',')[0];   // host,port
    const h = extractHost(val);
    if (h) hosts.push(h);
  }
  return hosts;
}

/**
 * Extracts the target host(s) from a DataSource connection string, per engine.
 * Returns [] for engines with no network target (sqlite, virtual `local`) or when
 * the host cannot be determined (the driver would then fail to connect anyway).
 */
export function hostsFromConnString(engine: string, connStr: string): string[] {
  const e = (engine || '').toLowerCase();
  if (e === 'sqlite' || e === 'local') return [];
  const raw = (connStr || '').trim();
  if (!raw) return [];

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  if (!hasScheme) {
    // Oracle EZConnect: host[:port]/service  (no scheme, no key=value)
    if (e === 'oracle' && !/[=;]/.test(raw)) {
      const h = extractHost(raw.split('/')[0]);
      return h ? [h] : [];
    }
    // Key=value ADO/ODBC (mssql and friends)
    if (/[=;]/.test(raw)) return hostsFromKeyValue(raw);
    // Bare host[:port]
    const h = extractHost(raw.split('/')[0]);
    return h ? [h] : [];
  }
  return hostsFromUri(raw);
}

/**
 * Throws ForbiddenException if the connection string targets a disallowed host.
 * No-op when no network host is involved (sqlite / local / unparseable).
 */
export async function assertDataSourceTargetAllowed(
  engine: string,
  connStr: string,
  policy: DataSourceHostPolicy,
): Promise<void> {
  let hosts = hostsFromConnString(engine, connStr);

  // `mongodb+srv://h/...` does NOT connect to `h`: the driver resolves the SRV record
  // `_mongodb._tcp.h` and connects to the returned targets. Check THOSE, so a crafted
  // +srv host whose SRV points at internal endpoints can't slip past the guard.
  if (/^[a-z][a-z0-9+.-]*\+srv:\/\//i.test((connStr || '').trim())) {
    const targets: string[] = [];
    for (const h of hosts) {
      try {
        for (const rec of await resolveSrv(`_mongodb._tcp.${h}`)) targets.push(rec.name);
      } catch {
        throw new ForbiddenException(`DataSource SRV non risolvibile: ${h}`);
      }
    }
    if (targets.length) hosts = targets;
  }

  for (const host of hosts) {
    let ips: string[];
    if (isIP(host)) {
      ips = [host];
    } else {
      try {
        ips = (await lookup(host, { all: true })).map((a) => a.address);
      } catch {
        throw new ForbiddenException(`DataSource host non risolvibile: ${host}`);
      }
    }
    for (const ip of ips) {
      const shown = ip === host ? host : `${host} → ${ip}`;
      if (isLinkLocalIp(ip)) {
        throw new ForbiddenException(`DataSource: destinazione metadata/link-local bloccata (${shown}).`);
      }
      if (isPrivateIp(ip)) {
        const allowed = policy.allowPrivateHosts || matchesHostAllowlist(host, ip, policy.allowlist);
        if (!allowed) {
          throw new ForbiddenException(`DataSource: host interno non consentito (${shown}).`);
        }
      }
    }
  }
}
