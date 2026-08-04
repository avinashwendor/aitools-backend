/**
 * Shared Redis client.
 *
 * Backs the AI cache, telemetry counters and the rate limiter so that state
 * survives restarts and stays consistent across horizontally-scaled Railway
 * instances — the previous in-process `Map`s in each of those modules reset
 * on every deploy and didn't agree with each other once scaled past one
 * instance.
 *
 * When `REDIS_URL` isn't set (local dev, tests), calls fall back to an
 * in-process store that implements the same small command surface used
 * elsewhere in this codebase, so `cache.js` / `telemetry.js` / `rateLimit.js`
 * never need to branch on which backend is active.
 */

import Redis from 'ioredis';
import { createLogger } from './logger.js';

const log = createLogger('redis');

/** In-process fallback implementing only the commands this app actually uses. */
function createMemoryStore() {
  const kv = new Map(); // key -> { value, expiresAt: ms|null }
  const hashes = new Map(); // key -> Map(field -> value)
  const lists = new Map(); // key -> array
  const sets = new Map(); // key -> Set

  const isExpired = entry => entry.expiresAt !== null && entry.expiresAt <= Date.now();

  const store = {
    isMemoryFallback: true,

    async get(key) {
      const e = kv.get(key);
      if (!e || isExpired(e)) { kv.delete(key); return null; }
      return e.value;
    },

    /** Mirrors ioredis's `set(key, value, 'EX', seconds)` signature. */
    async set(key, value, ...args) {
      let ttlMs = null;
      const exIdx = args.findIndex(a => typeof a === 'string' && a.toUpperCase() === 'EX');
      if (exIdx !== -1) ttlMs = Number(args[exIdx + 1]) * 1000;
      kv.set(key, { value, expiresAt: ttlMs ? Date.now() + ttlMs : null });
      return 'OK';
    },

    async del(key) {
      kv.delete(key);
      hashes.delete(key);
      lists.delete(key);
      sets.delete(key);
      return 1;
    },

    async incr(key) {
      return store.incrby(key, 1);
    },

    async incrby(key, by = 1) {
      const e = kv.get(key);
      const current = e && !isExpired(e) ? Number(e.value) : 0;
      const next = current + Number(by);
      kv.set(key, { value: String(next), expiresAt: e && !isExpired(e) ? e.expiresAt : null });
      return next;
    },

    /** Mirrors `PEXPIRE key ms [NX]` — NX only sets a TTL if none exists yet. */
    async pexpire(key, ms, flag) {
      const e = kv.get(key);
      if (!e) return 0;
      if (flag === 'NX' && e.expiresAt !== null) return 0;
      e.expiresAt = Date.now() + ms;
      return 1;
    },

    async ttl(key) {
      const e = kv.get(key);
      if (!e || isExpired(e)) return -2;
      if (e.expiresAt === null) return -1;
      return Math.max(0, Math.round((e.expiresAt - Date.now()) / 1000));
    },

    async hincrby(key, field, by = 1) {
      const h = hashes.get(key) || new Map();
      const next = (Number(h.get(field)) || 0) + by;
      h.set(field, next);
      hashes.set(key, h);
      return next;
    },

    async hgetall(key) {
      const h = hashes.get(key);
      return h ? Object.fromEntries(h) : {};
    },

    async rpush(key, value) {
      const l = lists.get(key) || [];
      l.push(value);
      lists.set(key, l);
      return l.length;
    },

    /** Negative indices count from the end, matching Redis LTRIM semantics. */
    async ltrim(key, start, stop) {
      const l = lists.get(key);
      if (!l) return 'OK';
      lists.set(key, l.slice(start, stop === -1 ? undefined : stop + 1));
      return 'OK';
    },

    async lrange(key, start, stop) {
      const l = lists.get(key) || [];
      return l.slice(start, stop === -1 ? undefined : stop + 1);
    },

    async sadd(key, member) {
      const s = sets.get(key) || new Set();
      const before = s.size;
      s.add(member);
      sets.set(key, s);
      return s.size > before ? 1 : 0;
    },

    async smembers(key) {
      return [...(sets.get(key) || [])];
    },

    /** Only supports a trailing-`*` prefix pattern — the only form used here. */
    async keys(pattern) {
      const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
      return [...kv.keys()].filter(k => k.startsWith(prefix));
    },

    multi() {
      const ops = [];
      const chain = {
        incr(key) { ops.push(['incr', key]); return chain; },
        pexpire(key, ms, flag) { ops.push(['pexpire', key, ms, flag]); return chain; },
        async exec() {
          const results = [];
          for (const [cmd, ...args] of ops) results.push([null, await store[cmd](...args)]);
          return results;
        },
      };
      return chain;
    },
  };

  return store;
}

let client = null;
let memory = null;

export const isRedisConfigured = () => Boolean(process.env.REDIS_URL);

/** Lazily creates and returns the shared client — real Redis or the fallback. */
export function getRedis() {
  if (client || memory) return client || memory;

  if (!isRedisConfigured()) {
    log.warn(
      'REDIS_URL not set — cache/telemetry/rate-limit are using an in-process fallback. ' +
      'Fine for local dev, not safe for a multi-instance production deploy.'
    );
    memory = createMemoryStore();
    return memory;
  }

  client = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2 });
  client.on('error', err => log.error('Redis connection error', { error: err.message }));
  client.on('connect', () => log.info('Redis connected'));
  return client;
}

export default { getRedis, isRedisConfigured };
