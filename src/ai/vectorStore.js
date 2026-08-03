/**
 * Qdrant vector store — the tool catalog's semantic-search leg and long-term
 * semantic memory recall.
 *
 * Optional infrastructure, same philosophy as the LLM provider chain and
 * embeddings.js: no QDRANT_URL means every function here is a safe no-op
 * (returns null/[]), so the rest of the app — BM25 retrieval, the rolling
 * conversation summary — works exactly as before with nothing configured.
 *
 * Two collections:
 *   `tools`         — one point per catalog tool, kept in sync with Mongo via
 *                      the same EVENTS.TOOL_CHANGED bus catalog.js uses for
 *                      its own BM25 index invalidation.
 *   `memory_facts`   — one point per (user, session): the current rolling
 *                      conversation summary, re-embedded and overwritten each
 *                      time memory.js compacts that session. Lets a *new*
 *                      session recall the gist of an old one by similarity.
 */

import crypto from 'crypto';
import config from '../config/index.js';
import { embed, warmupEmbeddings, isEmbeddingModelReady, embeddingModelLabel } from './embeddings.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('ai:vectorStore');

const TOOLS_COLLECTION = 'tools';
const MEMORY_COLLECTION = 'memory_facts';

/** Parallel upserts × ONNX inference can OOM small Railway instances. */
const UPSERT_CONCURRENCY = 3;

export const isVectorStoreConfigured = () => Boolean(config.vector.url);

let client = null;
/** null = never tried, Promise<true> = ok, rejected = last attempt failed */
let ensurePromise = null;
let lastEnsureError = null;

/** Log-safe Qdrant endpoint (hostname + port only). */
export function redactQdrantUrl(url = config.vector.url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}`;
  } catch {
    return '(invalid QDRANT_URL)';
  }
}

/** Deferred import so @qdrant/js-client-rest is never even loaded when the feature is off. */
async function getClientAsync() {
  if (!isVectorStoreConfigured()) return null;
  if (client) return client;

  const { QdrantClient } = await import('@qdrant/js-client-rest');
  client = new QdrantClient({
    url: config.vector.url,
    apiKey: config.vector.apiKey || undefined,
  });
  log.info('Qdrant client created', {
    url: redactQdrantUrl(),
    hasApiKey: Boolean(config.vector.apiKey),
  });
  return client;
}

/** Deterministic UUID-shaped id from a stable string seed (Qdrant point IDs must be int or UUID). */
function pointId(seed) {
  const hex = crypto.createHash('sha1').update(seed).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

async function ensureCollectionsOnce() {
  const qdrant = await getClientAsync();
  const { collections } = await qdrant.getCollections();
  const existing = new Set(collections.map(c => c.name));
  const created = [];

  for (const name of [TOOLS_COLLECTION, MEMORY_COLLECTION]) {
    if (existing.has(name)) continue;
    await qdrant.createCollection(name, {
      vectors: { size: config.vector.dimensions, distance: 'Cosine' },
    });
    created.push(name);
    log.info('Created Qdrant collection', { name, dimensions: config.vector.dimensions });
  }

  if (!created.length) {
    log.debug('Qdrant collections already exist', { existing: [...existing] });
  }

  return true;
}

async function ensureCollections() {
  if (!isVectorStoreConfigured()) return false;

  if (ensurePromise) {
    try {
      return await ensurePromise;
    } catch {
      ensurePromise = null;
    }
  }

  ensurePromise = (async () => {
    try {
      await ensureCollectionsOnce();
      lastEnsureError = null;
      return true;
    } catch (err) {
      lastEnsureError = err.message;
      ensurePromise = null;
      log.error('Qdrant connection failed — check QDRANT_URL and QDRANT_API_KEY on the backend service', {
        url: redactQdrantUrl(),
        error: err.message,
        hint: 'Use http://qdrant.railway.internal:6333 (private), not the public HTTPS URL',
      });
      throw err;
    }
  })();

  return ensurePromise;
}

/** Text projection embedded for a tool — the fields most predictive of "what job does this do." */
function toolText(tool) {
  return [tool.name, tool.tagline, tool.description, (tool.features || []).join(' '), (tool.tags || []).join(' ')]
    .filter(Boolean)
    .join('. ');
}

/** @returns {Promise<boolean>} whether the point was actually written */
export async function upsertTool(tool) {
  if (!(await ensureCollections().catch(() => false))) return false;

  const vector = await embed(toolText(tool));
  if (!vector) return false;

  try {
    const qdrant = await getClientAsync();
    await qdrant.upsert(TOOLS_COLLECTION, {
      wait: false,
      points: [{
        id: pointId(`tool:${tool.slug}`),
        vector,
        payload: { slug: tool.slug, category: tool.category, pricing: tool.pricing, name: tool.name },
      }],
    });
    return true;
  } catch (err) {
    log.warn('Failed to upsert tool embedding', { slug: tool.slug, error: err.message });
    return false;
  }
}

export async function deleteTool(slug) {
  if (!isVectorStoreConfigured()) return;
  try {
    const qdrant = await getClientAsync();
    await qdrant.delete(TOOLS_COLLECTION, { wait: false, points: [pointId(`tool:${slug}`)] });
  } catch (err) {
    log.warn('Failed to delete tool embedding', { slug, error: err.message });
  }
}

/**
 * Sync the full catalog into Qdrant with bounded concurrency and a clear summary.
 * Called on boot and after admin catalog mutations.
 */
export async function syncToolsToVectorStore(tools) {
  if (!isVectorStoreConfigured()) {
    log.info('Vector store skipped — QDRANT_URL is not set on this service');
    return { configured: false, reason: 'QDRANT_URL not set' };
  }

  const started = Date.now();
  log.info('Vector store sync starting', {
    url: redactQdrantUrl(),
    tools: tools.length,
    model: embeddingModelLabel(),
    concurrency: UPSERT_CONCURRENCY,
  });

  const warmup = await warmupEmbeddings();
  if (!warmup.ok) {
    log.error('Vector store sync aborted — embedding model unavailable', warmup);
    return {
      configured: true,
      ok: false,
      reason: 'embedding_model_failed',
      ...warmup,
    };
  }

  try {
    await ensureCollections();
  } catch (err) {
    return {
      configured: true,
      ok: false,
      reason: 'qdrant_unreachable',
      error: err.message,
      url: redactQdrantUrl(),
    };
  }

  let succeeded = 0;
  let embeddingFailed = 0;
  let qdrantFailed = 0;

  for (let i = 0; i < tools.length; i += UPSERT_CONCURRENCY) {
    const batch = tools.slice(i, i + UPSERT_CONCURRENCY);
    const results = await Promise.all(batch.map(async tool => {
      if (!(await ensureCollections().catch(() => false))) return 'qdrant';
      const vector = await embed(toolText(tool));
      if (!vector) return 'embedding';
      try {
        const qdrant = await getClientAsync();
        await qdrant.upsert(TOOLS_COLLECTION, {
          wait: false,
          points: [{
            id: pointId(`tool:${tool.slug}`),
            vector,
            payload: { slug: tool.slug, category: tool.category, pricing: tool.pricing, name: tool.name },
          }],
        });
        return 'ok';
      } catch {
        return 'qdrant';
      }
    }));

    for (const r of results) {
      if (r === 'ok') succeeded++;
      else if (r === 'embedding') embeddingFailed++;
      else qdrantFailed++;
    }

    if ((i + UPSERT_CONCURRENCY) % 15 === 0 || i + UPSERT_CONCURRENCY >= tools.length) {
      log.info('Vector store sync progress', {
        done: Math.min(i + UPSERT_CONCURRENCY, tools.length),
        total: tools.length,
        succeeded,
      });
    }
  }

  const stats = {
    configured: true,
    ok: succeeded === tools.length,
    attempted: tools.length,
    succeeded,
    embeddingFailed,
    qdrantFailed,
    ms: Date.now() - started,
    url: redactQdrantUrl(),
  };

  if (stats.ok) {
    log.info('Vector store sync complete', stats);
  } else {
    log.error('Vector store sync incomplete', {
      ...stats,
      hint: embeddingFailed
        ? 'Embedding model failed — check Railway memory (recommend ≥1GB) and deploy logs'
        : 'Qdrant write failed — verify QDRANT_API_KEY matches the Qdrant service',
    });
  }

  return stats;
}

/**
 * Live diagnostic for /api/health/vector and boot logs.
 */
export async function getVectorStoreHealth() {
  if (!isVectorStoreConfigured()) {
    return {
      configured: false,
      status: 'disabled',
      reason: 'QDRANT_URL is not set on the backend service',
    };
  }

  const health = {
    configured: true,
    url: redactQdrantUrl(),
    hasApiKey: Boolean(config.vector.apiKey),
    embeddingModel: embeddingModelLabel(),
    dimensions: config.vector.dimensions,
    embeddingModelReady: isEmbeddingModelReady(),
    lastConnectionError: lastEnsureError,
    collections: {},
    status: 'unknown',
  };

  try {
    const qdrant = await getClientAsync();
    const { collections } = await qdrant.getCollections();
    const names = collections.map(c => c.name);

    for (const name of [TOOLS_COLLECTION, MEMORY_COLLECTION]) {
      if (!names.includes(name)) {
        health.collections[name] = { exists: false, points: 0 };
        continue;
      }
      const info = await qdrant.getCollection(name);
      health.collections[name] = {
        exists: true,
        points: info.points_count ?? info.vectors_count ?? 0,
      };
    }

    const toolPoints = health.collections[TOOLS_COLLECTION]?.points ?? 0;
    health.status = toolPoints > 0 ? 'healthy' : 'empty';
    health.ok = toolPoints > 0;
  } catch (err) {
    health.status = 'unreachable';
    health.ok = false;
    health.error = err.message;
    lastEnsureError = err.message;
  }

  return health;
}

/**
 * @param {string} query
 * @param {number} [limit]
 * @returns {Promise<Array<{slug:string, score:number}>>} empty if unconfigured/unavailable
 */
export async function searchTools(query, limit = 32) {
  if (!(await ensureCollections().catch(() => false))) return [];

  const vector = await embed(query);
  if (!vector) return [];

  try {
    const qdrant = await getClientAsync();
    const results = await qdrant.search(TOOLS_COLLECTION, { vector, limit, with_payload: true });
    return results.map(r => ({ slug: r.payload?.slug, score: r.score })).filter(r => r.slug);
  } catch (err) {
    log.warn('Qdrant tool search failed', { error: err.message });
    return [];
  }
}

export async function upsertMemoryFact({ userId, sessionId, summary }) {
  if (!(await ensureCollections().catch(() => false)) || !summary) return;

  const vector = await embed(summary);
  if (!vector) return;

  try {
    const qdrant = await getClientAsync();
    await qdrant.upsert(MEMORY_COLLECTION, {
      wait: false,
      points: [{
        id: pointId(`memory:${userId}:${sessionId}`),
        vector,
        payload: { userId: String(userId), sessionId, summary, updatedAt: new Date().toISOString() },
      }],
    });
  } catch (err) {
    log.warn('Failed to upsert memory fact', { userId, sessionId, error: err.message });
  }
}

/**
 * @param {string} query
 * @param {string} userId
 * @param {object} [opts]
 * @param {number} [opts.limit]
 * @param {string} [opts.excludeSessionId] the current session, so recall surfaces *other* sessions
 * @returns {Promise<Array<{sessionId:string, summary:string, score:number}>>}
 */
export async function searchMemoryFacts(query, userId, { limit = 3, excludeSessionId } = {}) {
  if (!(await ensureCollections().catch(() => false))) return [];

  const vector = await embed(query);
  if (!vector) return [];

  try {
    const qdrant = await getClientAsync();
    const results = await qdrant.search(MEMORY_COLLECTION, {
      vector,
      limit: limit + (excludeSessionId ? 1 : 0),
      with_payload: true,
      filter: { must: [{ key: 'userId', match: { value: String(userId) } }] },
    });
    return results
      .map(r => ({ sessionId: r.payload?.sessionId, summary: r.payload?.summary, score: r.score }))
      .filter(r => r.sessionId && r.sessionId !== excludeSessionId)
      .slice(0, limit);
  } catch (err) {
    log.warn('Qdrant memory recall failed', { userId, error: err.message });
    return [];
  }
}

export default {
  isVectorStoreConfigured,
  redactQdrantUrl,
  upsertTool,
  deleteTool,
  syncToolsToVectorStore,
  getVectorStoreHealth,
  searchTools,
  upsertMemoryFact,
  searchMemoryFacts,
};
