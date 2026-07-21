import {
  Injectable, Logger, NotFoundException, BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'node:child_process';
import { createGzip } from 'node:zlib';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, stat, rm, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface BackupInfo {
  id: string; // the archive filename (also the download/delete key)
  size: number; // bytes
  createdAt: string; // ISO
}

/**
 * Application-level backup: a single downloadable archive containing a logical
 * Postgres dump + the file volumes the backend mounts + (best-effort) a Qdrant
 * snapshot. Runs entirely inside the backend container — no Docker socket needed
 * (that stays out of the container for security), so it works at the app layer:
 *   pg_dump          → db.sql.gz
 *   tar /app/uploads → uploads.tgz
 *   tar /app/skills  → skills.tgz
 *   Qdrant HTTP snapshot API → qdrant-full.snapshot  (skipped if unavailable)
 * Redis (BullMQ queue/cache) and the Nix store are transient/regenerable → omitted.
 */
@Injectable()
export class BackupService {
  private readonly logger = new Logger(BackupService.name);

  private readonly backupDir = resolve(process.env.BACKUP_DIR ?? './backups');
  private readonly uploadDir = resolve(process.env.UPLOAD_DIR ?? './uploads');
  // The backend mounts the skills_data volume at /app/skills (see docker-compose.yml).
  private readonly skillsDir = resolve(process.env.SKILLS_BASE_PATH ?? '/app/skills');

  private readonly db: { host: string; port: string; user: string; pass: string; name: string };
  private readonly qdrantUrl: string;

  constructor(cfg: ConfigService) {
    this.db = {
      host: cfg.get<string>('DB_HOST', 'localhost'),
      port: String(cfg.get('DB_PORT', '5432')),
      user: cfg.get<string>('DB_USER', 'postgres'),
      pass: cfg.get<string>('DB_PASSWORD', 'postgres'),
      name: cfg.get<string>('DB_NAME', 'arkimede'),
    };
    this.qdrantUrl = cfg.get<string>('QDRANT_URL', 'http://localhost:6333').replace(/\/+$/, '');
  }

  // ── Public API ────────────────────────────────────────────────────────────

  async createBackup(): Promise<BackupInfo> {
    await mkdir(this.backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:]/g, '-').replace(/\..+$/, '').replace('T', '_');
    const work = await mkdtemp(join(tmpdir(), 'arkimede-backup-'));
    try {
      const manifest: Record<string, unknown> = {
        app: 'arkimede',
        createdAt: new Date().toISOString(),
        includes: [] as string[],
      };
      const includes = manifest.includes as string[];

      // 1) Postgres — always (the core state). A failure here fails the backup.
      await this.pgDump(join(work, 'db.sql.gz'));
      includes.push('db.sql.gz');

      // 2) File volumes the backend mounts.
      if (await this.tarDir(this.uploadDir, join(work, 'uploads.tgz'))) includes.push('uploads.tgz');
      if (await this.tarDir(this.skillsDir, join(work, 'skills.tgz'))) includes.push('skills.tgz');

      // 3) Vectors — best-effort (re-ingestable from sources if it fails).
      if (await this.qdrantSnapshot(join(work, 'qdrant-full.snapshot'))) {
        includes.push('qdrant-full.snapshot');
      } else {
        manifest.vectorsNote = 'Qdrant snapshot unavailable — vectors are re-ingestable from source documents';
      }

      await writeFile(join(work, 'manifest.json'), JSON.stringify(manifest, null, 2));

      // Bundle into one .tar (contents are already compressed → no outer gzip).
      const filename = `arkimede-backup-${stamp}.tar`;
      const outPath = join(this.backupDir, filename);
      await this.run('tar', ['-cf', outPath, '-C', work, '.']);

      const st = await stat(outPath);
      this.logger.log(`Backup created: ${filename} (${(st.size / 1024 / 1024).toFixed(1)} MB, includes: ${includes.join(', ')})`);
      return { id: filename, size: st.size, createdAt: manifest.createdAt as string };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  async list(): Promise<BackupInfo[]> {
    await mkdir(this.backupDir, { recursive: true });
    const files = await readdir(this.backupDir);
    const out: BackupInfo[] = [];
    for (const f of files) {
      if (!this.isBackupName(f)) continue;
      const st = await stat(join(this.backupDir, f));
      out.push({ id: f, size: st.size, createdAt: st.mtime.toISOString() });
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getDownloadPath(id: string): Promise<{ path: string; filename: string }> {
    const path = this.resolveBackup(id);
    try {
      await stat(path);
    } catch {
      throw new NotFoundException('backup.notFound');
    }
    return { path, filename: basename(path) };
  }

  async remove(id: string): Promise<void> {
    const path = this.resolveBackup(id);
    try {
      await stat(path);
    } catch {
      throw new NotFoundException('backup.notFound');
    }
    await rm(path, { force: true });
    this.logger.log(`Backup deleted: ${basename(path)}`);
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private isBackupName(f: string): boolean {
    return /^arkimede-backup-[\w.-]+\.tar$/.test(f);
  }

  /** Anti-traversal: only a bare, well-formed backup filename under backupDir. */
  private resolveBackup(id: string): string {
    const name = basename(id);
    if (!this.isBackupName(name)) throw new BadRequestException('backup.invalidId');
    return join(this.backupDir, name);
  }

  private pgDump(outFile: string): Promise<void> {
    const args = [
      '-h', this.db.host, '-p', this.db.port, '-U', this.db.user, '-d', this.db.name,
      '--no-owner', '--no-acl',
    ];
    return new Promise<void>((res, rej) => {
      const proc = spawn('pg_dump', args, { env: { ...process.env, PGPASSWORD: this.db.pass } });
      let err = '';
      proc.stderr.on('data', (d) => { err += d.toString(); });
      proc.on('error', (e) => rej(new Error(`pg_dump not available: ${e.message}`)));
      let exitCode: number | null = null;
      proc.on('close', (code) => { exitCode = code; });
      pipeline(proc.stdout, createGzip(), createWriteStream(outFile))
        .then(() => {
          // stdout ended; give the process a tick to report its exit code.
          const check = () => {
            if (exitCode === null) return setTimeout(check, 20);
            exitCode === 0 ? res() : rej(new Error(`pg_dump exited ${exitCode}: ${err.slice(0, 400)}`));
          };
          check();
        })
        .catch(rej);
    });
  }

  /** tar -czf a directory if it exists; returns false if the dir is absent. */
  private async tarDir(dir: string, outFile: string): Promise<boolean> {
    try {
      const st = await stat(dir);
      if (!st.isDirectory()) return false;
    } catch {
      return false;
    }
    await this.run('tar', ['-czf', outFile, '-C', dir, '.']);
    return true;
  }

  private async qdrantSnapshot(outFile: string): Promise<boolean> {
    try {
      const create = await fetch(`${this.qdrantUrl}/snapshots`, { method: 'POST' });
      if (!create.ok) throw new Error(`create ${create.status}`);
      const name = (await create.json())?.result?.name;
      if (!name) throw new Error('no snapshot name returned');
      const dl = await fetch(`${this.qdrantUrl}/snapshots/${encodeURIComponent(name)}`);
      if (!dl.ok || !dl.body) throw new Error(`download ${dl.status}`);
      await pipeline(Readable.fromWeb(dl.body as any), createWriteStream(outFile));
      // Best-effort cleanup of the server-side snapshot.
      fetch(`${this.qdrantUrl}/snapshots/${encodeURIComponent(name)}`, { method: 'DELETE' }).catch(() => {});
      return true;
    } catch (e: any) {
      this.logger.warn(`Qdrant snapshot skipped: ${e.message}`);
      return false;
    }
  }

  private run(cmd: string, args: string[]): Promise<void> {
    return new Promise<void>((res, rej) => {
      const proc = spawn(cmd, args);
      let err = '';
      proc.stderr.on('data', (d) => { err += d.toString(); });
      proc.on('error', (e) => rej(new Error(`${cmd} not available: ${e.message}`)));
      proc.on('close', (code) => (code === 0 ? res() : rej(new Error(`${cmd} exited ${code}: ${err.slice(0, 400)}`))));
    });
  }
}
