// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { describe, it, expect } from 'vitest';
import {
  buildDestinationUrl, parseDestinationUrl, describeDestination, destinationFields, toRcloneEnv,
} from '../../src/backup/host-backup-destination';

describe('host backup network destination', () => {
  it('round-trips an SMB destination with domain, special characters and a nested folder', () => {
    const url = buildDestinationUrl({
      type: 'smb', host: 'nas.lan', share: 'Backup', path: '/servers/arkimede/', domain: 'WORKGROUP',
      username: 'backup user', password: 'p@ss:w/rd;%',
    });
    const d = parseDestinationUrl(url);
    expect(d).toMatchObject({
      type: 'smb', host: 'nas.lan', share: 'Backup', path: 'servers/arkimede', domain: 'WORKGROUP',
      username: 'backup user', password: 'p@ss:w/rd;%', port: null,
    });
    expect(describeDestination(url)).toBe('smb://nas.lan/Backup/servers/arkimede (WORKGROUP\\backup user)');
    expect(destinationFields(url)).not.toHaveProperty('password');
  });

  it('maps SMB to rclone env: share + folder as the path, password left for the caller to obscure', () => {
    const env = toRcloneEnv(buildDestinationUrl({ type: 'smb', host: '10.0.0.5', port: 4450, share: 'Backup', path: 'ark', username: 'u', password: 'p' }));
    expect(env).toEqual({
      RCLONE_CONFIG_DEST_TYPE: 'smb', RCLONE_CONFIG_DEST_USER: 'u', RCLONE_DEST_PLAIN_PASS: 'p',
      RCLONE_CONFIG_DEST_HOST: '10.0.0.5', RCLONE_CONFIG_DEST_PORT: '4450', RCLONE_DEST_PATH: 'Backup/ark',
    });
    expect(Object.keys(env)).not.toContain('RCLONE_CONFIG_DEST_PASS');
  });

  it('maps SFTP to an absolute path (empty = home) and WebDAV to a URL', () => {
    expect(toRcloneEnv(buildDestinationUrl({ type: 'sftp', host: 'h', path: 'srv/bk', username: 'u', password: 'p' })).RCLONE_DEST_PATH).toBe('/srv/bk');
    expect(toRcloneEnv(buildDestinationUrl({ type: 'sftp', host: 'h', username: 'u', password: 'p' })).RCLONE_DEST_PATH).toBe('');
    const dav = toRcloneEnv(buildDestinationUrl({ type: 'webdav', host: 'cloud', port: 8443, secure: true, path: 'remote.php/dav/files/u/bk', username: 'u', password: 'p' }));
    expect(dav).toMatchObject({ RCLONE_CONFIG_DEST_URL: 'https://cloud:8443', RCLONE_CONFIG_DEST_VENDOR: 'other', RCLONE_DEST_PATH: 'remote.php/dav/files/u/bk' });
  });

  it('rejects other schemes', () => {
    expect(() => parseDestinationUrl('ftp://u:p@h/x')).toThrow(/Unsupported/);
  });
});
