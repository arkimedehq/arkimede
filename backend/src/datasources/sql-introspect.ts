/**
 * @file sql-introspect.ts
 *
 * Introspects the schema of an external DB via the engine driver, returned
 * as a "base" SchemaManifest: structure + comments already present in the DB + relations
 * from the declared FKs. Missing comments stay empty (the enrich step fills them in).
 *
 * All dialect-specific code lives in the drivers (`drivers/`): here we only keep
 * the common assembly of the normalized rows into the manifest. No writes to the
 * customer's DB.
 */
import { getDriver, IntrospectTable, IntrospectColumn, IntrospectRelation } from './drivers';
import { SqlEngine } from './engine.types';
import {
  SchemaManifest, SchemaManifestTable, SchemaManifestRelation,
} from './schema-manifest.types';

/** Timeout per le query di introspezione (operazione occasionale, da un click). */
const INTROSPECT_TIMEOUT_MS = 15_000;

/** Introspeziona lo schema e produce un manifest base (deny=false ovunque). */
export async function introspectSchema(connStr: string, engine: SqlEngine): Promise<SchemaManifest> {
  const driver = getDriver(engine);
  const [tables, columns, relations] = await Promise.all([
    driver.fetchTables(connStr, INTROSPECT_TIMEOUT_MS),
    driver.fetchAllColumns(connStr, INTROSPECT_TIMEOUT_MS),
    driver.fetchRelations(connStr, INTROSPECT_TIMEOUT_MS),
  ]);
  return assemble(engine, tables, columns, relations);
}

/** Assembla le row normalizzate dei driver in uno SchemaManifest. */
function assemble(
  engine: SqlEngine,
  tableRows: IntrospectTable[],
  colRows: IntrospectColumn[],
  fkRows: IntrospectRelation[],
): SchemaManifest {
  const colsByTable = new Map<string, Array<{ name: string; type: string; comment: string }>>();
  for (const c of colRows) {
    if (!colsByTable.has(c.tableName)) colsByTable.set(c.tableName, []);
    colsByTable.get(c.tableName)!.push({ name: c.name, type: c.type, comment: c.comment ?? '' });
  }

  const tables: SchemaManifestTable[] = tableRows.map((t) => ({
    name: t.name,
    comment: t.comment ?? '',
    deny: false,
    columns: colsByTable.get(t.name) ?? [],
  }));

  const relations: SchemaManifestRelation[] = fkRows.map((f) => ({
    from: `${f.fromTable}.${f.fromCol}`,
    to: `${f.toTable}.${f.toCol}`,
  }));

  return { generatedAt: new Date().toISOString(), dialect: engine, relations, tables };
}
