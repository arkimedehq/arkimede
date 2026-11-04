// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Network destination of the host backups: SMB, SFTP or WebDAV with a username and a
 * password. Stored as ONE connection URL encrypted in host_backup_config (the same URL
 * format the file-share DataSources use, so the backend can test it with their driver):
 *   smb://[DOMAIN;]user:password@host[:445]/share[/path]
 *   sftp://user:password@host[:22][/path]
 *   webdav[s]://user:password@host[:port][/path]
 *
 * The host job (scripts/backup.sh) moves the files with rclone; `toRcloneEnv` maps the
 * URL to rclone's environment config for a remote named DEST (password in clear: the
 * script obscures it with `rclone obscure` before it reaches a container).
 */

export type HostBackupNetworkType = 'smb' | 'sftp' | 'webdav';
export const HOST_BACKUP_NETWORK_TYPES: HostBackupNetworkType[] = ['smb', 'sftp', 'webdav'];

export interface HostBackupDestinationInput {
  type: HostBackupNetworkType;
  host: string;
  port?: number | null;
  share?: string | null;     // smb only
  path?: string | null;      // folder under the share / home / WebDAV root
  domain?: string | null;    // smb only
  username: string;
  password: string;
  secure?: boolean | null;   // webdav only: https
}

export interface ParsedDestination extends Omit<HostBackupDestinationInput, 'port' | 'share' | 'path' | 'domain' | 'secure'> {
  port: number | null;
  share: string;
  path: string;
  domain: string;
  secure: boolean;
}

const trimSlashes = (s: string | null | undefined) => (s ?? '').trim().replace(/^\/+|\/+$/g, '');

export function buildDestinationUrl(d: HostBackupDestinationInput): string {
  const scheme = d.type === 'webdav' ? (d.secure ? 'webdavs' : 'webdav') : d.type;
  const user = (d.type === 'smb' && d.domain?.trim() ? `${d.domain.trim()};` : '') + d.username;
  const port = d.port ? `:${d.port}` : '';
  const segs = [d.type === 'smb' ? trimSlashes(d.share) : '', trimSlashes(d.path)].filter(Boolean);
  const path = segs.map((s) => s.split('/').map(encodeURIComponent).join('/')).join('/');
  return `${scheme}://${encodeURIComponent(user)}:${encodeURIComponent(d.password)}@${d.host.trim()}${port}/${path}`;
}

export function parseDestinationUrl(url: string): ParsedDestination {
  const u = new URL(url);
  const scheme = u.protocol.replace(/:$/, '');
  const type = (scheme === 'webdavs' ? 'webdav' : scheme) as HostBackupNetworkType;
  if (!HOST_BACKUP_NETWORK_TYPES.includes(type)) throw new Error(`Unsupported destination: ${scheme}`);
  let username = decodeURIComponent(u.username);
  let domain = '';
  if (username.includes(';')) [domain, username] = username.split(';', 2);
  const segs = decodeURIComponent(u.pathname).split('/').filter(Boolean);
  const share = type === 'smb' ? (segs.shift() ?? '') : '';
  return {
    type, host: u.hostname, port: u.port ? Number(u.port) : null,
    share, path: segs.join('/'), domain, username,
    password: decodeURIComponent(u.password), secure: scheme === 'webdavs',
  };
}

/** Human label without the password, e.g. "smb://nas/Backup/arkimede (user)". */
export function describeDestination(url: string): string {
  const d = parseDestinationUrl(url);
  const scheme = d.type === 'webdav' && d.secure ? 'webdavs' : d.type;
  const where = [d.share, d.path].filter(Boolean).join('/');
  return `${scheme}://${d.host}${d.port ? `:${d.port}` : ''}/${where} (${d.domain ? `${d.domain}\\` : ''}${d.username})`;
}

/** The URL's fields without the password, for the settings form. */
export function destinationFields(url: string): Omit<ParsedDestination, 'password'> {
  const { password: _password, ...rest } = parseDestinationUrl(url);
  return rest;
}

/**
 * rclone env config for the remote `DEST` + the remote path (RCLONE_DEST_PATH). The
 * password is in RCLONE_DEST_PLAIN_PASS: the caller obscures it into RCLONE_CONFIG_DEST_PASS.
 */
export function toRcloneEnv(url: string): Record<string, string> {
  const d = parseDestinationUrl(url);
  const env: Record<string, string> = {
    RCLONE_CONFIG_DEST_TYPE: d.type,
    RCLONE_CONFIG_DEST_USER: d.username,
    RCLONE_DEST_PLAIN_PASS: d.password,
  };
  if (d.type === 'webdav') {
    env.RCLONE_CONFIG_DEST_URL = `${d.secure ? 'https' : 'http'}://${d.host}${d.port ? `:${d.port}` : ''}`;
    env.RCLONE_CONFIG_DEST_VENDOR = 'other';
    env.RCLONE_DEST_PATH = d.path;
  } else {
    env.RCLONE_CONFIG_DEST_HOST = d.host;
    if (d.port) env.RCLONE_CONFIG_DEST_PORT = String(d.port);
    if (d.type === 'smb') {
      if (d.domain) env.RCLONE_CONFIG_DEST_DOMAIN = d.domain;
      env.RCLONE_DEST_PATH = [d.share, d.path].filter(Boolean).join('/');
    } else {
      // SFTP: an absolute path as given; empty = the user's home.
      env.RCLONE_DEST_PATH = d.path ? `/${d.path}` : '';
    }
  }
  return env;
}
