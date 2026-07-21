/**
 * SQL operations capability (E1) — `evaluateSqlPolicy` in
 * `custom-tools/custom-tool.factory.ts` (pure function).
 *
 * Invariant: the tool executes ONLY the declared operations; free-mode is
 * single-statement (anti-injection); requireWhere/confirmDestructive are
 * enforced when active. Migrated from `scripts/smoke-sql-policy.ts`.
 */
import { describe, it, expect } from 'vitest';
import { evaluateSqlPolicy } from '../../src/custom-tools/custom-tool.factory';
import type { SqlExecutorConfig } from '../../src/custom-tools/custom-tool.types';

/** Free-mode config (queryParam) — the actual default for SQL tools. */
const base = (over: Partial<SqlExecutorConfig>): SqlExecutorConfig => ({
  dataSourceId: 'x',
  queryParam: 'q',
  ...over,
});

describe('SQL policy — read-only by default', () => {
  it('SELECT allowed, READ ONLY, onlySelect', () => {
    const r = evaluateSqlPolicy(base({}), 'SELECT * FROM clienti', {});
    expect(r.error).toBeUndefined();
    expect(r.isReadOnlyTool).toBe(true);
    expect(r.onlySelect).toBe(true);
  });

  it('DELETE denied with a readable message', () => {
    const r = evaluateSqlPolicy(base({}), 'DELETE FROM clienti WHERE id=1', {});
    expect(r.error).toMatch(/operation "delete" not allowed/);
  });
});

describe('SQL policy — side-effecting SELECTs (L1)', () => {
  it('blocks server FS/OS functions on a read-only tool (pg_read_file)', () => {
    const r = evaluateSqlPolicy(base({}), "SELECT pg_read_file('/etc/passwd')", {});
    expect(r.error).toMatch(/filesystem\/OS access/);
  });

  it('blocks SELECT ... INTO OUTFILE (file write) even with write ops', () => {
    const r = evaluateSqlPolicy(base({ operations: ['select', 'insert', 'update', 'delete', 'ddl'] }),
      "SELECT * FROM users INTO OUTFILE '/tmp/x'", {});
    expect(r.error).toMatch(/filesystem\/OS access/);
  });

  it('blocks xp_cmdshell', () => {
    const r = evaluateSqlPolicy(base({}), "SELECT * FROM OPENROWSET('x','y','z')", {});
    expect(r.error).toMatch(/filesystem\/OS access/);
  });

  it('blocks SELECT ... INTO <table> on a read-only tool', () => {
    const r = evaluateSqlPolicy(base({}), 'SELECT id, name INTO archive_users FROM users', {});
    expect(r.error).toMatch(/SELECT \.\.\. INTO/);
  });

  it('allows a plain SELECT that merely contains the word in a string/column', () => {
    const r = evaluateSqlPolicy(base({}), "SELECT id FROM users WHERE note = 'into the woods'", {});
    expect(r.error).toBeUndefined();
  });

  it('does not touch INSERT INTO (a normal write op)', () => {
    const r = evaluateSqlPolicy(base({ operations: ['select', 'insert'] }), 'INSERT INTO log(x) VALUES (1)', {});
    expect(r.error).toBeUndefined();
  });
});

describe('SQL policy — declared operations', () => {
  it('[select,insert]: INSERT allowed, not read-only', () => {
    const r = evaluateSqlPolicy(base({ operations: ['select', 'insert'] }), 'INSERT INTO log(x) VALUES (1)', {});
    expect(r.error).toBeUndefined();
    expect(r.isReadOnlyTool).toBe(false);
  });

  it('DDL denied if not listed', () => {
    const r = evaluateSqlPolicy(base({ operations: ['select', 'insert'] }), 'DROP TABLE log', {});
    expect(r.error).toMatch(/"ddl"/);
  });

  it('DDL allowed if explicitly declared', () => {
    const r = evaluateSqlPolicy(base({ operations: ['select', 'insert', 'update', 'delete', 'ddl'] }), 'DROP TABLE log', {});
    expect(r.error).toBeUndefined();
  });
});

describe('SQL policy — single-statement (anti-injection)', () => {
  it('free-mode: concatenated statements denied', () => {
    const r = evaluateSqlPolicy(base({}), 'SELECT * FROM users; DROP TABLE audit', {});
    expect(r.error).toMatch(/a single statement/);
  });

  it("free-mode: ';' inside a string does not split", () => {
    const r = evaluateSqlPolicy(base({}), "SELECT * FROM t WHERE note = 'a;b'", {});
    expect(r.error).toBeUndefined();
  });

  it('Mode A (queryTemplate): intentional multi-statement allowed', () => {
    const cfg = {
      dataSourceId: 'x',
      queryTemplate: 'INSERT INTO a VALUES(1); UPDATE b SET x=1 WHERE id=2',
      operations: ['insert', 'update'],
    } as SqlExecutorConfig;
    const r = evaluateSqlPolicy(cfg, 'INSERT INTO a VALUES(1); UPDATE b SET x=1 WHERE id=2', {});
    expect(r.error).toBeUndefined();
  });

  it('CTE with DELETE is classified as write and denied', () => {
    const r = evaluateSqlPolicy(base({ operations: ['select'] }), 'WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x', {});
    expect(r.error).toMatch(/"delete"/);
  });
});

describe('SQL policy — guardrail opt-in', () => {
  it('requireWhere: DELETE without WHERE denied', () => {
    const r = evaluateSqlPolicy(base({ operations: ['select', 'delete'], requireWhere: true }), 'DELETE FROM clienti', {});
    expect(r.error).toMatch(/without a WHERE clause/);
  });

  it('requireWhere: DELETE with WHERE allowed', () => {
    const r = evaluateSqlPolicy(base({ operations: ['select', 'delete'], requireWhere: true }), 'DELETE FROM clienti WHERE id=1', {});
    expect(r.error).toBeUndefined();
  });

  it('confirmDestructive: without confirm denied', () => {
    const r = evaluateSqlPolicy(base({ operations: ['select', 'update'], confirmDestructive: true }), 'UPDATE t SET x=1 WHERE id=1', {});
    expect(r.error).toMatch(/requires confirmation/);
  });

  it('confirmDestructive: with confirm=true allowed', () => {
    const r = evaluateSqlPolicy(base({ operations: ['select', 'update'], confirmDestructive: true }), 'UPDATE t SET x=1 WHERE id=1', { confirm: true });
    expect(r.error).toBeUndefined();
  });
});
