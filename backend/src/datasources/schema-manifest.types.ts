/**
 * @file schema-manifest.types.ts
 *
 * Enriched schema manifest of a DataSource.
 *
 * It is the structured artifact that replaces the manual scripts (schema-comments.yaml +
 * schema-manifest.json + schema-hints-*.md): it contains tables, columns, comments and
 * implicit relations, plus the per-table `deny` flag.
 *
 * The manifest lives INSIDE the app (`schemaManifest` column on data_sources) and is
 * NEVER written to the customer's external DB. It feeds two things:
 *   1. the schema prefetch injected into the LLM (custom-tool.factory → fetchSchema)
 *   2. the `deny` enforcement in the SQL guard (evaluateSqlPolicy)
 *
 * Flow:
 *   introspect → draft from the live schema (DB comments + declared FKs)
 *   enrich     → the LLM fills the empty comments and infers the missing relations
 *   edit       → the user fixes comments/relations and marks tables as `deny`
 */
import { SqlEngine } from './engine.types';

export interface SchemaManifestColumn {
  name: string;
  /** Raw SQL type (e.g. "varchar(255)", "int", "timestamp"). */
  type: string;
  /** Descriptive comment (from DB, from LLM or hand-edited). Empty string if absent. */
  comment: string;
  /**
   * If true the column is denied — **same behavior as the `deny` on the table**:
   * excluded from the schema injected into the LLM (compact/full/describe) AND blocked in
   * the SQL guard (best-effort): a query referencing it is rejected, and `SELECT *` /
   * `table.*` is rejected on the tables that contain it (otherwise the `*` would leak
   * it). Absent = visible (backward-compatible with already-saved manifests). For real
   * secrets, restriction at the DB level is still recommended (read-only user without
   * SELECT on the column, or a view).
   */
  deny?: boolean;
}

export interface SchemaManifestTable {
  name: string;
  /** Table comment. Empty string if absent. */
  comment: string;
  /**
   * If true the table is denied: excluded from the prefetch (the agent does not see it)
   * and blocked in the SQL guard (any query referencing it is rejected).
   */
  deny: boolean;
  columns: SchemaManifestColumn[];
}

export interface SchemaManifestRelation {
  /** "table.column" on the FK side. */
  from: string;
  /** "table.column" on the referenced PK side. */
  to: string;
  /** Optional descriptive label. */
  label?: string;
}

export interface SchemaManifest {
  /** ISO timestamp of the last regeneration (introspect/enrich). */
  generatedAt: string;
  /** SQL engine of the DataSource (postgres | mysql | mariadb | mssql | oracle | sqlite). */
  dialect: SqlEngine;
  relations: SchemaManifestRelation[];
  tables: SchemaManifestTable[];
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Names (lowercase) of the denied tables — for discovery and enforcement. */
export function deniedTableNames(manifest: SchemaManifest | null | undefined): Set<string> {
  const set = new Set<string>();
  if (!manifest) return set;
  for (const t of manifest.tables) {
    if (t.deny) set.add(t.name.toLowerCase());
  }
  return set;
}

/**
 * `table.column` references (lowercase) of the denied columns — to hide them from
 * the schema and for enforcement in the SQL guard. Columns of already-denied tables
 * are not included (the whole table is blocked upstream).
 */
export function deniedColumnRefs(manifest: SchemaManifest | null | undefined): Set<string> {
  const set = new Set<string>();
  if (!manifest) return set;
  for (const t of manifest.tables) {
    if (t.deny) continue;
    const tn = t.name.toLowerCase();
    for (const c of t.columns) {
      if (c.deny) set.add(`${tn}.${c.name.toLowerCase()}`);
    }
  }
  return set;
}

/**
 * Merges a freshly-introspected manifest (`fresh`, from the live schema) with the
 * saved one (`existing`, with manual edits), in a NON-destructive way:
 *   - structure (tables/columns/types) = the fresh one (reflects the real schema)
 *   - comments = the existing ones if present, otherwise the fresh ones (DB comments)
 *   - deny = the existing one (the user's choice)
 *   - relations = union (the existing ones are never lost nor duplicated)
 *
 * Tables/columns gone from the real schema are removed; new ones are added.
 */
export function mergeManifest(fresh: SchemaManifest, existing: SchemaManifest | null): SchemaManifest {
  if (!existing) return fresh;

  const exTables = new Map(existing.tables.map((t) => [t.name, t]));

  const tables: SchemaManifestTable[] = fresh.tables.map((ft) => {
    const ex = exTables.get(ft.name);
    if (!ex) return ft;
    const exCols = new Map(ex.columns.map((c) => [c.name, c]));
    return {
      name: ft.name,
      comment: ex.comment?.trim() ? ex.comment : ft.comment,
      deny: ex.deny ?? false,
      columns: ft.columns.map((fc) => {
        const ec = exCols.get(fc.name);
        return {
          name: fc.name,
          type: fc.type,
          comment: ec?.comment?.trim() ? ec.comment : fc.comment,
          // deny is a user choice: preserve it from the existing manifest.
          deny: ec?.deny ?? false,
        };
      }),
    };
  });

  const relKey = (r: SchemaManifestRelation) => `${r.from}→${r.to}`;
  const seen = new Set<string>();
  const relations: SchemaManifestRelation[] = [];
  for (const r of [...existing.relations, ...fresh.relations]) {
    const k = relKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    relations.push(r);
  }

  return { generatedAt: fresh.generatedAt, dialect: fresh.dialect, relations, tables };
}

/** Table name (lowercase) from a "table.column" reference. */
function refTable(ref: string): string {
  return ref.split('.')[0]?.toLowerCase() ?? '';
}
/** Column from a "table.column" reference (handles names with dots). */
function refColumn(ref: string): string {
  return ref.split('.').slice(1).join('.').toLowerCase();
}

/**
 * True if the relation touches a denied table or column on either side:
 * in that case it must NOT be shown, otherwise the denied name would leak.
 */
function relTouchesDenied(
  r: SchemaManifestRelation,
  deniedRefs: Set<string>,
  deniedTbls: Set<string>,
): boolean {
  const fromRef = r.from.toLowerCase(); const toRef = r.to.toLowerCase();
  return deniedRefs.has(fromRef) || deniedRefs.has(toRef)
    || deniedTbls.has(refTable(r.from)) || deniedTbls.has(refTable(r.to));
}

/**
 * COMPACT render: relations + table-name catalog (with comment) + excluded
 * tables. Does NOT list the columns → lightweight context (~2K tokens on large DBs).
 * The model discovers the columns with an exploratory query when it needs them.
 * This is the mode that paired with the old schema-comments.yaml → hints flow.
 */
export function renderManifestCompact(manifest: SchemaManifest): string {
  const allowed = manifest.tables.filter((t) => !t.deny);
  const deniedRefs = deniedColumnRefs(manifest);
  const deniedTbls = deniedTableNames(manifest);
  const parts: string[] = [];

  const rels = manifest.relations.filter((r) => !relTouchesDenied(r, deniedRefs, deniedTbls));
  if (rels.length) {
    const lines = rels.map((r) => {
      const label = r.label ? ` — ${r.label}` : '';
      return `  ${r.from} → ${r.to}${label}`;
    });
    parts.push(`[Relations]\n${lines.join('\n')}`);
  }

  // The `deny` tables/columns are TOTALLY hidden: not listed (not even the
  // name) nor referenced. The SQL guard remains the safety net if the model
  // guesses their name.
  const tableLines = allowed.map((t) => {
    const c = t.comment?.trim() ? ` — ${t.comment.trim()}` : '';
    return `  ${t.name}${c}`;
  });
  parts.push(`[Available tables (${allowed.length})]\n${tableLines.join('\n')}`);

  parts.push(
    'Columns are not listed here. Before writing the query, call the tool ' +
    'with the "describe_tables" parameter set to the tables you need ' +
    '(e.g. describe_tables: ["cliente","progettohead"]) to receive their fields, ' +
    'types, comments and foreign keys.',
  );

  return parts.join('\n\n');
}

/**
 * FULL render: self-contained schema. For each table it lists the columns
 * (with type and comment) annotating the FKs inline (`→ table.column`), and a
 * localized `relations:` section that shows the outgoing (→) and incoming (←)
 * JOINs of that table. Excludes the `deny` tables.
 *
 * Localizing the relations per table helps the model compose the correct JOINs
 * much more than the global flat list.
 */
/**
 * Block of a single table: header + columns (with type, comment and outgoing FKs
 * annotated inline) + INCOMING relations ("referenced by"). The outgoing FKs are
 * NOT repeated in the relations section (already inline) → fewer tokens.
 */
function renderTableBlock(
  manifest: SchemaManifest,
  t: SchemaManifestTable,
  deniedRefs: Set<string>,
  deniedTbls: Set<string>,
): string {
  const tname = t.name.toLowerCase();

  // Outgoing FKs, excluding those touching denied tables/columns (they must not be shown).
  const fkByCol = new Map<string, string>();
  for (const r of manifest.relations) {
    if (refTable(r.from) === tname && !relTouchesDenied(r, deniedRefs, deniedTbls)) {
      fkByCol.set(refColumn(r.from), r.to);
    }
  }

  const head = `### ${t.name}${t.comment?.trim() ? ` — ${t.comment.trim()}` : ''}`;
  const colLines = t.columns
    .filter((c) => !c.deny)               // denied fields are hidden from the schema
    .map((c) => {
      const cm = c.comment?.trim() ? ` — ${c.comment.trim()}` : '';
      const fk = fkByCol.get(c.name.toLowerCase());
      return `    - ${c.name} (${c.type})${cm}${fk ? `  → ${fk}` : ''}`;
    });

  const incoming = manifest.relations
    .filter((r) => refTable(r.to) === tname && refTable(r.from) !== tname && !relTouchesDenied(r, deniedRefs, deniedTbls))
    .map((r) => {
      const label = r.label ? ` (${r.label})` : '';
      return `    ← ${r.from} → ${r.to}${label}`;
    });

  const lines = [head, '  columns:', ...colLines];
  if (incoming.length) lines.push('  referenced by:', ...incoming);
  return lines.join('\n');
}

export function renderManifestFull(manifest: SchemaManifest): string {
  const allowed = manifest.tables.filter((t) => !t.deny);
  const deniedRefs = deniedColumnRefs(manifest);
  const deniedTbls = deniedTableNames(manifest);

  // `deny` tables/columns fully excluded (no "not accessible" list).
  return `[Schema — ${allowed.length} tables]\n\n` +
    allowed.map((t) => renderTableBlock(manifest, t, deniedRefs, deniedTbls)).join('\n\n');
}

/**
 * Render of the columns (with FKs and relations) ONLY for the requested tables —
 * used by the "on-demand" compact mode: the model asks for the tables it needs
 * and receives their fields, without paying for the dump of the whole schema.
 * Nonexistent or denied tables are reported.
 */
export function renderManifestColumns(manifest: SchemaManifest, names: string[]): string {
  const byName = new Map(manifest.tables.map((t) => [t.name.toLowerCase(), t]));
  const deniedRefs = deniedColumnRefs(manifest);
  const deniedTbls = deniedTableNames(manifest);
  const blocks: string[] = [];
  const notFound: string[] = [];

  for (const raw of names) {
    const n = raw.trim().toLowerCase();
    if (!n) continue;
    const t = byName.get(n);
    // Nonexistent OR denied table → treated as "not found" (does not confirm
    // the existence of a hidden table).
    if (!t || t.deny) { notFound.push(raw.trim()); continue; }
    blocks.push(renderTableBlock(manifest, t, deniedRefs, deniedTbls));
  }

  let res = blocks.join('\n\n') || '[No valid table requested]';
  if (notFound.length) res += `\n\n[Tables not found: ${notFound.join(', ')}]`;
  return res;
}
