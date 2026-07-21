/**
 * SSRF guard (P0/E2) — `common/ssrf-guard.ts`.
 *
 * Security invariant: internal/reserved destinations (EC2 metadata,
 * loopback, RFC1918, link-local) and non-http/https protocols are REJECTED,
 * while public IPs pass. Migrated from `scripts/smoke-ssrf.ts`.
 */
import { describe, it, expect } from 'vitest';
import { assertPublicUrl, isPrivateIp } from '../../src/common/ssrf-guard';

describe('SSRF guard — destinazioni bloccate', () => {
  const blocked: [string, string][] = [
    ['metadata EC2 (furto IAM)', 'http://169.254.169.254/latest/meta-data/iam/security-credentials/'],
    ['loopback IPv4', 'http://127.0.0.1:5432'],
    ['RFC1918 10/8', 'http://10.0.0.5/internal'],
    ['RFC1918 192.168/16', 'http://192.168.1.10'],
    ['RFC1918 172.16/12', 'http://172.16.0.1'],
    ['loopback IPv6', 'http://[::1]:6379'],
    ['localhost (risolve a loopback)', 'http://localhost:3000'],
  ];
  for (const [label, url] of blocked) {
    it(`blocca ${label}`, async () => {
      await expect(assertPublicUrl(url)).rejects.toThrow();
    });
  }

  it('blocca i protocolli non http/https con messaggio esplicito', async () => {
    await expect(assertPublicUrl('ftp://example.com/file')).rejects.toThrow(/Protocol not allowed/);
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toThrow(/Protocol not allowed/);
  });

  it('il messaggio per la destinazione interna nomina l\'host (utente informato)', async () => {
    await expect(assertPublicUrl('http://169.254.169.254/')).rejects.toThrow(/Internal destination not allowed: 169\.254\.169\.254/);
  });

  // H2 — non-dotted IPv6 encodings that the old regex-based classifier let through.
  const bypasses: [string, string][] = [
    ['IPv4-mapped hex loopback', 'http://[::ffff:7f00:1]/'],
    ['IPv4-mapped hex metadata EC2', 'http://[::ffff:a9fe:a9fe]/latest/meta-data/'],
    ['NAT64 embedded metadata', 'http://[64:ff9b::a9fe:a9fe]/'],
    ['6to4 embedding loopback', 'http://[2002:7f00:1::1]/'],
  ];
  for (const [label, url] of bypasses) {
    it(`blocca il bypass ${label}`, async () => {
      await expect(assertPublicUrl(url)).rejects.toThrow();
    });
  }
});

describe('SSRF guard — destinazioni consentite', () => {
  it('permette gli IP pubblici letterali', async () => {
    await expect(assertPublicUrl('http://1.1.1.1/')).resolves.toBeUndefined();
    await expect(assertPublicUrl('https://8.8.8.8/')).resolves.toBeUndefined();
  });
});

describe('isPrivateIp — classificazione range', () => {
  it.each([
    '0.0.0.0', '10.1.2.3', '127.0.0.1', '169.254.1.1', '172.16.0.1', '192.168.0.1', '100.64.0.1',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', '::ffff:127.0.0.1',
    // H2 — non-dotted / embedded encodings the regex classifier missed
    '::ffff:7f00:1', '::ffff:a9fe:a9fe', '64:ff9b::a9fe:a9fe', '2002:7f00:1::1',
    'not-an-ip',
  ])('%s è privato/riservato', (ip) => {
    expect(isPrivateIp(ip)).toBe(true);
  });

  it.each(['1.1.1.1', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700::1'])(
    '%s è pubblico',
    (ip) => {
      expect(isPrivateIp(ip)).toBe(false);
    },
  );
});
