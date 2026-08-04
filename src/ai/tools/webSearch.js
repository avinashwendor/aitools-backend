/**
 * Tavily — web search and page extraction.
 *
 * Two endpoints, one budget. `/search` answers "what exists about this", and
 * `/extract` answers "what does that page actually say" for pages a plain
 * `fetch` cannot read.
 *
 * Extract is the one that matters for the architect. Modern API documentation
 * is overwhelmingly a JavaScript application — Mintlify, Docusaurus, ReadMe,
 * GitBook — and fetching one of those with an HTTP client returns a shell with
 * a `<div id="root">` and nothing in it. The architect then either invents the
 * endpoint or gives up, both of which are the failure this system exists to
 * remove. Tavily renders the page and hands back the prose, so a doc site that
 * defeats a plain fetch still gets read.
 *
 * Optional infrastructure: no TAVILY_API_KEY means `isWebSearchConfigured()` is
 * false and every call is a safe no-op, same philosophy as the LLM provider
 * chain and Qdrant. Uses `fetch` directly rather than an SDK — the request
 * shape is small and stable, and this keeps the dependency footprint down.
 *
 * Budget-guarded: Tavily prices per credit (basic search 1, advanced search 2,
 * extract 1 per 5 URLs). A monthly counter in Redis stops calls once the
 * configured cap is hit, well short of the account limit, so a burst of traffic
 * degrades to "search unavailable" instead of an unexpected mid-month bill.
 * Results are cached aggressively — an API's documentation does not change hour
 * to hour — so a second architect session on the same service costs nothing.
 */

import config from '../../config/index.js';
import cache from '../cache.js';
import { getRedis } from '../../utils/redis.js';
import { recordSearchUsage } from '../../billing/meterContext.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('ai:websearch');

const SEARCH_URL = 'https://api.tavily.com/search';
const EXTRACT_URL = 'https://api.tavily.com/extract';

export const isWebSearchConfigured = () => Boolean(config.search.tavilyApiKey);

/** Cheap regex gate — no LLM call needed to notice "latest"/"2026"/"what's new" phrasing. */
const FRESHNESS_PATTERN = /\b(latest|newest|new in \d{4}|just released|recently launched|what'?s new|this year|in \d{4})\b/i;
export const wantsFreshInfo = text => FRESHNESS_PATTERN.test(String(text || ''));

function monthKey() {
  const now = new Date();
  return `websearch:credits:${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** @returns {Promise<boolean>} whether a call is still within this month's budget */
async function withinBudget() {
  const redis = getRedis();
  const used = Number(await redis.get(monthKey())) || 0;
  return used < config.search.monthlyCreditCap;
}

async function spendCredits(count = 1) {
  const redis = getRedis();
  const key = monthKey();
  const next = await redis.incrby(key, count);
  // TTL only needs to outlive the month; 32 days covers every month length.
  if (next <= count) await redis.pexpire(key, 32 * 24 * 60 * 60 * 1000);

  // The global monthly counter protects the Tavily account; this attributes the
  // same spend to the user action that triggered it, which is what lets the
  // admin view separate search spend from token spend.
  recordSearchUsage({ credits: count });
}

/** One place that knows how to talk to Tavily, so auth and timeouts agree. */
async function callTavily(url, body, timeoutMs) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Bearer is the current scheme. `api_key` in the body is also still
      // accepted and is sent alongside so an older key or a self-hosted proxy
      // that only understands the legacy form keeps working.
      Authorization: `Bearer ${config.search.tavilyApiKey}`,
    },
    body: JSON.stringify({ api_key: config.search.tavilyApiKey, ...body }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const err = new Error(`Tavily ${response.status}: ${detail.slice(0, 200)}`);
    err.status = response.status;
    throw err;
  }

  return response.json();
}

/**
 * @param {string} query
 * @param {object} [opts]
 * @param {number} [opts.maxResults]
 * @param {'basic'|'advanced'} [opts.depth]  advanced costs 2 credits and reads
 *   deeper into each result — worth it when hunting for an API reference,
 *   wasteful for "is this tool still free".
 * @param {string[]} [opts.includeDomains]
 * @returns {Promise<Array<{title:string, url:string, snippet:string}>|null>}
 *   null means "search unavailable right now" (unconfigured, over budget, or
 *   failed) — callers must treat that as "proceed without it," never as a hard
 *   error.
 */
export async function webSearch(query, { maxResults = 5, depth = 'basic', includeDomains } = {}) {
  const clean = String(query || '').trim();
  if (!clean || !isWebSearchConfigured()) return null;

  const cacheKey = cache.makeKey('websearch', [clean, maxResults, depth, includeDomains?.join(',') || '']);
  const cached = await cache.get(cacheKey);
  if (cached) return cached;

  if (!(await withinBudget())) {
    log.warn('Monthly web search credit cap reached — skipping', { cap: config.search.monthlyCreditCap });
    return null;
  }

  try {
    const data = await callTavily(
      SEARCH_URL,
      {
        query: clean,
        search_depth: depth,
        max_results: maxResults,
        ...(includeDomains?.length ? { include_domains: includeDomains } : {}),
      },
      12_000
    );

    await spendCredits(depth === 'advanced' ? 2 : 1);

    const results = (data.results || [])
      .slice(0, maxResults)
      .map(r => ({
        title: String(r.title || '').slice(0, 160),
        url: r.url,
        snippet: String(r.content || '').slice(0, 400),
      }))
      .filter(r => r.url);

    await cache.set(cacheKey, results, config.search.cacheTtlMs);
    return results;
  } catch (err) {
    log.warn('Web search failed', { error: err.message });
    return null;
  }
}

/**
 * Render pages and return their readable content.
 *
 * This is the fallback that makes documentation reachable. A plain `fetch` of a
 * Mintlify or Docusaurus site returns an empty app shell; Tavily executes the
 * page and returns what a reader would see.
 *
 * Priced per five URLs, so callers should batch rather than loop.
 *
 * @param {string[]} urls
 * @param {object} [opts]
 * @param {'basic'|'advanced'} [opts.depth]
 * @returns {Promise<Array<{url:string, text:string}>|null>} null when unavailable
 */
export async function extractPages(urls, { depth = 'basic' } = {}) {
  const targets = (Array.isArray(urls) ? urls : [urls])
    .map(url => String(url || '').trim())
    .filter(Boolean)
    // Tavily accepts up to 20; five is one credit's worth and more than any
    // single research step needs.
    .slice(0, 5);

  if (!targets.length || !isWebSearchConfigured()) return null;

  const cacheKey = cache.makeKey('tavily:extract', [targets.join('|'), depth]);
  const cached = await cache.get(cacheKey);
  if (cached) return cached;

  if (!(await withinBudget())) {
    log.warn('Monthly web search credit cap reached — skipping extract');
    return null;
  }

  try {
    const data = await callTavily(
      EXTRACT_URL,
      {
        urls: targets,
        extract_depth: depth,
        // Markdown keeps the heading and table structure that turns an endpoint
        // reference into something a model can read positionally, rather than a
        // wall of words where the method and the path have come apart.
        format: 'markdown',
      },
      30_000
    );

    await spendCredits(depth === 'advanced' ? 2 : 1);

    const results = (data.results || [])
      .map(entry => ({
        url: entry.url,
        text: String(entry.raw_content || entry.content || '').trim(),
      }))
      .filter(entry => entry.url && entry.text);

    if (data.failed_results?.length) {
      log.debug('Tavily could not extract some URLs', {
        failed: data.failed_results.map(f => f.url).slice(0, 5),
      });
    }

    // Cached longer than a search: documentation is the most static thing we
    // fetch, and re-extracting the same reference page is a wasted credit.
    await cache.set(cacheKey, results, Math.max(config.search.cacheTtlMs, 6 * 60 * 60 * 1000));
    return results;
  } catch (err) {
    log.warn('Tavily extract failed', { error: err.message });
    return null;
  }
}

/**
 * Find an API's documentation and read it, in one call.
 *
 * The architect's most common need, and doing it as one operation rather than
 * search-then-read-then-read is worth a dedicated function for two reasons.
 * It halves the number of model turns spent on a single lookup, and — more
 * importantly — it removes the step where the model picks a URL from a snippet
 * and picks the marketing page over the reference.
 *
 * @param {string} subject  e.g. "Notion create page"
 * @returns {Promise<{results:Array, pages:Array}|null>}
 */
export async function searchDocs(subject, { maxPages = 2 } = {}) {
  const clean = String(subject || '').trim();
  if (!clean || !isWebSearchConfigured()) return null;

  // "API reference documentation" rather than the bare subject: the query is
  // going to a search engine, and the difference between the docs and the
  // pricing page is entirely in those three words.
  const results = await webSearch(`${clean} API reference documentation endpoint`, {
    maxResults: 6,
    depth: 'advanced',
  });

  if (!results?.length) return null;

  const ranked = [...results].sort((a, b) => docScore(b) - docScore(a));
  const pages = await extractPages(
    ranked.slice(0, maxPages).map(r => r.url),
    { depth: 'advanced' }
  );

  return { results: ranked, pages: pages || [] };
}

/**
 * Rank a search result by how likely it is to be the reference rather than the
 * blog post about it.
 *
 * Crude on purpose. It only has to beat "whatever came back first", and search
 * engines rank documentation below marketing for exactly the queries where we
 * want the opposite.
 */
function docScore(result) {
  const url = String(result.url || '').toLowerCase();
  const title = String(result.title || '').toLowerCase();
  let score = 0;

  if (/\/(docs?|reference|api|developers?|api-reference)\b/.test(url)) score += 3;
  if (/developer|docs\./.test(url)) score += 2;
  if (/\b(reference|api|endpoint)\b/.test(title)) score += 2;
  if (/openapi|swagger/.test(url)) score += 3;
  // Community answers describe an API second-hand and are frequently out of date.
  if (/(medium\.com|dev\.to|reddit\.com|stackoverflow\.com|youtube\.com)/.test(url)) score -= 4;
  if (/\b(pricing|blog|about|careers)\b/.test(url)) score -= 3;

  return score;
}

/**
 * This month's search budget, for the admin cost dashboard.
 *
 * Reads the same Redis counter the budget guard uses, so the number shown is
 * the number actually enforced — a separately-derived figure (say, summing
 * ledger rows) would drift the moment a search happened outside a metered
 * request, and would quietly disagree with the cap doing the blocking.
 */
export async function getSearchBudget() {
  const configured = isWebSearchConfigured();
  let used = 0;

  if (configured) {
    try {
      used = Number(await getRedis().get(monthKey())) || 0;
    } catch (err) {
      log.warn('Could not read search budget counter', { error: err.message });
    }
  }

  const cap = config.search.monthlyCreditCap;
  return {
    configured,
    used,
    cap,
    remaining: Math.max(0, cap - used),
    percentUsed: cap ? Math.min(100, Math.round((used / cap) * 100)) : 0,
    month: monthKey().split(':').pop(),
  };
}

export default {
  webSearch,
  extractPages,
  searchDocs,
  isWebSearchConfigured,
  getSearchBudget,
};
