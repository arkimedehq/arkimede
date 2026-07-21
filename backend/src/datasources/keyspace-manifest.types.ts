/**
 * @file keyspace-manifest.types.ts
 *
 * Schema manifest for key-value DataSources (Redis). Redis has no schema: the
 * manifest is **sampled** — SCAN of a sample of keys grouped by pattern
 * (prefix before the first ':'), with the Redis type and some example keys.
 *
 * Mirrors the schema/document manifest: pattern ≈ table/collection. Same `deny`
 * flag (hides it from the injected schema + blocks it in the tool guard: commands
 * that reference a key belonging to a denied pattern are rejected).
 */
import { KeyValueEngine } from './engine.types';

export interface KeyPattern {
  /** Key glob pattern, e.g. "user:*" (or the exact key if it has no ':'). */
  pattern: string;
  /** Prevailing Redis type: string | hash | list | set | zset | stream. */
  type: string;
  /** Number of keys observed in the sample for this pattern. */
  count: number;
  /** Descriptive comment (from AI or edited by hand). Empty if absent. */
  comment: string;
  /** If true the pattern is denied: hidden + commands on its keys blocked. */
  deny: boolean;
  /** Some example keys (for the full render). */
  sampleKeys?: string[];
}

export interface KeyspaceManifest {
  generatedAt: string;
  engine: KeyValueEngine;
  patterns: KeyPattern[];
}

/** Discriminates a KeyspaceManifest (Redis) from the other manifests. */
export function isKeyspaceManifest(m: unknown): m is KeyspaceManifest {
  return !!m && typeof m === 'object' && Array.isArray((m as any).patterns);
}

// ── Deny helpers ─────────────────────────────────────────────────────────────────

/** Denied patterns (lowercase). */
export function deniedPatternNames(manifest: KeyspaceManifest | null | undefined): Set<string> {
  const set = new Set<string>();
  if (!manifest) return set;
  for (const p of manifest.patterns) if (p.deny) set.add(p.pattern.toLowerCase());
  return set;
}

/** Converts a Redis glob (* ?) into a RegExp. */
function globToRe(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${esc}$`, 'i');
}

/** If the key belongs to a denied pattern, returns that pattern (for the guard). */
export function deniedPatternForKey(manifest: KeyspaceManifest | null | undefined, key: string): string | null {
  if (!manifest) return null;
  for (const p of manifest.patterns) {
    if (p.deny && globToRe(p.pattern).test(key)) return p.pattern;
  }
  return null;
}

// ── Non-destructive merge (preserves the user's comments + deny) ───────────────────

export function mergeKeyspaceManifest(
  fresh: KeyspaceManifest,
  existing: KeyspaceManifest | null,
): KeyspaceManifest {
  if (!existing) return fresh;
  const ex = new Map(existing.patterns.map((p) => [p.pattern, p]));
  const patterns: KeyPattern[] = fresh.patterns.map((fp) => {
    const e = ex.get(fp.pattern);
    if (!e) return fp;
    return {
      pattern: fp.pattern,
      type: fp.type,
      count: fp.count,
      comment: e.comment?.trim() ? e.comment : fp.comment,
      deny: e.deny ?? false,
      sampleKeys: fp.sampleKeys,
    };
  });
  return { generatedAt: fresh.generatedAt, engine: fresh.engine, patterns };
}

// ── Render of the schema injected into the model ───────────────────────────────────

function patternLine(p: KeyPattern, withSamples: boolean): string {
  const cm = p.comment?.trim() ? ` — ${p.comment.trim()}` : '';
  const samples = withSamples && p.sampleKeys?.length ? `  es: ${p.sampleKeys.slice(0, 3).join(', ')}` : '';
  return `  ${p.pattern} (${p.type}, ~${p.count})${cm}${samples}`;
}

/** COMPACT: list of patterns + type + comment (without example keys). */
export function renderKeyspaceManifestCompact(manifest: KeyspaceManifest): string {
  const allowed = manifest.patterns.filter((p) => !p.deny);
  return `[Pattern di chiavi (${allowed.length})]\n${allowed.map((p) => patternLine(p, false)).join('\n')}`;
}

/** FULL: pattern + type + comment + example keys. */
export function renderKeyspaceManifestFull(manifest: KeyspaceManifest): string {
  const allowed = manifest.patterns.filter((p) => !p.deny);
  return `[Pattern di chiavi (${allowed.length})]\n${allowed.map((p) => patternLine(p, true)).join('\n')}`;
}
