/**
 * @file document-manifest.types.ts
 *
 * Schema manifest for document DataSources (MongoDB). MongoDB has no fixed
 * schema: the manifest is **sampled** (N documents per collection → fields inferred
 * with observed types and frequency). It lives inside the app (`schemaManifest`
 * column, unioned with the SQL SchemaManifest) and is NEVER written to the client's DB.
 *
 * Mirrors schema-manifest.types.ts:
 *   collection ≈ table, field(path) ≈ column. Same `deny` flag (hides +
 *   blocks in the guard), same introspect (sampling) / enrich (AI comments) flow.
 */
import { DocumentEngine } from './engine.types';

export interface DocumentField {
  /** Field path (dot-notation for sub-documents, e.g. "indirizzo.citta"). */
  path: string;
  /** BSON types observed in the sample (e.g. ["string"], ["int","null"]). */
  types: string[];
  /** Fraction of sampled documents that contain the field (0..1). */
  frequency: number;
  /** Descriptive comment (from AI or manually edited). Empty string if absent. */
  comment: string;
  /** If true the field is denied: hidden from the injected schema + blocked in the guard. */
  deny?: boolean;
}

export interface DocumentCollection {
  name: string;
  /** Collection comment. Empty string if absent. */
  comment: string;
  /** If true the collection is denied: hidden from the agent and blocked in the guard. */
  deny: boolean;
  fields: DocumentField[];
}

export interface DocumentManifest {
  generatedAt: string;
  engine: DocumentEngine;
  collections: DocumentCollection[];
}

/** Distinguishes a DocumentManifest from a SchemaManifest (union on the jsonb column). */
export function isDocumentManifest(m: unknown): m is DocumentManifest {
  return !!m && typeof m === 'object' && Array.isArray((m as any).collections);
}

// ── Deny helpers ─────────────────────────────────────────────────────────────────

/** Names (lowercase) of the denied collections. */
export function deniedCollectionNames(manifest: DocumentManifest | null | undefined): Set<string> {
  const set = new Set<string>();
  if (!manifest) return set;
  for (const c of manifest.collections) if (c.deny) set.add(c.name.toLowerCase());
  return set;
}

/** `collection.path` references (lowercase) of denied fields (excluding already-denied collections). */
export function deniedFieldRefs(manifest: DocumentManifest | null | undefined): Set<string> {
  const set = new Set<string>();
  if (!manifest) return set;
  for (const c of manifest.collections) {
    if (c.deny) continue;
    const cn = c.name.toLowerCase();
    for (const f of c.fields) if (f.deny) set.add(`${cn}.${f.path.toLowerCase()}`);
  }
  return set;
}

// ── Non-destructive merge (preserves the user's comments + deny) ───────────────────

export function mergeDocumentManifest(
  fresh: DocumentManifest,
  existing: DocumentManifest | null,
): DocumentManifest {
  if (!existing) return fresh;
  const exColl = new Map(existing.collections.map((c) => [c.name, c]));

  const collections: DocumentCollection[] = fresh.collections.map((fc) => {
    const ex = exColl.get(fc.name);
    if (!ex) return fc;
    const exFields = new Map(ex.fields.map((f) => [f.path, f]));
    return {
      name: fc.name,
      comment: ex.comment?.trim() ? ex.comment : fc.comment,
      deny: ex.deny ?? false,
      fields: fc.fields.map((ff) => {
        const ef = exFields.get(ff.path);
        return {
          path: ff.path,
          types: ff.types,
          frequency: ff.frequency,
          comment: ef?.comment?.trim() ? ef.comment : ff.comment,
          deny: ef?.deny ?? false,
        };
      }),
    };
  });

  return { generatedAt: fresh.generatedAt, engine: fresh.engine, collections };
}

// ── Rendering of the schema injected into the model ─────────────────────────────────

/** Collection name (lowercase) from a "collection.path" reference. */
function refCollection(ref: string): string {
  return ref.split('.')[0]?.toLowerCase() ?? '';
}

function fieldLine(f: DocumentField): string {
  const cm = f.comment?.trim() ? ` — ${f.comment.trim()}` : '';
  const types = f.types.join('|') || 'mixed';
  const opt = f.frequency < 1 ? ` (${Math.round(f.frequency * 100)}%)` : '';
  return `    - ${f.path} (${types})${opt}${cm}`;
}

function renderCollectionBlock(c: DocumentCollection, deniedRefs: Set<string>): string {
  const cn = c.name.toLowerCase();
  const head = `### ${c.name}${c.comment?.trim() ? ` — ${c.comment.trim()}` : ''}`;
  const lines = c.fields
    .filter((f) => !f.deny && !deniedRefs.has(`${cn}.${f.path.toLowerCase()}`))
    .map(fieldLine);
  return [head, '  campi:', ...lines].join('\n');
}

/** COMPACT: only collection names + comments. Fields are requested with describe_collections. */
export function renderDocumentManifestCompact(manifest: DocumentManifest): string {
  const allowed = manifest.collections.filter((c) => !c.deny);
  const lines = allowed.map((c) => `  ${c.name}${c.comment?.trim() ? ` — ${c.comment.trim()}` : ''}`);
  return `[Collezioni disponibili (${allowed.length})]\n${lines.join('\n')}\n\n` +
    'I campi non sono elencati qui. Prima di scrivere la query, richiama il tool con ' +
    '"describe_collections": ["coll1","coll2"] per ricevere i campi (path, tipi, frequenza) di quelle collezioni.';
}

/** FULL: each collection with its fields (path, types, frequency, comment). */
export function renderDocumentManifestFull(manifest: DocumentManifest): string {
  const allowed = manifest.collections.filter((c) => !c.deny);
  const deniedRefs = deniedFieldRefs(manifest);
  return `[Schema documentale — ${allowed.length} collezioni]\n\n` +
    allowed.map((c) => renderCollectionBlock(c, deniedRefs)).join('\n\n');
}

/** Fields of only the requested collections (describe on-demand). */
export function renderDocumentManifestCollections(manifest: DocumentManifest, names: string[]): string {
  const byName = new Map(manifest.collections.map((c) => [c.name.toLowerCase(), c]));
  const deniedRefs = deniedFieldRefs(manifest);
  const blocks: string[] = [];
  const notFound: string[] = [];
  for (const raw of names) {
    const n = raw.trim().toLowerCase();
    if (!n) continue;
    const c = byName.get(n);
    if (!c || c.deny) { notFound.push(raw.trim()); continue; }
    blocks.push(renderCollectionBlock(c, deniedRefs));
  }
  let res = blocks.join('\n\n') || '[No valid collection requested]';
  if (notFound.length) res += `\n\n[Collections not found: ${notFound.join(', ')}]`;
  return res;
}

export { refCollection };
