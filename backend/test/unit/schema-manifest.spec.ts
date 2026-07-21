/**
 * Enriched schema manifest helpers — `datasources/schema-manifest.types.ts`.
 *
 * Invariants:
 *   - mergeManifest is NON-destructive: manual comments/deny/relations are not lost,
 *     the structure follows the fresh schema (removed tables/columns are dropped).
 *   - deniedTableNames and the renderers (compact/full) exclude `deny` tables.
 */
import { describe, it, expect } from 'vitest';
import {
  mergeManifest, deniedTableNames, renderManifestCompact, renderManifestFull, renderManifestColumns,
  SchemaManifest,
} from '../../src/datasources/schema-manifest.types';

const fresh: SchemaManifest = {
  generatedAt: '2026-06-10T00:00:00.000Z',
  dialect: 'mysql',
  relations: [{ from: 'ordini.cod_cli', to: 'clienti.cod_cli' }],
  tables: [
    { name: 'clienti', comment: '', deny: false, columns: [
      { name: 'cod_cli', type: 'int', comment: '' },
      { name: 'nome', type: 'varchar(100)', comment: '' },
    ] },
    { name: 'ordini', comment: '', deny: false, columns: [
      { name: 'id', type: 'int', comment: '' },
      { name: 'cod_cli', type: 'int', comment: '' },
    ] },
  ],
};

describe('mergeManifest — non-destructive', () => {
  it('preserves existing comments, deny and relations', () => {
    const existing: SchemaManifest = {
      generatedAt: '2026-06-01T00:00:00.000Z',
      dialect: 'mysql',
      relations: [{ from: 'ordini.cod_cli', to: 'clienti.cod_cli', label: 'order customer' }],
      tables: [
        { name: 'clienti', comment: 'Customer registry', deny: false, columns: [
          { name: 'cod_cli', type: 'int', comment: 'Customer code' },
          { name: 'nome', type: 'varchar(100)', comment: '', deny: true },
        ] },
        { name: 'ordini', comment: '', deny: true, columns: [
          { name: 'id', type: 'int', comment: '' },
          { name: 'cod_cli', type: 'int', comment: '' },
        ] },
      ],
    };

    const m = mergeManifest(fresh, existing);
    const clienti = m.tables.find((t) => t.name === 'clienti')!;
    const ordini  = m.tables.find((t) => t.name === 'ordini')!;

    expect(clienti.comment).toBe('Customer registry');
    expect(clienti.columns.find((c) => c.name === 'cod_cli')!.comment).toBe('Customer code');
    expect(ordini.deny).toBe(true);
    // column deny (user choice) preserved on merge with fresh introspection
    expect(clienti.columns.find((c) => c.name === 'nome')!.deny).toBe(true);
    // the existing relation (with label) is neither duplicated nor lost
    expect(m.relations).toHaveLength(1);
    expect(m.relations[0].label).toBe('order customer');
  });

  it('without an existing manifest returns the fresh one unchanged', () => {
    expect(mergeManifest(fresh, null)).toBe(fresh);
  });

  it('adopts the fresh structure: columns/tables no longer present disappear', () => {
    const existing: SchemaManifest = {
      generatedAt: '2026-06-01T00:00:00.000Z', dialect: 'mysql', relations: [],
      tables: [
        { name: 'clienti', comment: '', deny: false, columns: [
          { name: 'cod_cli', type: 'int', comment: '' },
          { name: 'campo_rimosso', type: 'int', comment: 'old' },
        ] },
        { name: 'tabella_rimossa', comment: 'x', deny: true, columns: [] },
      ],
    };
    const m = mergeManifest(fresh, existing);
    expect(m.tables.map((t) => t.name)).toEqual(['clienti', 'ordini']);
    expect(m.tables[0].columns.map((c) => c.name)).toEqual(['cod_cli', 'nome']);
  });
});

describe('deny — discovery', () => {
  it('deniedTableNames collects denied tables in lowercase', () => {
    const m: SchemaManifest = { ...fresh, tables: [
      { ...fresh.tables[0], name: 'Clienti', deny: true },
      { ...fresh.tables[1], deny: false },
    ] };
    expect([...deniedTableNames(m)]).toEqual(['clienti']);
  });

  it('renderManifestFull annotates FKs inline and inbound relations', () => {
    const out = renderManifestFull(fresh);   // relation: ordini.cod_cli → clienti.cod_cli
    expect(out).toContain('### clienti');
    expect(out).toContain('### ordini');
    // OUTBOUND FK annotated inline on the ordini column
    expect(out).toContain('cod_cli (int)  → clienti.cod_cli');
    // clienti receives the INBOUND relation ("referenced by")
    expect(out).toContain('referenced by:');
    expect(out).toContain('← ordini.cod_cli → clienti.cod_cli');
  });

  it('renderManifestFull excludes denied tables', () => {
    const m: SchemaManifest = { ...fresh, tables: [
      { ...fresh.tables[0], deny: true },
      fresh.tables[1],
    ] };
    const out = renderManifestFull(m);
    expect(out).not.toContain('### clienti');
    expect(out).toContain('### ordini');
  });

  it('renderManifestCompact lists table names but not columns', () => {
    const out = renderManifestCompact(fresh);
    expect(out).toContain('clienti');
    expect(out).toContain('ordini');
    // no column blocks in compact
    expect(out).not.toContain('### clienti');
    expect(out).not.toContain('(varchar(100))');
    // relations present + prompt to describe_tables (step 2)
    expect(out).toContain('ordini.cod_cli → clienti.cod_cli');
    expect(out).toContain('describe_tables');
  });

  it('renderManifestColumns renders only the requested tables and reports the missing ones', () => {
    const out = renderManifestColumns(fresh, ['clienti', 'nonexistent']);
    expect(out).toContain('### clienti');
    expect(out).toContain('nome (varchar(100))');
    expect(out).not.toContain('### ordini');           // not requested
    expect(out).toContain('Tables not found: nonexistent');
  });

  it('deny fields do not appear in the schema or in the relations', () => {
    const m: SchemaManifest = {
      ...fresh,
      relations: [{ from: 'ordini.cliente_ref', to: 'clienti.cod_cli', label: 'x' }],
      tables: [
        { name: 'clienti', comment: '', deny: false, columns: [
          { name: 'cod_cli', type: 'int', comment: '' },
          { name: 'segreto', type: 'varchar(100)', comment: '', deny: true },  // denied field
        ] },
        { name: 'ordini', comment: '', deny: false, columns: [
          { name: 'id', type: 'int', comment: '' },
          { name: 'cliente_ref', type: 'int', comment: '', deny: true },        // denied FK
        ] },
      ],
    };
    const full = renderManifestFull(m);
    expect(full).toContain('cod_cli');                   // visible column stays
    expect(full).not.toContain('segreto');               // denied column absent
    expect(full).not.toContain('cliente_ref');           // denied FK absent
    expect(full).not.toContain('referenced by');         // the relation touches cliente_ref (deny) → disappears
    // describe of the single table likewise
    const cols = renderManifestColumns(m, ['clienti']);
    expect(cols).toContain('cod_cli');
    expect(cols).not.toContain('segreto');
  });
});
