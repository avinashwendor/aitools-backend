/**
 * TTL cache for AI results, backed by Redis (see `utils/redis.js`).
 *
 * Two identical goals ("make a youtube video", "Make A YouTube Video!") should
 * cost one model call, not two. Keys are normalised so trivial phrasing
 * differences collapse, and entries are versioned by catalog size so a newly
 * seeded tool invalidates stale plans.
 *
 * Backed by Redis rather than an in-process Map so cache hits (and hit/miss
 * stats) are shared across every Railway instance and survive a redeploy —
 * previously each instance had its own cold cache, and every deploy wiped it.
 * Entry-count capping is left to the TTL plus Redis's own memory policy
 * instead of manual LRU bookkeeping, which only made sense for a bounded
 * in-process Map.
 */

import crypto from 'crypto';
import config from '../config/index.js';
import { getRedis } from '../utils/redis.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('ai:cache');

const NS = 'cache';
const HITS_KEY = `${NS}:stats:hits`;
const MISSES_KEY = `${NS}:stats:misses`;

/** Normalise a natural-language key so near-identical goals share an entry. */
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(please|can you|could you|i want to|i want|i need to|i need|help me|for me|a|an|the)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function makeKey(namespace, parts) {
  const payload = Array.isArray(parts) ? parts : [parts];
  const normalised = payload
    .map(p => (typeof p === 'string' ? normalize(p) : JSON.stringify(p ?? null)))
    .join('|');
  const hash = crypto.createHash('sha256').update(normalised).digest('hex').slice(0, 32);
  return `${namespace}:${hash}`;
}

export async function get(key) {
  const redis = getRedis();
  const raw = await redis.get(`${NS}:${key}`);

  if (raw === null || raw === undefined) {
    redis.incr(MISSES_KEY).catch(() => {});
    return null;
  }

  redis.incr(HITS_KEY).catch(() => {});
  log.debug('cache hit', { key });

  try {
    return JSON.parse(raw);
  } catch (err) {
    log.warn('Cached value failed to parse — treating as a miss', { key, error: err.message });
    return null;
  }
}

export async function set(key, value, ttlMs = config.ai.cacheTtlMs) {
  const redis = getRedis();
  const ttlSeconds = Math.max(1, Math.round(ttlMs / 1000));
  await redis.set(`${NS}:${key}`, JSON.stringify(value), 'EX', ttlSeconds);
}

export async function clear() {
  const redis = getRedis();
  const keys = await redis.keys(`${NS}:*`);
  await Promise.all(keys.map(k => redis.del(k)));
  log.debug('cache cleared');
}

export async function getCacheStats() {
  const redis = getRedis();
  const [hitsRaw, missesRaw, keys] = await Promise.all([
    redis.get(HITS_KEY),
    redis.get(MISSES_KEY),
    redis.keys(`${NS}:*`),
  ]);

  const hits = Number(hitsRaw) || 0;
  const misses = Number(missesRaw) || 0;
  const total = hits + misses;
  // The two stats counters themselves are namespaced under `cache:` too.
  const entries = Math.max(0, keys.length - 2);

  return { entries, hits, misses, hitRate: total ? +(hits / total).toFixed(3) : 0 };
}

export default { get, set, clear, makeKey, getCacheStats };
