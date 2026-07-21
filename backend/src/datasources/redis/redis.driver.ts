/**
 * @file redis.driver.ts
 *
 * Redis driver (optional `ioredis` package, lazy-loaded). "keyvalue" family:
 * no fixed schema. **Sampling**-based introspection (SCAN → key patterns +
 * type); execution of arbitrary Redis **commands** with whitelist (read by default,
 * write opt-in; administrative/dangerous commands always blocked).
 *
 * Connection string: `redis://[:password@]host:6379[/db]` (or `rediss://` for TLS).
 */
import { KeyspaceManifest, KeyPattern } from '../keyspace-manifest.types';
import { loadOptional } from '../drivers/optional-module';

const clients = new Map<string, any>();

function getClient(connStr: string): any {
  if (!clients.has(connStr)) {
    const mod = loadOptional('ioredis', 'redis');
    const Redis = mod.default ?? mod;
    clients.set(connStr, new Redis(connStr, {
      maxRetriesPerRequest: 1,
      connectTimeout: 5000,
      commandTimeout: 10000,
      retryStrategy: (times: number) => (times > 1 ? null : 200),
      lazyConnect: false,
    }));
  }
  return clients.get(connStr)!;
}

// ── Command whitelist ─────────────────────────────────────────────────────────────

/** Read-only commands allowed by default. */
export const REDIS_READ_COMMANDS = new Set<string>([
  'GET', 'MGET', 'STRLEN', 'GETRANGE', 'SUBSTR',
  'HGET', 'HGETALL', 'HKEYS', 'HVALS', 'HLEN', 'HMGET', 'HEXISTS', 'HSCAN', 'HRANDFIELD',
  'LRANGE', 'LLEN', 'LINDEX', 'LPOS',
  'SMEMBERS', 'SISMEMBER', 'SCARD', 'SSCAN', 'SRANDMEMBER', 'SINTER', 'SUNION', 'SDIFF',
  'ZRANGE', 'ZRANGEBYSCORE', 'ZREVRANGE', 'ZRANGEBYLEX', 'ZSCORE', 'ZCARD', 'ZRANK', 'ZREVRANK', 'ZCOUNT', 'ZSCAN',
  'XRANGE', 'XREVRANGE', 'XLEN', 'XREAD',
  'TYPE', 'TTL', 'PTTL', 'EXISTS', 'SCAN', 'KEYS', 'DBSIZE', 'RANDOMKEY', 'OBJECT', 'MEMORY', 'DUMP',
  'BITCOUNT', 'GETBIT', 'PFCOUNT', 'GEODIST', 'GEOPOS', 'GEOSEARCH', 'PING', 'INFO',
]);

/** Administrative/dangerous commands: always blocked, even with write enabled. */
export const REDIS_BLOCKED_COMMANDS = new Set<string>([
  'FLUSHALL', 'FLUSHDB', 'SWAPDB', 'CONFIG', 'SHUTDOWN', 'DEBUG', 'SCRIPT', 'EVAL', 'EVALSHA',
  'FUNCTION', 'FCALL', 'SAVE', 'BGSAVE', 'BGREWRITEAOF', 'REPLICAOF', 'SLAVEOF', 'CLUSTER',
  'ACL', 'CLIENT', 'MODULE', 'MIGRATE', 'RESET', 'FAILOVER', 'MONITOR', 'SUBSCRIBE', 'PSUBSCRIBE',
  'WAIT', 'LATENCY', 'SLOWLOG', 'LASTSAVE', 'COMMAND',
]);

export type RedisCommandClass = 'read' | 'write' | 'blocked';

export function classifyRedisCommand(command: string): RedisCommandClass {
  const c = command.toUpperCase();
  if (REDIS_BLOCKED_COMMANDS.has(c)) return 'blocked';
  if (REDIS_READ_COMMANDS.has(c)) return 'read';
  return 'write';
}

// ── Keyspace introspection (sampling) ─────────────────────────────────────────

/** Pattern of a key: prefix up to the first ':' (e.g. "user:42" → "user:*"). */
function keyPattern(key: string): string {
  const i = key.indexOf(':');
  return i >= 0 ? `${key.slice(0, i)}:*` : key;
}

export const redisDriver = {
  scheme: 'redis://:password@host:6379/0',

  async testConnection(connStr: string): Promise<void> {
    const r = await getClient(connStr).ping();
    if (String(r).toUpperCase() !== 'PONG') throw new Error(`risposta inattesa al PING: ${r}`);
  },

  /** SCAN of a sample of keys → pattern + type + sample keys. */
  async introspectKeyspace(connStr: string, sampleSize = 500): Promise<KeyspaceManifest> {
    const client = getClient(connStr);
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await client.scan(cursor, 'COUNT', 250);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0' && keys.length < sampleSize);

    const byPattern = new Map<string, string[]>();
    for (const k of keys.slice(0, sampleSize)) {
      const pat = keyPattern(k);
      if (!byPattern.has(pat)) byPattern.set(pat, []);
      byPattern.get(pat)!.push(k);
    }

    const patterns: KeyPattern[] = [];
    for (const [pattern, pkeys] of byPattern) {
      let type = 'unknown';
      try { type = await client.type(pkeys[0]); } catch { /* ignore */ }
      patterns.push({ pattern, type, count: pkeys.length, comment: '', deny: false, sampleKeys: pkeys.slice(0, 3) });
    }
    patterns.sort((a, b) => a.pattern.localeCompare(b.pattern));
    return { generatedAt: new Date().toISOString(), engine: 'redis', patterns };
  },

  /** Sample keys for the requested patterns (describe on-demand, live). */
  async samplePatternKeys(connStr: string, patterns: string[], perPattern = 10): Promise<Record<string, string[]>> {
    const client = getClient(connStr);
    const out: Record<string, string[]> = {};
    for (const pat of patterns) {
      const found: string[] = [];
      let cursor = '0';
      do {
        const [next, batch] = await client.scan(cursor, 'MATCH', pat, 'COUNT', 100);
        cursor = next;
        found.push(...batch);
      } while (cursor !== '0' && found.length < perPattern);
      out[pat] = found.slice(0, perPattern);
    }
    return out;
  },

  /** Executes an arbitrary Redis command (the whitelist is applied by the executor). */
  async execute(connStr: string, command: string, args: unknown[]): Promise<{ reply: unknown }> {
    const client = getClient(connStr);
    const reply = await client.call(command, ...args.map((a) => (a == null ? '' : String(a))));
    return { reply };
  },
};
