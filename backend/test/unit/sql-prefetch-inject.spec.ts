/**
 * Schema injection into the LLM before using the SQL tool — real path
 * `buildDynamicTool → executeSql → fetchSchema` in free-mode (queryParam) without a query.
 *
 * When the DataSource has a manifest, the prefetch renders it WITHOUT touching the DB
 * (early-return) and excludes `deny` tables: the tool returns exactly the
 * text the agent receives as the first step before formulating the SELECT.
 */
import { describe, it, expect } from 'vitest';
import { buildDynamicTool } from '../../src/custom-tools/custom-tool.factory';
import type { CustomTool } from '../../src/custom-tools/custom-tool.entity';
import type { ResolvedDataSource, SqlExecutorConfig } from '../../src/custom-tools/custom-tool.types';
import type { SchemaManifest } from '../../src/datasources/schema-manifest.types';

const manifest: SchemaManifest = {
  generatedAt: '2026-06-10T12:00:00.000Z',
  dialect: 'mysql',
  relations: [{ from: 'ordini.cod_cli', to: 'clienti.cod_cli', label: 'cliente dell\'ordine' }],
  tables: [
    { name: 'clienti', comment: 'Anagrafica clienti', deny: false, columns: [
      { name: 'cod_cli', type: 'int', comment: 'Codice cliente' },
      { name: 'nome', type: 'varchar(100)', comment: '' },
    ] },
    { name: 'ordini', comment: 'Testata ordini', deny: false, columns: [
      { name: 'id', type: 'int', comment: '' },
      { name: 'cod_cli', type: 'int', comment: '' },
    ] },
    { name: 'segreti', comment: 'tabella riservata', deny: true, columns: [
      { name: 'token', type: 'varchar(255)', comment: '' },
    ] },
  ],
};

const makeToolDef = (cfg: SqlExecutorConfig) => ({
  name: 'query_db',
  description: 'Interroga il gestionale',
  parameters: [{ name: 'q', type: 'string', description: 'SELECT da eseguire', required: false }],
  executorType: 'sql',
  executorConfig: cfg,
} as unknown as CustomTool);

// syntactically valid but NEVER used connection string: with the manifest the prefetch
// does not connect and, without a query, no statement is executed.
const dataSource: ResolvedDataSource = {
  engine: 'mysql',
  connectionString: 'mysql://u:p@127.0.0.1:3306/db',
  schemaManifest: manifest,
};

describe('inject schema nel LLM (prefetch da manifest)', () => {
  it('compact (default): lista tabelle + relazioni, senza colonne, con invito a describe', async () => {
    const tool = buildDynamicTool(makeToolDef({ dataSourceId: 'x', queryParam: 'q' }), {}, dataSource);
    const out = String(await tool.invoke({}));

    // Table catalog with comments, no column blocks
    expect(out).toContain('clienti — Anagrafica clienti');
    expect(out).toContain('ordini — Testata ordini');
    expect(out).not.toContain('### clienti');
    // Injected relation
    expect(out).toContain('ordini.cod_cli → clienti.cod_cli — cliente dell\'ordine');
    // On-demand step 2 + prompt to query
    expect(out).toContain('describe_tables');
    expect(out).toContain('"q"');
  });

  it('full: schema completo con colonne e FK', async () => {
    const tool = buildDynamicTool(makeToolDef({ dataSourceId: 'x', queryParam: 'q', schemaMode: 'full' }), {}, dataSource);
    const out = String(await tool.invoke({}));

    expect(out).toContain('### clienti — Anagrafica clienti');
    expect(out).toContain('cod_cli (int) — Codice cliente');
    expect(out).toContain('### ordini — Testata ordini');
  });

  it('la tabella deny NON viene mai mostrata al LLM (compact né full)', async () => {
    for (const mode of [undefined, 'full'] as const) {
      const tool = buildDynamicTool(makeToolDef({ dataSourceId: 'x', queryParam: 'q', schemaMode: mode }), {}, dataSource);
      const out = String(await tool.invoke({}));
      expect(out).not.toContain('segreti');
      expect(out).not.toContain('token');
    }
  });
});
