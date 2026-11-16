// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Plugin trust and credentials (specs/PLUGINS.md §9, §11): a package's level is the level of the trusted key whose
 * ed25519 signature verifies its SHA-256, else `unsigned`; the plugin token and the page token are each signed with a
 * key of their own — neither is ever accepted as an internal token, as the other, tampered with or expired.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateKeyPairSync, sign } from 'crypto';
import {
  mintPageToken, mintPluginToken, officialKeys, readPageToken, readPluginToken, sha256Hex, trustOf, validPublicKey,
} from '../../src/plugins/plugin-trust';
import { verifyInternalToken } from '../../src/common/internal-token/internal-token';

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64');
  return { raw, pem: publicKey.export({ format: 'pem', type: 'spki' }).toString(), privateKey };
}

describe('plugin signatures', () => {
  const pkg = Buffer.from('a plugin package');
  const sha = sha256Hex(pkg);
  const official = keyPair();
  const community = keyPair();
  const stranger = keyPair();
  const keys = [
    { id: 'community-1', level: 'community' as const, publicKey: community.raw },
    { id: 'official-1', level: 'official' as const, publicKey: official.pem },
  ];
  const signWith = (k: ReturnType<typeof keyPair>) => sign(null, Buffer.from(sha, 'hex'), k.privateKey).toString('base64');

  it('the level is the one of the key that verifies the signature', () => {
    expect(trustOf(sha, signWith(official), keys)).toEqual({ level: 'official', keyId: 'official-1' });
    expect(trustOf(sha, signWith(community), keys)).toEqual({ level: 'community', keyId: 'community-1' });
  });

  it('no signature, a stranger\'s signature, another package or the wrong key id: unsigned', () => {
    expect(trustOf(sha, null, keys).level).toBe('unsigned');
    expect(trustOf(sha, signWith(stranger), keys).level).toBe('unsigned');
    expect(trustOf(sha256Hex(Buffer.from('another package')), signWith(official), keys).level).toBe('unsigned');
    expect(trustOf(sha, signWith(official), keys, 'community-1').level).toBe('unsigned');
    expect(trustOf(sha, 'not base64 !!', keys).level).toBe('unsigned');
  });

  it('reads public keys as raw base64 or PEM; official keys from the environment, malformed ones left out', () => {
    expect(validPublicKey(official.raw)).toBe(true);
    expect(validPublicKey(official.pem)).toBe(true);
    expect(validPublicKey('abc')).toBe(false);
    expect(officialKeys(JSON.stringify([{ id: 'a', publicKey: official.raw }, { id: 'b', publicKey: 'bad' }])))
      .toEqual([{ id: 'a', level: 'official', publicKey: official.raw }]);
    expect(officialKeys('not json')).toEqual([]);
    expect(officialKeys(undefined)).toEqual([]);
  });
});

describe('plugin credentials', () => {
  const previous = process.env.RUN_TOKEN_SECRET;
  beforeAll(() => { process.env.RUN_TOKEN_SECRET = 'test-secret-for-plugin-credentials'; });
  afterAll(() => { process.env.RUN_TOKEN_SECRET = previous; });

  it('a plugin token says which plugin and which token version', () => {
    expect(readPluginToken(mintPluginToken('p1', 3))).toMatchObject({ pid: 'p1', v: 3 });
  });

  it('a tampered, expired or foreign token is refused', () => {
    const t = mintPluginToken('p1', 3);
    const [body, sig] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ pid: 'p2', v: 3 })).toString('base64url');
    expect(readPluginToken(`${forged}.${sig}`)).toBeNull();
    expect(readPluginToken(`${body}.${sig}x`)).toBeNull();
    expect(readPluginToken(`${body}.${sig}.extra`)).toBeNull();
    expect(readPluginToken(mintPluginToken('p1', 3, -1000))).toBeNull();
    expect(readPluginToken(undefined)).toBeNull();
  });

  it('a page token is not a plugin token, a plugin token is not a page token, and neither is an internal token', () => {
    const page = mintPageToken('p1', 'u1');
    const plugin = mintPluginToken('p1', 1);
    expect(readPageToken(page)).toMatchObject({ pid: 'p1', uid: 'u1' });
    expect(readPluginToken(page)).toBeNull();
    expect(readPageToken(plugin)).toBeNull();
    expect(() => verifyInternalToken(plugin)).toThrow();
    expect(() => verifyInternalToken(page)).toThrow();
  });

  it('without a secret nothing is accepted', () => {
    const t = mintPluginToken('p1', 1);
    process.env.RUN_TOKEN_SECRET = '';
    expect(readPluginToken(t)).toBeNull();
    process.env.RUN_TOKEN_SECRET = 'test-secret-for-plugin-credentials';
  });
});
