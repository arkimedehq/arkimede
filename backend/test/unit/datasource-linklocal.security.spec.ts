/**
 * H2 regression — `datasource-host-guard.isLinkLocalIp` classifies the cloud
 * metadata / link-local ranges (ALWAYS blocked, independent of admin config) using
 * a real IP parser. The old dotted-only regex missed `::ffff:a9fe:a9fe`, the
 * IPv4-mapped hex form of the 169.254.169.254 metadata endpoint.
 */
import { describe, it, expect } from 'vitest';
import { isLinkLocalIp } from '../../src/common/datasource-host-guard';

describe('isLinkLocalIp — metadata/link-local always blocked (H2)', () => {
  it.each([
    '169.254.169.254',   // EC2/GCP/Azure metadata
    '169.254.0.1',       // link-local
    'fe80::1',           // IPv6 link-local
    '::ffff:a9fe:a9fe',  // IPv4-mapped hex form of 169.254.169.254 (the bypass)
    '::ffff:169.254.169.254',
  ])('%s is link-local', (ip) => {
    expect(isLinkLocalIp(ip)).toBe(true);
  });

  it.each([
    '10.0.0.5',          // private, but NOT link-local (config-gated, not "always")
    '127.0.0.1',         // loopback, not link-local
    '8.8.8.8',           // public
    '::ffff:7f00:1',     // mapped loopback, not link-local
    'not-an-ip',         // unparseable → not classified as link-local
  ])('%s is NOT link-local', (ip) => {
    expect(isLinkLocalIp(ip)).toBe(false);
  });
});
