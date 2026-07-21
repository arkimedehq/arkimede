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
import ipaddr from 'ipaddr.js';
import { isPrivateIp } from './ssrf-guard';

export interface DataSourceHostPolicy {
  /** If true, private/loopback/CGNAT hosts are allowed (metadata is still blocked). */
  allowPrivateHosts: boolean;
  /** Host names, IPs or CIDRs allowed even when allowPrivateHosts is false. */
  allowlist: string[];
}

/**
 * True only for link-local / cloud-metadata ranges (169.254.0.0/16, fe80::/10) —
 * ALWAYS blocked, independent of config/allowlist. Uses a real IP parser so that
 * non-dotted encodings of the metadata address (e.g. `::ffff:a9fe:a9fe`, the
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
function matchesAllowlist(host: string, ip: string, allowlist: string[]): boolean {
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
        const allowed = policy.allowPrivateHosts || matchesAllowlist(host, ip, policy.allowlist);
        if (!allowed) {
          throw new ForbiddenException(`DataSource: host interno non consentito (${shown}).`);
        }
      }
    }
  }
}
