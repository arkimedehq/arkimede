// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * An in-memory TypeORM repository for unit tests: find / findOne / exists / save / create / update / delete / remove
 * over plain rows, `where` by equality (plus the In, Like and LessThan operators), `order` and `take`; and the one
 * query-builder insert the plugins use (`insert…orIgnore…execute`), honouring a unique key.
 */
import { randomUUID } from 'crypto';

type Row = Record<string, any>;

/** SQL LIKE as a regex: % any run, _ one character, backslash escapes the next one. */
function likeRegex(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\' && i + 1 < pattern.length) re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    else if (c === '%') re += '.*';
    else if (c === '_') re += '.';
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 's');
}

function matchValue(value: any, cond: any): boolean {
  if (cond && typeof cond === 'object' && cond.constructor?.name === 'FindOperator') {
    switch (cond.type) {
      case 'in': return (cond.value as any[]).includes(value);
      case 'like': return likeRegex(String(cond.value)).test(String(value));
      case 'lessThan': return value < cond.value;
      default: return false;
    }
  }
  return value === cond;
}

function matches(row: Row, where: any): boolean {
  if (!where) return true;
  if (Array.isArray(where)) return where.some((w) => matches(row, w));
  return Object.entries(where).every(([k, v]) => matchValue(row[k], v));
}

export function fakeRepo<T extends Row>(initial: T[] = [], opts: { unique?: string[] } = {}) {
  const rows: T[] = initial;
  const clone = (r: T) => ({ ...r });
  const repo = {
    rows,
    create: (x: Partial<T>) => ({ ...x }) as T,
    async save(x: any): Promise<any> {
      if (Array.isArray(x)) return Promise.all(x.map((y) => repo.save(y)));
      if (!x.id) x.id = randomUUID();
      const i = rows.findIndex((r) => r.id === x.id);
      const now = new Date();
      if (i >= 0) rows[i] = { ...rows[i], ...x, updatedAt: now };
      else rows.push({ createdAt: now, updatedAt: now, ...x });
      return clone(rows.find((r) => r.id === x.id)!);
    },
    async find(o: any = {}): Promise<T[]> {
      let out = rows.filter((r) => matches(r, o.where));
      if (o.order) {
        const [[k, dir]] = Object.entries(o.order) as [string, string][];
        out = [...out].sort((a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0) * (dir === 'DESC' ? -1 : 1));
      }
      if (o.take) out = out.slice(0, o.take);
      return out.map(clone);
    },
    async findOne(o: any): Promise<T | null> {
      return (await repo.find(o))[0] ?? null;
    },
    async exists(o: any): Promise<boolean> {
      return (await repo.find(o)).length > 0;
    },
    async update(crit: any, patch: Partial<T>): Promise<void> {
      for (const r of rows) if (typeof crit === 'string' || typeof crit === 'number' ? r.id === crit : matches(r, crit)) Object.assign(r, patch);
    },
    async delete(crit: any): Promise<void> {
      for (let i = rows.length - 1; i >= 0; i--) if (typeof crit === 'string' ? rows[i].id === crit : matches(rows[i], crit)) rows.splice(i, 1);
    },
    async remove(x: T): Promise<void> {
      await repo.delete(x.id);
    },
    createQueryBuilder() {
      let value: Row | null = null;
      const qb: any = {
        insert: () => qb, into: () => qb, orIgnore: () => qb, returning: () => qb,
        values: (v: Row) => { value = v; return qb; },
        async execute() {
          const v = { ...value! };
          if (opts.unique && rows.some((r) => opts.unique!.every((k) => r[k] === v[k]))) return { identifiers: [], raw: [] };
          const saved = await repo.save(v);
          return { identifiers: [{ id: saved.id }], raw: [{ id: saved.id }] };
        },
      };
      return qb;
    },
  };
  return repo;
}
