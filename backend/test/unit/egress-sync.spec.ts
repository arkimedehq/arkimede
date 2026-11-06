// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * The skills' egress allowlist written for Squid (egress-sync.service.ts): domains as `dstdomain`, IP ranges (a
 * protocol that connects by address, such as Telegram's MTProto) as `dst`; anything else — a malformed entry, a range
 * wide enough to open the internet, an attempt to inject a Squid directive — is dropped.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EgressSyncService, ipRange } from '../../src/skills/egress-sync.service';

describe('ipRange', () => {
  it('accepts IPv4 and IPv6 ranges in CIDR notation', () => {
    expect(ipRange('149.154.160.0/20')).toBe('149.154.160.0/20');
    expect(ipRange('91.108.4.0/22')).toBe('91.108.4.0/22');
    expect(ipRange('2001:b28:f23d::/48')).toBe('2001:b28:f23d::/48');
  });

  it('refuses a bare address, a range too wide, garbage and injections', () => {
    for (const bad of ['149.154.167.51', '0.0.0.0/0', '10.0.0.0/7', '::/0', '300.1.1.1/24', '1.2.3.4/24/1', '1.2.3.4/x', '1.2.3.4/24\nhttp_access allow all']) {
      expect(ipRange(bad)).toBeNull();
    }
  });
});

describe('EgressSyncService.sync', () => {
  let dir: string;
  let service: EgressSyncService;
  const file = () => fs.readFileSync(path.join(dir, 'skill-domains.conf'), 'utf8');

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-'));
    service = new EgressSyncService({ get: () => dir } as any);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('writes domains as dstdomain and IP ranges as dst; drops what is neither', async () => {
    await service.sync(['api.telegram.org', '149.154.160.0/20', '91.108.4.0/22', '0.0.0.0/0', 'bad domain', '']);
    const lines = file().split('\n').filter((l) => l.startsWith('acl '));
    expect(lines).toEqual([
      'acl allowed_domains dstdomain api.telegram.org',
      'acl allowed_dst dst 149.154.160.0/20',
      'acl allowed_dst dst 91.108.4.0/22',
    ]);
  });

  it('domains only: the file is as before (no IP-range line)', async () => {
    await service.sync(['.open-meteo.com']);
    expect(file()).not.toContain('IP ranges');
    expect(file()).toContain('acl allowed_domains dstdomain .open-meteo.com');
  });
});
