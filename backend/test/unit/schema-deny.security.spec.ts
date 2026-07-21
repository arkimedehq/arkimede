/**
 * Enforcement of `deny` tables in the SQL guard — `referencedTables` +
 * `evaluateSqlPolicy(..., deniedTables)` in `custom-tools/custom-tool.factory.ts`.
 *
 * Invariant: any statement that references a denied table is rejected,
 * even if the operation (e.g. SELECT) would otherwise be allowed. Best-effort
 * extraction of table names (FROM/JOIN/INTO/UPDATE), normalized to lowercase.
 */
import { describe, it, expect } from 'vitest';
import { evaluateSqlPolicy, referencedTables } from '../../src/custom-tools/custom-tool.factory';
import type { SqlExecutorConfig } from '../../src/custom-tools/custom-tool.types';

const base = (over: Partial<SqlExecutorConfig> = {}): SqlExecutorConfig => ({
  dataSourceId: 'x', queryParam: 'q', ...over,
});

describe('referencedTables', () => {
  it('extracts tables from FROM and JOIN, discarding schema and quoting', () => {
    const t = referencedTables('SELECT * FROM `db`.`Clienti` c JOIN ordini o ON o.cod = c.cod');
    expect(t).toContain('clienti');
    expect(t).toContain('ordini');
  });

  it('extracts the table from UPDATE and INSERT INTO', () => {
    expect(referencedTables('UPDATE segreti SET x=1')).toContain('segreti');
    expect(referencedTables('INSERT INTO audit(x) VALUES (1)')).toContain('audit');
  });
});

describe('evaluateSqlPolicy — deny tables', () => {
  const denied = new Set(['segreti']);

  it('blocks a SELECT that touches a denied table', () => {
    const r = evaluateSqlPolicy(base(), 'SELECT * FROM segreti', {}, denied);
    expect(r.error).toMatch(/table "segreti" not accessible/);
  });

  it('blocks also via JOIN on a denied table', () => {
    const r = evaluateSqlPolicy(base(), 'SELECT * FROM clienti c JOIN segreti s ON s.id=c.id', {}, denied);
    expect(r.error).toMatch(/not accessible/);
  });

  it('allows queries that do not touch denied tables', () => {
    const r = evaluateSqlPolicy(base(), 'SELECT * FROM clienti', {}, denied);
    expect(r.error).toBeUndefined();
  });

  it('without a deny set (default) blocks nothing', () => {
    const r = evaluateSqlPolicy(base(), 'SELECT * FROM segreti', {});
    expect(r.error).toBeUndefined();
  });
});

describe('evaluateSqlPolicy — deny columns', () => {
  const noTables = new Set<string>();
  const cols = new Set(['utenti.password']);

  it('blocks the qualified reference utenti.password', () => {
    const r = evaluateSqlPolicy(base(), 'SELECT id, utenti.password FROM utenti', {}, noTables, cols);
    expect(r.error).toMatch(/utenti\.password" not accessible/);
  });

  it('blocks the bare reference to the denied column of a cited table', () => {
    const r = evaluateSqlPolicy(base(), 'SELECT id, password FROM utenti', {}, noTables, cols);
    expect(r.error).toMatch(/not accessible/);
  });

  it('rejects SELECT * on the table with denied columns', () => {
    const r = evaluateSqlPolicy(base(), 'SELECT * FROM utenti', {}, noTables, cols);
    expect(r.error).toMatch(/SELECT \*/);
  });

  it('rejects utenti.* (qualified star)', () => {
    const r = evaluateSqlPolicy(base(), 'SELECT u.* FROM utenti u', {}, noTables, cols);
    expect(r.error).toMatch(/SELECT \*/);
  });

  it('allows an explicit SELECT of non-denied columns', () => {
    const r = evaluateSqlPolicy(base(), 'SELECT id, email FROM utenti', {}, noTables, cols);
    expect(r.error).toBeUndefined();
  });

  it('does not confuse a string value with the column name', () => {
    const r = evaluateSqlPolicy(base(), "SELECT id FROM utenti WHERE nota = 'password'", {}, noTables, cols);
    expect(r.error).toBeUndefined();
  });

  it('count(*) is not treated as a star-leak', () => {
    const r = evaluateSqlPolicy(base(), 'SELECT count(*) FROM utenti', {}, noTables, cols);
    expect(r.error).toBeUndefined();
  });
});
