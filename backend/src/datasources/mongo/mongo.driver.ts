/**
 * @file mongo.driver.ts
 *
 * MongoDB driver (optional `mongodb` package, lazy-loaded). Unlike the
 * SQL drivers (SqlDriver interface), Mongo is a "document" family with its own
 * contract: **sampling**-based introspection (no fixed schema) and execution of
 * find/aggregate/count/distinct operations (read) + insert/update/delete (write opt-in).
 *
 * Connection string: `mongodb://user:pass@host:27017/dbname` (or `mongodb+srv://…`).
 * The database name must be included in the URI path.
 *
 * Read-only: MongoDB has no "read-only transaction"; security is provided by the
 * operation whitelist applied in the tool executor (as for SQL Server).
 */
import { DocumentManifest, DocumentCollection, DocumentField } from '../document-manifest.types';
import { loadOptional } from '../drivers/optional-module';

// Cached, already-connected MongoClient instances, keyed by connection string.
const clients = new Map<string, Promise<any>>();

function mongolib(): any {
  return loadOptional('mongodb', 'mongodb');
}

function getClient(connStr: string): Promise<any> {
  if (!clients.has(connStr)) {
    const { MongoClient } = mongolib();
    const client = new MongoClient(connStr, { serverSelectionTimeoutMS: 5000 });
    clients.set(connStr, client.connect().catch((e: any) => { clients.delete(connStr); throw e; }));
  }
  return clients.get(connStr)!;
}

/** Extracts the database name from the URI path. Throws if absent. */
function dbName(connStr: string): string {
  const m = connStr.match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)/i);
  const name = m?.[1] ? decodeURIComponent(m[1]) : '';
  if (!name) {
    throw new Error('The MongoDB connection string must include the database name: mongodb://host:27017/<db>');
  }
  return name;
}

async function getDb(connStr: string): Promise<any> {
  const client = await getClient(connStr);
  return client.db(dbName(connStr));
}

// ── BSON type inference (for sampling) ─────────────────────────────────────

function bsonType(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return 'array';
  const t = typeof v;
  if (t === 'string') return 'string';
  if (t === 'boolean') return 'bool';
  if (t === 'number') return Number.isInteger(v) ? 'int' : 'double';
  if (t === 'object') {
    const o = v as any;
    if (o instanceof Date) return 'date';
    const cn = o?.constructor?.name;
    if (cn === 'ObjectId') return 'objectId';
    if (cn === 'Decimal128') return 'decimal';
    if (cn === 'Long') return 'long';
    if (cn === 'Binary') return 'binary';
    return 'object';
  }
  return t;
}

function isPlainObject(v: unknown): boolean {
  return bsonType(v) === 'object';
}

// ── Driver ──────────────────────────────────────────────────────────────────────

export type MongoOp =
  | 'find' | 'aggregate' | 'countDocuments' | 'distinct'
  | 'insertOne' | 'insertMany' | 'updateOne' | 'updateMany' | 'deleteOne' | 'deleteMany';

/** Read-only operations (the others require opt-in write capability). */
export const MONGO_READ_OPS: MongoOp[] = ['find', 'aggregate', 'countDocuments', 'distinct'];

export interface MongoExecuteSpec {
  collection: string;
  op: MongoOp;
  filter?: Record<string, unknown>;
  pipeline?: Record<string, unknown>[];
  document?: Record<string, unknown>;
  documents?: Record<string, unknown>[];
  update?: Record<string, unknown>;
  field?: string;                       // distinct
  projection?: Record<string, unknown>;
  sort?: Record<string, unknown>;
  limit?: number;
}

export interface MongoExecuteResult {
  rows: Record<string, unknown>[];
  affected: number;
}

export const mongoDriver = {
  scheme: 'mongodb://user:pass@host:27017/db',

  /** Ping: { ping: 1 } command on the database. */
  async testConnection(connStr: string): Promise<void> {
    const db = await getDb(connStr);
    await db.command({ ping: 1 });
  },

  /** Lists the collections (excluding system.*). */
  async listCollections(connStr: string): Promise<string[]> {
    const db = await getDb(connStr);
    const cols = await db.listCollections({}, { nameOnly: true }).toArray();
    return cols.map((c: any) => c.name).filter((n: string) => !n.startsWith('system.')).sort();
  },

  /**
   * Samples N documents per collection and infers the fields (path, observed types,
   * frequency). Returns a base DocumentManifest (empty comments, deny=false).
   */
  async introspectSample(connStr: string, sampleSize = 100): Promise<DocumentManifest> {
    const db = await getDb(connStr);
    const names = await this.listCollections(connStr);
    const collections: DocumentCollection[] = [];
    for (const name of names) {
      const fields = await this.sampleFields(db, name, sampleSize);
      collections.push({ name, comment: '', deny: false, fields });
    }
    return { generatedAt: new Date().toISOString(), engine: 'mongodb', collections };
  },

  /** Fields (with types+frequency) of the requested collections — describe on-demand. */
  async sampleCollections(connStr: string, names: string[], sampleSize = 100): Promise<DocumentCollection[]> {
    const db = await getDb(connStr);
    const out: DocumentCollection[] = [];
    for (const name of names) {
      const fields = await this.sampleFields(db, name, sampleSize);
      out.push({ name, comment: '', deny: false, fields });
    }
    return out;
  },

  /** Samples a collection and infers the fields (up to 2 levels of nesting). */
  async sampleFields(db: any, name: string, sampleSize: number): Promise<DocumentField[]> {
    let docs: any[] = [];
    try {
      docs = await db.collection(name).aggregate([{ $sample: { size: sampleSize } }], { maxTimeMS: 15000 }).toArray();
    } catch {
      docs = await db.collection(name).find({}, { limit: sampleSize, maxTimeMS: 15000 }).toArray();
    }
    if (!docs.length) return [];

    const acc = new Map<string, { types: Set<string>; count: number }>();
    const note = (path: string, type: string) => {
      if (!acc.has(path)) acc.set(path, { types: new Set(), count: 0 });
      const e = acc.get(path)!;
      e.types.add(type);
      e.count++;
    };
    const walk = (obj: Record<string, unknown>, prefix: string, depth: number) => {
      for (const [k, v] of Object.entries(obj)) {
        const path = prefix ? `${prefix}.${k}` : k;
        note(path, bsonType(v));
        if (depth > 0 && isPlainObject(v)) walk(v as Record<string, unknown>, path, depth - 1);
      }
    };
    for (const d of docs) walk(d, '', 2);

    return [...acc.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([path, e]) => ({
        path,
        types: [...e.types].sort(),
        frequency: e.count / docs.length,
        comment: '',
      }));
  },

  /**
   * Executes a Mongo operation. The operation whitelist is already applied
   * by the tool executor (here read/write is not distinguished: the op is already allowed).
   */
  async execute(connStr: string, spec: MongoExecuteSpec, maxRows: number, timeout: number): Promise<MongoExecuteResult> {
    const db = await getDb(connStr);
    const coll = db.collection(spec.collection);
    const o = { maxTimeMS: timeout };

    switch (spec.op) {
      case 'find': {
        let cur = coll.find(spec.filter ?? {}, { projection: spec.projection, ...o });
        if (spec.sort) cur = cur.sort(spec.sort);
        cur = cur.limit(Math.min(spec.limit ?? maxRows, maxRows));
        const rows = await cur.toArray();
        return { rows, affected: rows.length };
      }
      case 'aggregate': {
        const pipeline = [...(spec.pipeline ?? [])];
        if (!pipeline.some((s) => '$limit' in s)) pipeline.push({ $limit: maxRows });
        const rows = await coll.aggregate(pipeline, o).toArray();
        return { rows, affected: rows.length };
      }
      case 'countDocuments': {
        const n = await coll.countDocuments(spec.filter ?? {}, o);
        return { rows: [{ count: n }], affected: n };
      }
      case 'distinct': {
        if (!spec.field) throw new Error('distinct richiede "field".');
        const vals = await coll.distinct(spec.field, spec.filter ?? {}, o);
        return { rows: vals.map((v: unknown) => ({ [spec.field!]: v })), affected: vals.length };
      }
      case 'insertOne': {
        const r = await coll.insertOne(spec.document ?? {});
        return { rows: [{ insertedId: r.insertedId }], affected: 1 };
      }
      case 'insertMany': {
        const r = await coll.insertMany(spec.documents ?? []);
        return { rows: [{ insertedCount: r.insertedCount }], affected: r.insertedCount };
      }
      case 'updateOne':
      case 'updateMany': {
        if (!spec.update) throw new Error(`${spec.op} richiede "update".`);
        const r = await coll[spec.op](spec.filter ?? {}, spec.update);
        return { rows: [{ matchedCount: r.matchedCount, modifiedCount: r.modifiedCount }], affected: r.modifiedCount };
      }
      case 'deleteOne':
      case 'deleteMany': {
        const r = await coll[spec.op](spec.filter ?? {});
        return { rows: [{ deletedCount: r.deletedCount }], affected: r.deletedCount };
      }
      default:
        throw new Error(`Operazione Mongo non supportata: "${(spec as any).op}".`);
    }
  },
};
