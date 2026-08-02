/**
 * Hybrid retriever.
 *
 * Grounds the planner in real catalog data instead of dumping every tool into
 * the prompt (which stops scaling the moment the catalog grows past a few
 * hundred rows, and makes the model pick by recency-in-context rather than fit).
 *
 * Pipeline:
 *   1. multi-query — the router expands one goal into several sub-queries
 *      ("record voiceover", "edit video", "make thumbnail")
 *   2. lexical BM25 per sub-query over a field-weighted index
 *   2b. dense (semantic) search per sub-query against Qdrant, when configured —
 *       catches paraphrases BM25 misses ("make my voice sound better" with no
 *       literal "audio"/"voice" match in a tool's indexed fields). A no-op,
 *       pure-BM25 fallback when Qdrant isn't configured/reachable.
 *   3. Reciprocal Rank Fusion to merge every ranked list (lexical + dense)
 *   4. structured boosts (category intent, pricing constraint, quality prior)
 *   5. per-category diversification so one crowded category can't fill the slate
 */

import { getCatalog, bm25, tokenize, toCandidateCard } from './catalog.js';
import { searchTools, isVectorStoreConfigured } from './vectorStore.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('ai:retriever');

/** RRF constant — dampens the influence of any single ranker's top hit. */
const RRF_K = 60;

/** Max tools from any one category in the final candidate slate. */
const MAX_PER_CATEGORY = 6;

function rank(scoreMap) {
  return [...scoreMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([docIndex]) => docIndex);
}

/**
 * @param {object} opts
 * @param {string[]} opts.queries        sub-queries to fuse (1..n)
 * @param {string[]} [opts.categories]   category slugs the router inferred
 * @param {'free'|'freemium'|'paid'|'any'} [opts.pricing]
 * @param {number} [opts.limit]
 * @returns {Promise<{candidates: object[], cards: object[], corpusSize: number}>}
 */
export async function retrieve({
  queries = [],
  categories = [],
  pricing = 'any',
  limit = 32,
} = {}) {
  const catalog = await getCatalog();
  if (!catalog.tools.length) return { candidates: [], cards: [], corpusSize: 0 };

  const cleanQueries = queries.map(q => String(q || '').trim()).filter(Boolean);
  if (!cleanQueries.length) cleanQueries.push('');

  // ── 1+2. BM25 per sub-query ────────────────────────────────
  const rankedLists = cleanQueries
    .map(q => tokenize(q))
    .filter(tokens => tokens.length)
    .map(tokens => rank(bm25(tokens, catalog)));

  // ── 2b. Dense per sub-query, fused into the same RRF as BM25 ──
  if (isVectorStoreConfigured()) {
    const slugIndex = new Map(catalog.tools.map((t, i) => [t.slug, i]));
    const denseResults = await Promise.all(cleanQueries.map(q => searchTools(q, limit)));
    for (const hits of denseResults) {
      const docIndices = hits.map(h => slugIndex.get(h.slug)).filter(i => i !== undefined);
      if (docIndices.length) rankedLists.push(docIndices);
    }
  }

  // ── 3. Reciprocal Rank Fusion ──────────────────────────────
  const fused = new Map();
  for (const list of rankedLists) {
    list.forEach((docIndex, position) => {
      fused.set(docIndex, (fused.get(docIndex) || 0) + 1 / (RRF_K + position + 1));
    });
  }

  // Cold start (no lexical hits at all): fall back to the quality prior so we
  // always return something usable rather than an empty slate.
  if (fused.size === 0) {
    catalog.tools.forEach((_, i) => fused.set(i, 0.0001));
  }

  const wantedCategories = new Set(categories.filter(Boolean));

  // ── 4. Structured boosts ───────────────────────────────────
  const scored = [];
  for (const [docIndex, rrfScore] of fused) {
    const tool = catalog.tools[docIndex];
    if (!tool) continue;

    let score = rrfScore;

    // The router's inferred categories are a strong signal about which part of
    // the catalog the goal lives in.
    if (wantedCategories.has(tool.category)) score *= 2.2;

    // Pricing constraint: demote rather than filter, so a paid tool that is
    // genuinely the only option for a stage can still surface.
    if (pricing === 'free') {
      if (tool.pricing === 'free') score *= 1.6;
      else if (tool.pricing === 'freemium') score *= 1.25;
      else score *= 0.35;
    } else if (pricing === 'paid') {
      if (tool.pricing === 'paid') score *= 1.35;
    }

    // Quality prior — ratings and adoption, log-damped so a mega-popular tool
    // can't dominate purely on volume.
    const ratingBoost = 1 + ((tool.rating || 0) / 5) * 0.3;
    const popularityBoost = 1 + Math.log10(1 + (tool.views || 0)) * 0.04;
    const verifiedBoost = tool.isVerified ? 1.08 : 1;

    score *= ratingBoost * popularityBoost * verifiedBoost;

    scored.push({ tool, score });
  }

  scored.sort((a, b) => b.score - a.score);

  // ── 5. Category diversification ────────────────────────────
  // A workflow spans stages, so the slate needs breadth. Take tools in score
  // order but cap each category, then backfill with whatever is left.
  const perCategory = new Map();
  const primary = [];
  const overflow = [];

  for (const entry of scored) {
    const cat = entry.tool.category;
    const used = perCategory.get(cat) || 0;
    if (used < MAX_PER_CATEGORY) {
      perCategory.set(cat, used + 1);
      primary.push(entry);
    } else {
      overflow.push(entry);
    }
    if (primary.length >= limit) break;
  }

  const selected = [...primary, ...overflow].slice(0, limit);

  log.debug('Retrieved candidates', {
    queries: cleanQueries.length,
    corpus: catalog.tools.length,
    returned: selected.length,
    categories: [...new Set(selected.map(s => s.tool.category))].join(','),
  });

  return {
    candidates: selected.map(s => s.tool),
    cards: selected.map(s => toCandidateCard(s.tool)),
    corpusSize: catalog.tools.length,
  };
}

/** Direct lexical lookup used for grounded Q&A ("what is the best X"). */
export async function search(query, { limit = 8, pricing = 'any' } = {}) {
  const { candidates } = await retrieve({ queries: [query], pricing, limit });
  return candidates;
}

export default { retrieve, search };
