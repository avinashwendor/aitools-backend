/**
 * Tool catalog — the retrieval corpus.
 *
 * Keeps a hot, in-process projection of every active tool plus a weighted
 * BM25 index built over it. Refreshed on a TTL and invalidated explicitly
 * whenever an admin mutates a tool, so retrieval never goes stale.
 */

import Tool from '../models/Tool.js';
import { bus, EVENTS } from '../utils/events.js';
import {
  deleteTool,
  isVectorStoreConfigured,
  syncToolsToVectorStore,
  getVectorStoreHealth,
} from './vectorStore.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('ai:catalog');

const REFRESH_MS = 5 * 60 * 1000;

// BM25 tuning: k1 controls term-frequency saturation, b controls length normalisation.
const K1 = 1.4;
const B = 0.72;

/** Field weights — a hit in the name is worth far more than one in the description. */
const FIELD_WEIGHTS = {
  name: 6,
  tags: 4,
  category: 3.5,
  tagline: 3,
  features: 2,
  description: 1,
};

const STOPWORDS = new Set(`a an and are as at be but by for from has have how i if in into is it its of on or
that the to was were what when where which who will with you your want need help me my make create
using use best top good great some any about can do does using via than then them these this those
tool tools ai app apps software platform service online free`.split(/\s+/));

/** Very small suffix stemmer — enough to bridge plural/gerund mismatches. */
function stem(word) {
  if (word.length <= 3) return word;
  return word
    .replace(/(ational|tional)$/, 'ate')
    .replace(/(ization|isation)$/, 'ize')
    .replace(/(iveness|fulness|ousness)$/, '')
    .replace(/(ements|ments|ement|ment)$/, '')
    .replace(/(ingly|edly)$/, '')
    .replace(/(ies)$/, 'y')
    .replace(/(sses)$/, 'ss')
    .replace(/([^s])s$/, '$1')
    .replace(/(ing|ed|er|est)$/, '')
    .replace(/(.)\1$/, '$1');
}

export function tokenize(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s.+#-]/g, ' ')
    .split(/[\s.]+/)
    .map(t => t.replace(/^[-+#]+|[-+#]+$/g, ''))
    .filter(t => t.length > 1 && !STOPWORDS.has(t))
    .map(stem);
}

/** Compact projection handed to the LLM — small enough to fit many candidates. */
export function toCandidateCard(tool) {
  return {
    slug: tool.slug,
    name: tool.name,
    category: tool.category,
    pricing: tool.pricing,
    price: tool.pricingDetails || undefined,
    does: tool.tagline,
    can: (tool.features || []).slice(0, 5),
    tags: (tool.tags || []).slice(0, 6),
    rating: tool.rating,
  };
}

/** Full projection used to hydrate the workflow returned to the client. */
const PROJECTION =
  'name slug tagline description logo screenshot websiteUrl category pricing pricingDetails ' +
  'features tags rating reviewCount views likes isVerified isFeatured';

const state = {
  tools: [],
  bySlug: new Map(),
  index: null,          // term -> [{ docIndex, weightedTf }]
  docLengths: [],
  avgDocLength: 0,
  categories: [],
  loadedAt: 0,
  loading: null,
};

/**
 * Set whenever the catalog is invalidated by a real mutation, cleared once
 * the vector store has been resynced — so a routine TTL refresh with no
 * actual changes doesn't re-embed every tool for nothing.
 */
let needsVectorSync = true;

let vectorSyncInFlight = null;

/** Keeps the Qdrant `tools` collection in step with Mongo (batched upserts + logs). */
async function syncVectorStore(oldTools, newTools) {
  if (!isVectorStoreConfigured()) return { configured: false };

  if (vectorSyncInFlight) return vectorSyncInFlight;

  vectorSyncInFlight = (async () => {
    const oldSlugs = new Set(oldTools.map(t => t.slug));
    const newSlugs = new Set(newTools.map(t => t.slug));
    const removed = [...oldSlugs].filter(slug => !newSlugs.has(slug));

    const stats = await syncToolsToVectorStore(newTools);

    for (const slug of removed) {
      await deleteTool(slug);
    }

    if (removed.length) {
      log.info('Removed stale tool embeddings', { count: removed.length });
    }

    return { ...stats, removed: removed.length };
  })().finally(() => {
    vectorSyncInFlight = null;
  });

  return vectorSyncInFlight;
}

/**
 * Awaited on server boot — populates Qdrant after catalog load with a timeout.
 * @param {{ timeoutMs?: number }} [opts]
 */
export async function warmVectorIndex({ timeoutMs = 180_000, force = false } = {}) {
  if (!isVectorStoreConfigured()) {
    log.info('Vector store disabled — set QDRANT_URL on the backend to enable semantic search');
    return { configured: false, reason: 'QDRANT_URL not set' };
  }

  const catalog = await getCatalog();

  if (!force && catalog.tools.length > 0) {
    const health = await getVectorStoreHealth();
    const toolPoints = health.collections?.tools?.points ?? 0;
    if (toolPoints >= catalog.tools.length) {
      needsVectorSync = false;
      log.info('Vector store already populated — skipping boot sync', {
        toolPoints,
        tools: catalog.tools.length,
        url: health.url,
      });
      return {
        configured: true,
        ok: true,
        skipped: true,
        toolPoints,
        attempted: catalog.tools.length,
        succeeded: toolPoints,
      };
    }
  }

  needsVectorSync = true;

  const syncPromise = (async () => {
    needsVectorSync = false;
    return syncVectorStore([], catalog.tools);
  })();

  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Vector sync timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    return await Promise.race([syncPromise, timeout]);
  } catch (err) {
    needsVectorSync = true;
    log.error('Vector store warmup failed', { error: err.message });
    const health = await getVectorStoreHealth();
    return { configured: true, ok: false, error: err.message, health };
  }
}

export { getVectorStoreHealth };

function buildIndex(tools) {
  const index = new Map();
  const docLengths = new Array(tools.length).fill(0);

  tools.forEach((tool, docIndex) => {
    /** term -> weighted term frequency */
    const termWeights = new Map();
    let length = 0;

    const addField = (value, weight) => {
      const tokens = tokenize(Array.isArray(value) ? value.join(' ') : value);
      length += tokens.length;
      for (const term of tokens) {
        termWeights.set(term, (termWeights.get(term) || 0) + weight);
      }
    };

    addField(tool.name, FIELD_WEIGHTS.name);
    addField(tool.tags, FIELD_WEIGHTS.tags);
    addField(tool.category, FIELD_WEIGHTS.category);
    addField(tool.tagline, FIELD_WEIGHTS.tagline);
    addField(tool.features, FIELD_WEIGHTS.features);
    addField(tool.description, FIELD_WEIGHTS.description);

    docLengths[docIndex] = Math.max(length, 1);

    for (const [term, weightedTf] of termWeights) {
      if (!index.has(term)) index.set(term, []);
      index.get(term).push({ docIndex, weightedTf });
    }
  });

  const avgDocLength = docLengths.reduce((a, b) => a + b, 0) / (docLengths.length || 1);
  return { index, docLengths, avgDocLength };
}

async function load() {
  const tools = await Tool.find({ isActive: true }).select(PROJECTION).lean();
  const previousTools = state.tools;

  const { index, docLengths, avgDocLength } = buildIndex(tools);

  state.tools = tools;
  state.bySlug = new Map(tools.map(t => [t.slug, t]));
  state.index = index;
  state.docLengths = docLengths;
  state.avgDocLength = avgDocLength;
  state.categories = [...new Set(tools.map(t => t.category))].sort();
  state.loadedAt = Date.now();

  log.info('Catalog indexed', {
    tools: tools.length,
    terms: index.size,
    categories: state.categories.length,
  });

  if (needsVectorSync) {
    needsVectorSync = false;
    syncVectorStore(previousTools, tools).catch(err => {
      log.warn('Vector store sync failed', { error: err.message });
      needsVectorSync = true; // retry on the next reload
    });
  }

  return state;
}

/** Returns the loaded catalog, refreshing it if the TTL has elapsed. */
export async function getCatalog({ force = false } = {}) {
  const stale = Date.now() - state.loadedAt > REFRESH_MS;
  if (!force && state.index && !stale) return state;

  // Collapse concurrent refreshes into a single query.
  if (!state.loading) {
    state.loading = load().finally(() => { state.loading = null; });
  }
  await state.loading;
  return state;
}

/** Marks the index stale so the next retrieval rebuilds from the database. */
export function invalidateCatalog() {
  state.loadedAt = 0;
  needsVectorSync = true;
  log.debug('Catalog invalidated');
}

// Any admin write to the Tool collection refreshes retrieval on the next call.
bus.on(EVENTS.TOOL_CHANGED, invalidateCatalog);

/**
 * BM25 scoring for a single query string.
 * @returns {Map<number, number>} docIndex -> score
 */
export function bm25(queryTokens, catalog) {
  const scores = new Map();
  const N = catalog.tools.length;
  if (!N) return scores;

  for (const term of queryTokens) {
    const postings = catalog.index.get(term);
    if (!postings) continue;

    const df = postings.length;
    // Standard BM25 IDF, floored so very common terms can't go negative.
    const idf = Math.max(0.05, Math.log(1 + (N - df + 0.5) / (df + 0.5)));

    for (const { docIndex, weightedTf } of postings) {
      const norm = 1 - B + B * (catalog.docLengths[docIndex] / catalog.avgDocLength);
      const score = idf * ((weightedTf * (K1 + 1)) / (weightedTf + K1 * norm));
      scores.set(docIndex, (scores.get(docIndex) || 0) + score);
    }
  }

  return scores;
}

export const getToolBySlug = slug => state.bySlug.get(slug);
export const getCategories = () => state.categories;

export default { getCatalog, invalidateCatalog, bm25, tokenize, toCandidateCard, getToolBySlug };
