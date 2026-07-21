/**
 * L9 regression — for a `mongodb+srv://h/...` connection string the driver connects
 * to the SRV targets of `_mongodb._tcp.h`, not to `h`. The host guard now resolves
 * the SRV record and checks those targets, so a +srv host whose SRV points at an
 * internal endpoint is blocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '10.0.0.5' }]), // SRV target resolves to a private IP
  resolveSrv: vi.fn(async () => [{ name: 'internal-shard.example.net', port: 27017, weight: 1, priority: 1 }]),
}));

import { lookup, resolveSrv } from 'node:dns/promises';
import { assertDataSourceTargetAllowed } from '../../src/common/datasource-host-guard';

const strictPolicy = { allowPrivateHosts: false, allowlist: [] as string[] };

beforeEach(() => { (lookup as any).mockClear(); (resolveSrv as any).mockClear(); });

describe('datasource host guard — +srv target resolution (L9)', () => {
  it('resolves the SRV record and blocks an internal SRV target', async () => {
    await expect(
      assertDataSourceTargetAllowed('mongodb', 'mongodb+srv://cluster.example.net/db', strictPolicy),
    ).rejects.toThrow(/host interno non consentito|SRV/);
    expect(resolveSrv).toHaveBeenCalledWith('_mongodb._tcp.cluster.example.net');
    expect(lookup).toHaveBeenCalledWith('internal-shard.example.net', expect.anything());
  });

  it('does not do an SRV lookup for a plain mongodb:// string', async () => {
    // Non-srv host also resolves to 10.0.0.5 (private) → blocked, but via a direct A lookup.
    await expect(
      assertDataSourceTargetAllowed('mongodb', 'mongodb://plain-host.example.net:27017/db', strictPolicy),
    ).rejects.toThrow(/host interno non consentito/);
    expect(resolveSrv).not.toHaveBeenCalled();
    expect(lookup).toHaveBeenCalledWith('plain-host.example.net', expect.anything());
  });
});
