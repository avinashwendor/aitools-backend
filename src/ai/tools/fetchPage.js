/**
 * Fetch a public page and reduce it to readable text.
 *
 * This is the tool that makes the difference between an architect that guesses
 * an API and one that knows it. Web search returns titles and two-line
 * snippets; the request shape, the auth header, the required query parameters
 * and the response envelope are all in the page behind the link. Without this,
 * a model builds a plausible-looking HTTP node against an endpoint it invented,
 * which is exactly the failure mode this whole system exists to remove.
 *
 * Two ways to read a page, tried in that order:
 *
 *   1. A plain HTTP fetch and regex extraction. Free, fast, and correct for
 *      server-rendered pages — which is still most OpenAPI documents, most
 *      GitHub-hosted docs and every JSON endpoint.
 *   2. Tavily's extract endpoint, which renders the page first.
 *
 * The second exists because most modern documentation is a JavaScript
 * application. Fetching a Mintlify, Docusaurus, ReadMe or GitBook site returns
 * a shell containing an empty div — no error, no warning, just a page with
 * nothing in it. That is worse than a failure, because the architect reads the
 * empty page, concludes the docs were unhelpful, and falls back to inventing
 * the endpoint. Detecting the shell and re-reading through a renderer is what
 * turns "the docs didn't load" into "here is the reference".
 *
 * Extraction from raw HTML is deliberately regex-based rather than a DOM
 * parser. The consumer is a language model, not a renderer: it needs the prose,
 * the code samples and the endpoint tables, and it does not care that the nav
 * bar was a <ul>. A parser would add a dependency and a parse failure mode to
 * buy fidelity nobody downstream can use.
 */

import cache from '../cache.js';
import { assertUrlAllowed } from '../../agentic/safety.js';
import { extractPages, isWebSearchConfigured } from './webSearch.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('ai:fetchpage');

/** Stop reading a response past this, before decoding it. */
const MAX_BYTES = 2_000_000;
const TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 30 * 60 * 1000;

/**
 * Rendered pages are kept far longer than fetched ones.
 *
 * A plain fetch is nearly free, so a short TTL costs little and keeps a status
 * page or a changelog current. Rendering is not free — it spends a Tavily
 * credit out of a capped monthly pool — and the thing we render is almost
 * always an API reference, which is stable for weeks. Expiring that after
 * thirty minutes means two builds against the same service an hour apart each
 * pay to render the same page, which is the single most repeated cost in the
 * architect. Six hours matches what the search layer already keeps.
 */
const RENDERED_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Below this many characters of extracted text, a page is treated as unread.
 *
 * Tuned to the shape of the problem rather than to a percentile: an app shell
 * yields a nav bar, a cookie banner and a "loading" string, which lands
 * somewhere under 400 characters. A genuinely short page that happens to be
 * real — a one-line JSON response, a 404 body — is not something the fallback
 * can improve on either, so paying a Tavily credit to confirm it is cheap
 * insurance rather than waste.
 */
const MIN_USEFUL_CHARS = 400;

/** Tags whose contents are never prose, and must go before whitespace collapsing. */
const STRIPPED_BLOCKS = /<(script|style|noscript|svg|canvas|iframe|template)\b[^>]*>[\s\S]*?<\/\1>/gi;

/** Elements that imply a line break once the tags themselves are gone. */
const BLOCK_LEVEL = /<\/?(p|div|section|article|header|footer|nav|br|hr|li|tr|h[1-6]|pre|table|thead|tbody)\b[^>]*>/gi;

const ENTITIES = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#39;': "'", '&apos;': "'", '&mdash;': '—', '&ndash;': '–', '&hellip;': '…',
};

function decodeEntities(text) {
  return text
    .replace(/&[a-z]+;|&#\d+;|&#x[0-9a-f]+;/gi, entity => {
      const known = ENTITIES[entity.toLowerCase()];
      if (known !== undefined) return known;
      const decimal = entity.match(/^&#(\d+);$/);
      if (decimal) return String.fromCodePoint(Number(decimal[1]));
      const hex = entity.match(/^&#x([0-9a-f]+);$/i);
      if (hex) return String.fromCodePoint(parseInt(hex[1], 16));
      return entity;
    });
}

function extractTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeEntities(match[1]).trim().slice(0, 200) : '';
}

/**
 * HTML → the text a reader would see.
 *
 * `<pre>` contents are preserved with their newlines because on an API docs
 * page that is the request example, and a curl command flattened onto one line
 * loses the header-per-line structure that made it readable.
 */
export function htmlToText(html) {
  let text = html.replace(STRIPPED_BLOCKS, ' ');

  // Comments can contain markup that would survive tag stripping otherwise.
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');

  text = text.replace(BLOCK_LEVEL, '\n');
  text = text.replace(/<[^>]+>/g, ' ');
  text = decodeEntities(text);

  return text
    .split('\n')
    .map(line => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    // Three or more blank lines carry no more meaning than one.
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * @param {string} rawUrl
 * @param {object} [opts]
 * @param {number} [opts.maxChars]  ceiling on the returned text
 * @param {AbortSignal} [opts.signal]
 * @param {boolean} [opts.allowRender]  permit the Tavily fallback. Off for
 *   workflow nodes, which fetch at run time and should not spend a search
 *   credit per execution; on for the architect, which reads a page once.
 * @returns {Promise<{url, title, text, contentType, truncated, via}>}
 * @throws when the URL is blocked, unreachable, or returns a non-2xx and no
 *   renderer is available to try instead
 */
export async function fetchPage(rawUrl, { maxChars = 8000, signal, allowRender = false } = {}) {
  const url = assertUrlAllowed(rawUrl);
  const target = url.toString();

  const cacheKey = cache.makeKey('fetchpage', [target, maxChars, allowRender]);
  const cached = await cache.get(cacheKey);
  if (cached) return cached;

  const canRender = allowRender && isWebSearchConfigured();

  let direct;
  try {
    direct = await fetchDirect(target, signal);
  } catch (err) {
    // A refused connection, a 403 from a bot filter, a TLS quirk — all reasons
    // a renderer with a real browser fingerprint may still succeed where we
    // did not. If it can't, the original error is the one worth reporting,
    // since it describes what actually happened to our request.
    if (!canRender) throw err;

    const rendered = await renderPage(target, maxChars);
    if (rendered) return cacheAndReturn(cacheKey, rendered, RENDERED_CACHE_TTL_MS);
    throw err;
  }

  if (canRender && direct.text.length < MIN_USEFUL_CHARS && !direct.contentType.includes('json')) {
    log.debug('Page looked empty after extraction — rendering', {
      url: target,
      chars: direct.text.length,
    });
    const rendered = await renderPage(target, maxChars);
    if (rendered && rendered.text.length > direct.text.length) {
      return cacheAndReturn(
        cacheKey,
        { ...rendered, title: direct.title || rendered.title },
        RENDERED_CACHE_TTL_MS
      );
    }
  }

  return cacheAndReturn(cacheKey, shape(direct, maxChars));
}

async function cacheAndReturn(cacheKey, result, ttlMs = CACHE_TTL_MS) {
  await cache.set(cacheKey, result, ttlMs);
  return result;
}

/** Apply the caller's ceiling and mark whether anything was cut. */
function shape({ url, title, text, contentType, via }, maxChars) {
  const truncated = text.length > maxChars;
  return {
    url,
    title,
    text: truncated ? `${text.slice(0, maxChars)}\n…[truncated at ${maxChars} characters]` : text,
    contentType,
    truncated,
    via,
  };
}

/**
 * Read a page through Tavily's renderer.
 *
 * Returns null rather than throwing on every failure path — this is a fallback,
 * and the caller always has something better to say about why the page could
 * not be read than "the fallback also failed".
 */
async function renderPage(target, maxChars) {
  try {
    const pages = await extractPages([target], { depth: 'advanced' });
    const page = pages?.[0];
    if (!page?.text) return null;

    return shape(
      {
        url: page.url || target,
        title: '',
        text: page.text,
        contentType: 'text/markdown',
        via: 'rendered',
      },
      maxChars
    );
  } catch (err) {
    log.debug('Render fallback failed', { url: target, error: err.message });
    return null;
  }
}

async function fetchDirect(target, signal) {
  const response = await fetch(target, {
    redirect: 'follow',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      // Documentation sites routinely serve a JS shell to unknown agents and
      // the real content to a browser UA. Identifying honestly as a bot but
      // accepting HTML is the compromise that gets readable pages back.
      'User-Agent': 'AIToolsArchitect/1.0 (+https://aitools-frontned-production.up.railway.app)',
      Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5',
      'Accept-Language': 'en',
    },
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText || 'request failed'} for ${target}`);
  }

  const contentType = (response.headers.get('content-type') || '').toLowerCase();

  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BYTES) {
    throw new Error(`That page is ${Math.round(declaredLength / 1e6)}MB — too large to read.`);
  }

  const raw = await response.text();
  if (raw.length > MAX_BYTES) {
    log.debug('Oversized page truncated before extraction', { url: target, bytes: raw.length });
  }
  const body = raw.slice(0, MAX_BYTES);

  let title = '';
  let text;

  if (contentType.includes('json')) {
    // Pretty-printed rather than passed through: an OpenAPI document on one
    // line is technically the same information and practically unreadable to a
    // model asked to find one endpoint in it.
    try {
      text = JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      text = body;
    }
  } else if (contentType.includes('html') || /^\s*<(!doctype|html)/i.test(body)) {
    title = extractTitle(body);
    text = htmlToText(body);
  } else {
    text = body;
  }

  return {
    url: response.url || target,
    title,
    text,
    contentType: contentType.split(';')[0] || 'text/plain',
    via: 'direct',
  };
}

export default { fetchPage, htmlToText };
