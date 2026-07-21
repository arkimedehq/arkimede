/**
 * @file fileshare.driver.ts
 *
 * "fileshare" family driver: access to remote network paths (SMB/CIFS, SFTP,
 * WebDAV) via userspace protocol clients — NO OS mount. Connections
 * originate from the backend (always reachable by skills via internal API), so
 * they do not go through the skills egress-proxy.
 *
 * Connection string = URL (encrypted in the DB like the other DataSources):
 *   smb     →  smb://[DOMAIN;]user:password@host[:445]/share[/basePath]
 *   sftp    →  sftp://user:password@host[:22][/basePath]
 *   webdav  →  webdav://user:password@host[:port][/basePath]   (http)
 *              webdavs://user:password@host[:port][/basePath]   (https)
 *
 * Operations: list / read / write / delete, with anti path-traversal guard (every
 * requested path stays under `basePath`). The client packages are lazy-loaded:
 * if not installed the error is clear and does not block startup.
 */
import * as path from 'path';
import * as fs from 'fs/promises';
import { createReadStream as fsCreateReadStream } from 'fs';
import { Readable } from 'stream';
import { promisify } from 'util';
import { loadOptional } from '../drivers/optional-module';
import { FileShareEngine } from '../engine.types';

/** Cap on the size of a single file read ENTIRELY into memory (op=read).
 *  Streaming (openStream) does NOT have this limit: it reads in chunks, even huge files. */
const MAX_READ_BYTES = 10 * 1024 * 1024;

/** Byte range requested for streaming (endpoints inclusive). */
export interface ByteRange {
  start?: number;   // default 0
  end?:   number;   // default size-1 (inclusive)
}

export interface FileEntry {
  name:  string;
  path:  string;           // path relative to basePath (forward-slash)
  type:  'file' | 'dir';
  size?: number;
  mtime?: string;          // ISO
}

export type FileShareOp = 'list' | 'read' | 'write' | 'delete';

export interface FileShareSpec {
  op:        FileShareOp;
  path?:     string;       // relative to basePath; default '' = root
  content?:  string;       // base64 (only op=write)
  recursive?: boolean;     // only op=delete on directory
}

interface ParsedConn {
  host: string;
  port?: number;
  username: string;
  password: string;
  domain: string;
  share: string;           // smb only
  basePath: string;        // posix, without trailing slash (may be '')
  secure: boolean;         // webdav only (https)
}

// ── Connection string parsing ───────────────────────────────────────────────────

function parseConn(engine: FileShareEngine, connStr: string): ParsedConn {
  let u: URL;
  try {
    u = new URL(connStr);
  } catch {
    throw new Error('Invalid connection string (malformed URL).');
  }
  let username = decodeURIComponent(u.username || '');
  const password = decodeURIComponent(u.password || '');
  let domain = '';
  // SMB: domain as "DOMAIN;user" or "DOMAIN\\user"
  const sep = username.includes(';') ? ';' : (username.includes('\\') ? '\\' : '');
  if (sep) [domain, username] = username.split(sep, 2);

  const segs = decodeURIComponent(u.pathname || '').split('/').filter(Boolean);
  let share = '';
  let baseSegs = segs;
  if (engine === 'smb') {
    if (segs.length === 0) throw new Error('SMB: specify the share in the URL (smb://host/share[/base]).');
    share = segs[0];
    baseSegs = segs.slice(1);
  }
  const secure = u.protocol === 'webdavs:' || u.protocol === 'https:';

  return {
    host:     u.hostname,
    port:     u.port ? Number(u.port) : undefined,
    username, password, domain, share,
    basePath: baseSegs.join('/'),
    secure,
  };
}

/** Absolute posix path under `base`, with anti-traversal guard. */
function safeAbs(base: string, rel: string): string {
  const root = path.posix.normalize('/' + (base || '')).replace(/\/+$/, '') || '/';
  const joined = path.posix.normalize(path.posix.join(root, rel || ''));
  if (joined !== root && !joined.startsWith(root === '/' ? '/' : root + '/')) {
    throw new Error(`Path not allowed (outside the base): "${rel}"`);
  }
  return joined;
}

// ── Adapter interface ─────────────────────────────────────────────────────────

interface Adapter {
  test():   Promise<void>;
  list(rel: string):   Promise<FileEntry[]>;
  read(rel: string):   Promise<Buffer>;
  /** File size in bytes, WITHOUT reading it (metadata only). */
  size(rel: string):   Promise<number>;
  /** Chunked stream of the file, optionally over a byte range (for Range/streaming). */
  openStream(rel: string, range?: ByteRange): Promise<Readable>;
  write(rel: string, data: Buffer): Promise<void>;
  remove(rel: string, recursive: boolean): Promise<void>;
  close():  Promise<void>;
}

// ── SMB / CIFS (@marsaud/smb2) ──────────────────────────────────────────────────

function smbAdapter(c: ParsedConn): Adapter {
  const SMB2 = loadOptional('@marsaud/smb2', 'smb');
  const Client = SMB2.default ?? SMB2;
  const client = new Client({
    share:    `\\\\${c.host}\\${c.share}`,
    domain:   c.domain || 'WORKGROUP',
    username: c.username,
    password: c.password,
    port:     c.port ?? 445,
    autoCloseTimeout: 0,
  });
  const readdir  = promisify(client.readdir).bind(client);
  const readFile = promisify(client.readFile).bind(client);
  const writeFile = promisify(client.writeFile).bind(client);
  const unlink   = promisify(client.unlink).bind(client);
  const rmdir    = promisify(client.rmdir).bind(client);
  const stat     = promisify(client.stat).bind(client);
  const exists   = promisify(client.exists).bind(client);
  const getSize  = promisify(client.getSize).bind(client);
  // createReadStream(path, options, cb) → cb(err, Readable). options.start/end (inclusive).
  const createReadStream: (p: string, o: any) => Promise<Readable> = (p, o) =>
    new Promise((resolve, reject) =>
      client.createReadStream(p, o, (err: any, s: Readable) => (err ? reject(err) : resolve(s))),
    );

  // Path relative to the SHARE (backslash), including basePath. '' = share root
  // (@marsaud/smb2 wants '' for the root: '.' → STATUS_OBJECT_NAME_INVALID).
  const toSmb = (rel: string) =>
    safeAbs(c.basePath, rel).replace(/^\/+/, '').replace(/\//g, '\\');

  return {
    async test() { await readdir(toSmb('')); },
    async list(rel) {
      const dir = toSmb(rel);
      const names: string[] = await readdir(dir);
      const out: FileEntry[] = [];
      for (const name of names) {
        const childRel = (rel ? rel.replace(/\/$/, '') + '/' : '') + name;
        let type: 'file' | 'dir' = 'file';
        let size: number | undefined;
        let mtime: string | undefined;
        try {
          const st: any = await stat((dir ? dir + '\\' : '') + name);
          if (st && typeof st.isDirectory === 'function' && st.isDirectory()) type = 'dir';
          if (st && typeof st.size === 'number') size = st.size;
          if (st && st.mtime) mtime = new Date(st.mtime).toISOString();
        } catch { /* best-effort */ }
        out.push({ name, path: childRel, type, size, mtime });
      }
      return out;
    },
    async read(rel)  { return readFile(toSmb(rel)); },
    async size(rel)  { return getSize(toSmb(rel)); },
    async openStream(rel, range) {
      const o: any = {};
      if (range?.start != null) o.start = range.start;
      if (range?.end   != null) o.end   = range.end;     // end is inclusive (as per the API)
      return createReadStream(toSmb(rel), o);
    },
    async write(rel, data) { await writeFile(toSmb(rel), data); },
    async remove(rel) {
      const p = toSmb(rel);
      if (await exists(p)) {
        try { await unlink(p); } catch { await rmdir(p); }
      } else {
        throw new Error(`File not found: ${rel}`);
      }
    },
    async close() { try { client.disconnect(); } catch { /* ignore */ } },
  };
}

// ── SFTP (ssh2-sftp-client) ──────────────────────────────────────────────────────

function sftpAdapter(c: ParsedConn): Adapter {
  const SftpClient = loadOptional('ssh2-sftp-client', 'sftp');
  const Client = SftpClient.default ?? SftpClient;
  const sftp = new Client();
  let connected = false;
  const ensure = async () => {
    if (!connected) {
      await sftp.connect({
        host: c.host, port: c.port ?? 22, username: c.username, password: c.password,
        readyTimeout: 8000,
      });
      connected = true;
    }
  };
  const abs = (rel: string) => safeAbs(c.basePath, rel);

  return {
    async test() { await ensure(); await sftp.exists(abs('') || '/'); },
    async list(rel) {
      await ensure();
      const items: any[] = await sftp.list(abs(rel) || '/');
      return items.map((it) => ({
        name: it.name,
        path: (rel ? rel.replace(/\/$/, '') + '/' : '') + it.name,
        type: it.type === 'd' ? 'dir' : 'file',
        size: typeof it.size === 'number' ? it.size : undefined,
        mtime: it.modifyTime ? new Date(it.modifyTime).toISOString() : undefined,
      }) as FileEntry);
    },
    async read(rel)  { await ensure(); return (await sftp.get(abs(rel))) as Buffer; },
    async size(rel)  { await ensure(); const st: any = await sftp.stat(abs(rel)); return st.size; },
    async openStream(rel, range) {
      await ensure();
      const o: any = {};
      if (range?.start != null) o.start = range.start;
      if (range?.end   != null) o.end   = range.end;     // ssh2: end inclusive
      return sftp.createReadStream(abs(rel), o) as Readable;
    },
    async write(rel, data) { await ensure(); await sftp.put(data, abs(rel)); },
    async remove(rel, recursive) {
      await ensure();
      const p = abs(rel);
      const t = await sftp.exists(p);
      if (t === 'd') await sftp.rmdir(p, recursive);
      else if (t) await sftp.delete(p);
      else throw new Error(`File not found: ${rel}`);
    },
    async close() { try { if (connected) await sftp.end(); } catch { /* ignore */ } },
  };
}

// ── WebDAV (webdav) ──────────────────────────────────────────────────────────────

function webdavAdapter(c: ParsedConn): Adapter {
  const mod = loadOptional('webdav', 'webdav');
  const createClient = mod.createClient ?? mod.default?.createClient;
  const baseUrl = `${c.secure ? 'https' : 'http'}://${c.host}${c.port ? ':' + c.port : ''}`;
  const client = createClient(baseUrl, { username: c.username, password: c.password });
  const abs = (rel: string) => safeAbs(c.basePath, rel);

  return {
    async test() { await client.getDirectoryContents(abs('') || '/'); },
    async list(rel) {
      const items: any[] = await client.getDirectoryContents(abs(rel) || '/');
      return items.map((it) => ({
        name: it.basename,
        path: (rel ? rel.replace(/\/$/, '') + '/' : '') + it.basename,
        type: it.type === 'directory' ? 'dir' : 'file',
        size: typeof it.size === 'number' ? it.size : undefined,
        mtime: it.lastmod ? new Date(it.lastmod).toISOString() : undefined,
      }) as FileEntry);
    },
    async read(rel) {
      const buf = await client.getFileContents(abs(rel), { format: 'binary' });
      return Buffer.from(buf as ArrayBuffer);
    },
    async size(rel) { const st: any = await client.stat(abs(rel)); return st.size ?? st?.data?.size; },
    async openStream(rel, range) {
      const o: any = {};
      if (range?.start != null) o.range = { start: range.start, end: range.end ?? undefined };
      return client.createReadStream(abs(rel), o) as Readable;
    },
    async write(rel, data) { await client.putFileContents(abs(rel), data); },
    async remove(rel) { await client.deleteFile(abs(rel)); },
    async close() { /* stateless http client */ },
  };
}

// ── Local (backend filesystem, e.g. SKILLS_OUTPUT_DIR) ─────────────────────────
//
// Connection string: local:///<absolute path of the base>
//   e.g. local:///srv/app/uploads/skills-output
// No external client: uses fs/promises. The anti-traversal guard works on REAL
// paths (not posix) so symlinks/`..` do not escape the base.

function localBaseDir(connStr: string): string {
  let u: URL;
  try {
    u = new URL(connStr);
  } catch {
    throw new Error('Invalid local connection string (expected: local:///absolute/path).');
  }
  const base = decodeURIComponent(u.pathname || '');
  if (!base) throw new Error('Local connection string without base path.');
  return path.resolve(base);
}

/** Absolute path under `base`, with a LEXICAL anti-traversal guard (no symlink check). */
function localSafeAbs(base: string, rel: string): string {
  const abs = path.resolve(base, rel || '');
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new Error(`Path not allowed (outside the base): "${rel}"`);
  }
  return abs;
}

/** realpath of `p`, or of its nearest existing ancestor if `p` does not exist yet. */
async function realpathNearest(p: string): Promise<string> {
  let cur = p;
  for (;;) {
    try {
      return await fs.realpath(cur);
    } catch (e: any) {
      if (e?.code !== 'ENOENT') throw e;
      const parent = path.dirname(cur);
      if (parent === cur) throw e; // reached the fs root without finding an existing path
      cur = parent;
    }
  }
}

function localAdapter(connStr: string): Adapter {
  const base = localBaseDir(connStr);
  const toRel = (abs: string) =>
    abs === base ? '' : abs.slice(base.length + 1).split(path.sep).join('/');

  // Lexical guard + symlink-aware containment: resolve the real path (or the nearest
  // existing ancestor, for write targets) and confirm it stays inside `base`, so a
  // symlink planted under `base` cannot point read/write/stream outside it.
  const safeAbs = async (rel: string): Promise<string> => {
    const abs = localSafeAbs(base, rel);
    const [realBase, realTarget] = await Promise.all([fs.realpath(base), realpathNearest(abs)]);
    if (realTarget !== realBase && !realTarget.startsWith(realBase + path.sep)) {
      throw new Error(`Path not allowed (outside the base): "${rel}"`);
    }
    return abs;
  };

  return {
    async test() { await fs.access(base); },
    async list(rel) {
      const dir = await safeAbs(rel);
      const names = await fs.readdir(dir, { withFileTypes: true });
      const out: FileEntry[] = [];
      for (const d of names) {
        const abs = path.join(dir, d.name);
        let size: number | undefined;
        let mtime: string | undefined;
        try {
          const st = await fs.stat(abs);
          size = st.isFile() ? st.size : undefined;
          mtime = st.mtime.toISOString();
        } catch { /* best-effort */ }
        out.push({ name: d.name, path: toRel(abs), type: d.isDirectory() ? 'dir' : 'file', size, mtime });
      }
      return out;
    },
    async read(rel) { return fs.readFile(await safeAbs(rel)); },
    async size(rel) { const st = await fs.stat(await safeAbs(rel)); return st.size; },
    async openStream(rel, range) {
      const o: any = {};
      if (range?.start != null) o.start = range.start;
      if (range?.end   != null) o.end   = range.end;     // fs: end inclusive
      return fsCreateReadStream(await safeAbs(rel), o);
    },
    async write(rel, data) {
      const abs = await safeAbs(rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, data);
    },
    async remove(rel, recursive) {
      const abs = await safeAbs(rel);
      const st = await fs.stat(abs).catch(() => null);
      if (!st) throw new Error(`File not found: ${rel}`);
      if (st.isDirectory()) await fs.rm(abs, { recursive, force: false });
      else await fs.unlink(abs);
    },
    async close() { /* no resources to close */ },
  };
}

function getAdapter(engine: FileShareEngine, connStr: string): Adapter {
  if (engine === 'local') return localAdapter(connStr);
  const c = parseConn(engine, connStr);
  switch (engine) {
    case 'smb':    return smbAdapter(c);
    case 'sftp':   return sftpAdapter(c);
    case 'webdav': return webdavAdapter(c);
    default: throw new Error(`Unsupported file-share engine: ${engine}`);
  }
}

// ── Public driver ──────────────────────────────────────────────────────────────

export interface FileShareResult {
  op:      FileShareOp;
  path:    string;
  entries?: FileEntry[];        // op=list
  content?: string;             // op=read (base64)
  size?:   number;
  encoding?: 'base64';
  ok?:     boolean;             // op=write/delete
}

export const fileshareDriver = {
  async testConnection(engine: FileShareEngine, connStr: string): Promise<void> {
    const ad = getAdapter(engine, connStr);
    try { await ad.test(); } finally { await ad.close(); }
  },

  /** Size of a file (bytes) without reading it. Opens and closes the connection. */
  async statFile(engine: FileShareEngine, connStr: string, rel: string): Promise<number> {
    const ad = getAdapter(engine, connStr);
    try { return await ad.size(rel); } finally { await ad.close(); }
  },

  /**
   * Opens a chunked stream of the file (optionally over a byte range), for
   * HTTP streaming with Range — NO in-memory read of the whole file. The
   * connection stays open until the stream ends/errors/is closed, then it
   * is released automatically.
   */
  async openFileStream(
    engine: FileShareEngine,
    connStr: string,
    rel: string,
    range?: ByteRange,
  ): Promise<Readable> {
    const ad = getAdapter(engine, connStr);
    let stream: Readable;
    try {
      stream = await ad.openStream(rel, range);
    } catch (err) {
      await ad.close().catch(() => undefined);
      throw err;
    }
    let closed = false;
    const release = () => { if (!closed) { closed = true; ad.close().catch(() => undefined); } };
    stream.once('end', release);
    stream.once('error', release);
    stream.once('close', release);
    return stream;
  },

  async execute(engine: FileShareEngine, connStr: string, spec: FileShareSpec): Promise<FileShareResult> {
    const rel = spec.path ?? '';
    const ad = getAdapter(engine, connStr);
    try {
      switch (spec.op) {
        case 'list': {
          const entries = await ad.list(rel);
          return { op: 'list', path: rel, entries };
        }
        case 'read': {
          // Pre-check the size WITHOUT reading: reading a huge file into a
          // Buffer (e.g. 70 GB) crashes the client (allocation beyond Node's
          // limits). For large files use streaming (openFileStream), not op=read.
          const sz = await ad.size(rel).catch(() => undefined);
          if (sz != null && sz > MAX_READ_BYTES) {
            throw new Error(
              `File too large to read into memory (${sz} bytes > ${MAX_READ_BYTES}). ` +
              `Use the view/streaming mode to open it.`,
            );
          }
          const buf = await ad.read(rel);
          if (buf.length > MAX_READ_BYTES) {
            throw new Error(`File too large (${buf.length} bytes > ${MAX_READ_BYTES}).`);
          }
          return { op: 'read', path: rel, content: buf.toString('base64'), size: buf.length, encoding: 'base64' };
        }
        case 'write': {
          if (spec.content == null) throw new Error('op=write requires "content" (base64).');
          const data = Buffer.from(spec.content, 'base64');
          await ad.write(rel, data);
          return { op: 'write', path: rel, ok: true, size: data.length };
        }
        case 'delete': {
          await ad.remove(rel, spec.recursive ?? false);
          return { op: 'delete', path: rel, ok: true };
        }
        default:
          throw new Error(`Unsupported file operation: ${(spec as any).op}`);
      }
    } finally {
      await ad.close();
    }
  },
};
