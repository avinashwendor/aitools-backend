/**
 * Tavily web search — the assistant's one external-freshness tool.
 *
 * Optional infrastructure: no TAVILY_API_KEY means `isWebSearchConfigured()`
 * is false and every call is a safe no-op, same philosophy as the LLM
 * provider chain and Qdrant. Uses `fetch` directly against Tavily's REST API
 * rather than an SDK — the request shape is small and stable, and this keeps
 * the dependency footprint down.
 *
 * Budget-guarded: Tavily's free tier is 1,000 credits/month (basic search =
 * 1 credit). A monthly counter in Redis stops calls once the configured cap
 * is hit, well short of the hard 1,000 limit, so a burst of traffic degrades
 * to "search unavailable" instead of an unexpected mid-month bill. Results
 * are cached aggressively (tool/pricing facts don't change hour to hour), so
 * repeated similar questions don't re-spend credits at all.
 */

import config from '../../config/index.js';
import cache from '../cache.js';
import { getRedis } from '../../utils/redis.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('ai:websearch');

const TAVILY_URL = 'https://api.tavily.com/search';

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

async function spendCredit() {
  const redis = getRedis();
  const key = monthKey();
  const next = await redis.incr(key);
  // TTL only needs to outlive the month; 32 days covers every month length.
  if (next === 1) await redis.pexpire(key, 32 * 24 * 60 * 60 * 1000);
}

/**
 * @param {string} query
 * @param {object} [opts]
 * @param {number} [opts.maxResults]
 * @returns {Promise<Array<{title:string, url:string, snippet:string}>|null>}
 *   null means "search unavailable right now" (unconfigured, over budget, or failed) —
 *   callers must treat that as "proceed without it," never as a hard error.
 */
export async function webSearch(query, { maxResults = 5 } = {}) {
  const clean = String(query || '').trim();
  if (!clean || !isWebSearchConfigured()) return null;

  const cacheKey = cache.makeKey('websearch', [clean, maxResults]);
  const cached = await cache.get(cacheKey);
  if (cached) return cached;

  if (!(await withinBudget())) {
    log.warn('Monthly web search credit cap reached — skipping', { cap: config.search.monthlyCreditCap });
    return null;
  }

  try {
    const response = await fetch(TAVILY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: config.search.tavilyApiKey,
        query: clean,
        search_depth: 'basic',
        max_results: maxResults,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    await spendCredit();

    if (!response.ok) {
      log.warn('Tavily request failed', { status: response.status });
      return null;
    }

    const data = await response.json();
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

export default { webSearch, isWebSearchConfigured };
