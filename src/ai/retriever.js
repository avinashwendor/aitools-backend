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
 *   4. structured boosts (category intent, pricing constraint, quality prior,
 *      and the user's own history — see `signals`)
 *   5. per-category diversification so one crowded category can't fill the slate
 *   6. guaranteed inclusion of tools the user explicitly prefers
 */

import { getCatalog, bm25, tokenize, toCandidateCard } from './catalog.js';
import { searchTools, isVectorStoreConfigured } from './vectorStore.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('ai:retriever');

/** RRF constant — dampens the influence of any single ranker's top hit. */
const RRF_K = 60;

/** Max tools from any one category in the final candidate slate. */
const MAX_PER_CATEGORY = 6;

/**
 * Personalization multipliers, applied alongside the pricing and category
 * boosts. Same philosophy as pricing: demote, never filter. A tool the user
 * rejected may still be the only candidate that can do a given stage, and a
 * workflow with a hole in it is worse than one containing a tool they'll swap.
 */
const SIGNAL_BOOSTS = {
  preferred: 1.5,
  owned: 1.2,
  rejected: 0.15,
};

/**
 * Cap on how many preferred tools may be force-included past the ranking.
 * Without a cap, a user with 30 preferred tools would crowd out retrieval
 * entirely and every workflow would collapse onto their existing stack.
 */
const MAX_FORCED_PREFERRED = 4;

const EMPTY_SIGNALS = { preferred: [], rejected: [], owned: [] };

/**
 * Resolve profile signal values to real catalog slugs.
 *
 * `preferredTools`/`rejectedTools` are written from `stage.toolSlug`, so
 * they're already slugs. `toolsAlreadyUsing` is written from free-text LLM
 * extraction ("Notion", "ChatGPT") with no catalog awareness, so a value that
 * actually names a catalog tool by its display name — case, spacing and all —
 * would otherwise never match `tool.slug` and the owned-tool boost below
 * would silently never fire. A value that names a tool genuinely outside the
 * catalog just resolves to nothing here, which is correct: there's no slug to
 * boost.
 */
function resolveToSlugs(values, catalog) {
  if (!values?.length) return [];

  const bySlug = new Set(catalog.tools.map(t => t.slug));
  const byName = new Map(catalog.tools.map(t => [t.name.toLowerCase(), t.slug]));

  const out = [];
  for (const raw of values) {
    const value = String(raw || '').trim();
    if (!value) continue;

    if (bySlug.has(value)) { out.push(value); continue; }

    const slugLike = value.toLowerCase().replace(/[\s_]+/g, '-');
    if (bySlug.has(slugLike)) { out.push(slugLike); continue; }

    const byNameMatch = byName.get(value.toLowerCase());
    if (byNameMatch) out.push(byNameMatch);
  }
  return out;
}

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
 * @param {{preferred?:string[],rejected?:string[],owned?:string[]}} [opts.signals]
 *   the user's own history, from `personalization.retrievalSignals`
 * @returns {Promise<{candidates: object[], cards: object[], scores: number[],
 *   dense: boolean, corpusSize: number}>}
 *   `scores` is parallel to `candidates` — the fused, boosted score, only
 *   meaningful *relative to the other scores in the same call*. `dense` says
 *   whether the vector leg actually contributed, which is the difference
 *   between "we understood the question" and "we matched some words".
 */
export async function retrieve({
  queries = [],
  categories = [],
  pricing = 'any',
  limit = 32,
  signals = EMPTY_SIGNALS,
} = {}) {
  const catalog = await getCatalog();
  if (!catalog.tools.length) {
    return { candidates: [], cards: [], scores: [], dense: false, corpusSize: 0 };
  }

  const cleanQueries = queries.map(q => String(q || '').trim()).filter(Boolean);
  if (!cleanQueries.length) cleanQueries.push('');

  // ── 1+2. BM25 per sub-query ────────────────────────────────
  const rankedLists = cleanQueries
    .map(q => tokenize(q))
    .filter(tokens => tokens.length)
    .map(tokens => rank(bm25(tokens, catalog)));

  // ── 2b. Dense per sub-query, fused into the same RRF as BM25 ──
  let dense = false;
  if (isVectorStoreConfigured()) {
    const slugIndex = new Map(catalog.tools.map((t, i) => [t.slug, i]));
    const denseResults = await Promise.all(cleanQueries.map(q => searchTools(q, limit)));
    for (const hits of denseResults) {
      const docIndices = hits.map(h => slugIndex.get(h.slug)).filter(i => i !== undefined);
      if (docIndices.length) {
        rankedLists.push(docIndices);
        dense = true;
      }
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

  const preferredSet = new Set(resolveToSlugs(signals?.preferred, catalog));
  const rejectedSet = new Set(resolveToSlugs(signals?.rejected, catalog));
  const ownedSet = new Set(resolveToSlugs(signals?.owned, catalog));

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

    // The user's own history. Applied after the pricing constraint so an
    // explicit rejection still suppresses a tool that pricing just boosted.
    if (rejectedSet.has(tool.slug)) score *= SIGNAL_BOOSTS.rejected;
    else if (preferredSet.has(tool.slug)) score *= SIGNAL_BOOSTS.preferred;
    else if (ownedSet.has(tool.slug)) score *= SIGNAL_BOOSTS.owned;

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

  // ── 6. Guaranteed inclusion of preferred tools ─────────────
  // A ×1.5 boost is useless if the tool still lands at rank 40 of a 32-slot
  // slate: the planner can only pick what it is shown, so "prefer these tools"
  // in the prompt is unactionable unless they are actually in the list. Swap
  // the weakest non-preferred entries out rather than growing the slate, so
  // the prompt budget stays fixed.
  const forced = [];
  if (preferredSet.size) {
    const selectedSlugs = new Set(selected.map(s => s.tool.slug));
    for (const entry of scored) {
      if (forced.length >= MAX_FORCED_PREFERRED) break;
      if (!preferredSet.has(entry.tool.slug)) continue;
      if (selectedSlugs.has(entry.tool.slug)) continue;
      forced.push(entry);
    }

    for (const entry of forced) {
      // Drop from the tail, which is the lowest-scoring non-preferred entry.
      const dropIndex = selected.findLastIndex(s => !preferredSet.has(s.tool.slug));
      if (dropIndex === -1) break;
      selected.splice(dropIndex, 1);
      selected.push(entry);
    }
  }

  log.debug('Retrieved candidates', {
    queries: cleanQueries.length,
    corpus: catalog.tools.length,
    returned: selected.length,
    forcedPreferred: forced.length,
    demotedRejected: rejectedSet.size,
    categories: [...new Set(selected.map(s => s.tool.category))].join(','),
  });

  return {
    candidates: selected.map(s => s.tool),
    cards: selected.map(s => toCandidateCard(s.tool)),
    scores: selected.map(s => s.score),
    dense,
    corpusSize: catalog.tools.length,
  };
}

/** Direct lexical lookup used for grounded Q&A ("what is the best X"). */
export async function search(query, { limit = 8, pricing = 'any' } = {}) {
  const { candidates } = await retrieve({ queries: [query], pricing, limit });
  return candidates;
}

export default { retrieve, search };
