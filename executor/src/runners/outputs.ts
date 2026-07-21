import * as path from 'path';
import * as fs from 'fs';

/**
 * outputs.ts — per-user deliverables dir + delta detection.
 *
 * Every execution path (sandbox in-process/broker, skill in-process/broker)
 * materializes the files it produces into a PER-USER subdir of the shared
 * skills-output dir (physical tenant isolation, mirrors the broker copy-out and
 * the backend `?rel=` confinement). After a run we report which top-level files
 * appeared/changed, so the backend can track them as downloadable File entities
 * and surface them in the chat/project file panel.
 */
const SKILLS_OUTPUT_DIR = process.env.SKILLS_OUTPUT_DIR
  ?? path.join(process.env.SKILLS_BASE_PATH ?? '/app/skills', '..', 'skills-output');

/** Sanitized per-user subdir name (identical rule on backend + broker). */
export function userSub(userId?: string): string {
  return (userId || '').replace(/[^a-zA-Z0-9_-]/g, '') || '_shared';
}

/** Absolute per-user deliverables dir (created on demand). */
export function userOutputDir(userId?: string): string {
  const dir = path.join(SKILLS_OUTPUT_DIR, userSub(userId));
  try { fs.mkdirSync(dir, { recursive: true }); fs.chmodSync(dir, 0o777); } catch { /* */ }
  return dir;
}

/** Snapshot of the top-level files (name → mtimeMs) for delta detection. */
export function snapshotOutputs(dir: string): Map<string, number> {
  const m = new Map<string, number>();
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return m; }
  for (const e of entries) {
    if (!e.isFile()) continue;
    try { m.set(e.name, fs.statSync(path.join(dir, e.name)).mtimeMs); } catch { /* */ }
  }
  return m;
}

/** Top-level files created or modified in `dir` since the `before` snapshot. */
export function newOutputs(dir: string, before: Map<string, number>): string[] {
  const after = snapshotOutputs(dir);
  const out: string[] = [];
  for (const [name, mtime] of after) {
    const prev = before.get(name);
    if (prev === undefined || mtime > prev) out.push(name);
  }
  return out;
}

/** Top-level file names directly under `dir` (used by the broker copy-out). */
export function listTopLevelFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
  } catch { return []; }
}
