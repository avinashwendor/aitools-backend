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
import { embed } from './embeddings.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('ai:vectorStore');

const TOOLS_COLLECTION = 'tools';
const MEMORY_COLLECTION = 'memory_facts';

export const isVectorStoreConfigured = () => Boolean(config.vector.url);

let client = null;
let ensured = null;

/** Deferred import so @qdrant/js-client-rest is never even loaded when the feature is off. */
async function getClientAsync() {
  if (!isVectorStoreConfigured()) return null;
  if (client) return client;

  const { QdrantClient } = await import('@qdrant/js-client-rest');
  client = new QdrantClient({
    url: config.vector.url,
    apiKey: config.vector.apiKey || undefined,
  });
  return client;
}

/** Deterministic UUID-shaped id from a stable string seed (Qdrant point IDs must be int or UUID). */
function pointId(seed) {
  const hex = crypto.createHash('sha1').update(seed).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

async function ensureCollections() {
  if (!isVectorStoreConfigured()) return false;
  if (ensured) return ensured;

  ensured = (async () => {
    try {
      const qdrant = await getClientAsync();
      const { collections } = await qdrant.getCollections();
      const existing = new Set(collections.map(c => c.name));

      for (const name of [TOOLS_COLLECTION, MEMORY_COLLECTION]) {
        if (existing.has(name)) continue;
        await qdrant.createCollection(name, {
          vectors: { size: config.vector.dimensions, distance: 'Cosine' },
        });
        log.info('Created Qdrant collection', { name });
      }
      return true;
    } catch (err) {
      log.warn('Qdrant unavailable — semantic search disabled for this run', { error: err.message });
      return false;
    }
  })();

  return ensured;
}

/** Text projection embedded for a tool — the fields most predictive of "what job does this do." */
function toolText(tool) {
  return [tool.name, tool.tagline, tool.description, (tool.features || []).join(' '), (tool.tags || []).join(' ')]
    .filter(Boolean)
    .join('. ');
}

/** @returns {Promise<boolean>} whether the point was actually written */
export async function upsertTool(tool) {
  if (!(await ensureCollections())) return false;

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
 * @param {string} query
 * @param {number} [limit]
 * @returns {Promise<Array<{slug:string, score:number}>>} empty if unconfigured/unavailable
 */
export async function searchTools(query, limit = 32) {
  if (!(await ensureCollections())) return [];

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
  if (!(await ensureCollections()) || !summary) return;

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
  if (!(await ensureCollections())) return [];

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
  upsertTool,
  deleteTool,
  searchTools,
  upsertMemoryFact,
  searchMemoryFacts,
};
