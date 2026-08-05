/**
 * Natural-language catalog search — the "ask AI" leg of /browse.
 *
 * The grid's normal search is a Mongo regex: it can only return a tool whose
 * text literally contains what was typed. That is the right instrument for
 * "notion" and useless for "something that turns my podcast into short clips",
 * which is precisely the query a visitor types when they *don't* already know
 * the product's name — the case where discovery is worth anything at all.
 *
 * This answers the second kind of question from vectors we already store: the
 * same hybrid retriever the workflow planner uses (BM25 + Qdrant dense search,
 * fused with Reciprocal Rank Fusion). One embedding call per query and no LLM
 * turn, so it charges no credits and is protected by a rate limit instead of
 * the entitlement gate. When Qdrant isn't configured it degrades to pure BM25
 * and says so in the response, rather than pretending to have understood.
 */

import { retrieve } from './retriever.js';
import { getCatalog, tokenize } from './catalog.js';
import { isVectorStoreConfigured } from './vectorStore.js';

/**
 * Pricing words carry a hard constraint the ranker should know about, and
 * they're the one part of a natural-language query that is reliably literal —
 * nobody writes "free" meaning "expensive". Everything else is left to
 * retrieval, which is better at meaning than a regex is.
 */
const PRICING_HINTS = [
  [/\b(free|no cost|zero cost|without paying|no credit card)\b/i, 'free'],
  [/\b(paid|premium|enterprise|pro plan|budget of|willing to pay)\b/i, 'paid'],
];

/**
 * Words that name a category without using its slug. Kept deliberately small:
 * a wrong category guess is worse than none, because the retriever multiplies
 * matching-category scores by 2.2 and would bury the right answer.
 */
const CATEGORY_SYNONYMS = {
  writing: ['copywriting', 'copy', 'blog', 'essay', 'content writing', 'ghostwriting'],
  image: ['photo', 'photos', 'picture', 'pictures', 'logo', 'illustration', 'thumbnail'],
  video: ['videos', 'film', 'footage', 'reels', 'shorts', 'youtube', 'clips'],
  audio: ['voice', 'voiceover', 'music', 'podcast', 'sound', 'speech', 'dubbing'],
  coding: ['code', 'developer', 'programming', 'debug', 'ide', 'devtool'],
  productivity: ['notes', 'todo', 'meeting', 'scheduling', 'automation', 'inbox'],
  marketing: ['seo', 'ads', 'advertising', 'campaign', 'social media', 'email marketing'],
  research: ['papers', 'literature', 'citations', 'analysis', 'data analysis'],
  design: ['ui', 'ux', 'figma', 'mockup', 'branding', 'presentation'],
  business: ['sales', 'crm', 'invoice', 'finance', 'legal', 'hr', 'recruiting'],
  education: ['learning', 'study', 'course', 'teaching', 'tutor', 'homework'],
};

/** Split a compound ask into the separate jobs it actually contains. */
const CONJUNCTION = /\s*(?:,|\band then\b|\bthen\b|\band also\b|\band\b|\bplus\b|\/)\s*/i;

/** Ceiling on sub-queries — each one is an embedding call and an RRF list. */
const MAX_SUBQUERIES = 3;

/**
 * Read the constraints hiding in a sentence: what it should cost, which shelf
 * it lives on, and which distinct jobs it names.
 *
 * @param {string} query
 * @param {string[]} categories catalog categories, from the loaded index
 */
export function parseIntent(query, categories = []) {
  const text = String(query || '').trim();

  let pricing = 'any';
  for (const [pattern, value] of PRICING_HINTS) {
    if (pattern.test(text)) {
      pricing = value;
      break;
    }
  }

  const lower = text.toLowerCase();
  const matchedCategories = categories.filter(category => {
    if (new RegExp(`\\b${category}\\b`, 'i').test(lower)) return true;
    return (CATEGORY_SYNONYMS[category] || []).some(word =>
      new RegExp(`\\b${word}\\b`, 'i').test(lower)
    );
  });

  // The whole sentence always leads: it carries context that the fragments
  // lose ("clips for instagram" splits into two much weaker halves). The
  // fragments follow as extra evidence, never as replacements.
  const parts = text
    .split(CONJUNCTION)
    .map(part => part.trim())
    .filter(part => tokenize(part).length >= 2);

  const queries = [text, ...parts.filter(part => part.toLowerCase() !== lower)]
    .slice(0, MAX_SUBQUERIES);

  return { pricing, categories: matchedCategories, queries };
}

/**
 * Why this tool came back, in the tool's own words.
 *
 * Never invented: it's the tool's real tags and features, filtered to the ones
 * the query actually touched. When nothing overlaps literally — which is the
 * normal case for a dense hit, and the whole point of having embeddings — we
 * say so rather than manufacturing a rationale.
 *
 * @returns {{on: string[], via: 'keyword'|'meaning'}}
 */
function explainMatch(tool, queryTokens) {
  const wanted = new Set(queryTokens);
  const seen = new Set();
  const on = [];

  for (const phrase of [...(tool.tags || []), ...(tool.features || [])]) {
    const label = String(phrase || '').trim();
    if (!label || seen.has(label.toLowerCase())) continue;
    if (!tokenize(label).some(token => wanted.has(token))) continue;
    seen.add(label.toLowerCase());
    on.push(label);
    if (on.length === 3) break;
  }

  return { on, via: on.length ? 'keyword' : 'meaning' };
}

/**
 * @param {string} query
 * @param {object} [opts]
 * @param {number} [opts.limit]
 * @param {'all'|'free'|'freemium'|'paid'} [opts.pricing] the filter bar's own
 *   pricing choice, which outranks anything inferred from the sentence — an
 *   explicit control the user set beats a guess made from their prose.
 * @param {string} [opts.category] the filter bar's category, same precedence.
 * @returns {Promise<{results: object[], intent: object, mode: 'semantic'|'lexical', corpusSize: number}>}
 */
export async function searchCatalogByMeaning(query, { limit = 24, pricing, category } = {}) {
  const catalog = await getCatalog();
  const intent = parseIntent(query, catalog.categories);

  const effectivePricing = pricing && pricing !== 'all' ? pricing : intent.pricing;
  const effectiveCategories =
    category && category !== 'all' ? [category] : intent.categories;

  const { candidates, scores, dense, corpusSize } = await retrieve({
    queries: intent.queries,
    categories: effectiveCategories,
    pricing: effectivePricing,
    limit,
  });

  const queryTokens = new Set(intent.queries.flatMap(part => tokenize(part)));
  const top = scores[0] || 1;

  const results = candidates.map((tool, index) => ({
    ...tool,
    match: {
      // Relative to the best hit in *this* answer, which is the only claim the
      // number can honestly support. It is a ranking signal, not a probability.
      relevance: Math.round(Math.min(1, (scores[index] || 0) / top) * 100),
      rank: index + 1,
      ...explainMatch(tool, queryTokens),
    },
  }));

  return {
    results,
    intent: {
      pricing: effectivePricing,
      categories: effectiveCategories,
      queries: intent.queries,
    },
    mode: dense ? 'semantic' : 'lexical',
    vectorSearchAvailable: isVectorStoreConfigured(),
    corpusSize,
  };
}

export default { searchCatalogByMeaning, parseIntent };
