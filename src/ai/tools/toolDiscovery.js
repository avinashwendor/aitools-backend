/**
 * Turns web-search hits into admin-review candidates.
 *
 * Nothing found via web search is ever added to the live `Tool` catalog
 * automatically — this only writes to `SuggestedTool` (status: pending), and
 * an admin has to review/edit/approve it before it becomes real. Keeps the
 * public catalog curated instead of silently filling with unverified results.
 */

import SuggestedTool from '../../models/SuggestedTool.js';
import { getCatalog } from '../catalog.js';
import { completeJson } from '../llm.js';
import * as prompts from '../prompts.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('ai:toolDiscovery');

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Fire-and-forget from the caller's perspective: never throws, never delays
 * the user's response. Safe to call without `await`.
 *
 * @param {object} opts
 * @param {Array<{title:string,url:string,snippet:string}>} opts.webResults
 * @param {string} opts.assistantReply
 * @param {string} opts.sourceQuery
 * @param {string} [opts.userId]
 */
export async function discoverAndQueueTools({ webResults, assistantReply, sourceQuery, userId }) {
  if (!webResults?.length) return;

  try {
    const catalog = await getCatalog();
    const existingDomains = catalog.tools
      .map(t => domainOf(t.websiteUrl))
      .filter(Boolean);

    const { data } = await completeJson({
      task: 'tool-discovery:extract',
      role: 'fast',
      temperature: 0.1,
      maxTokens: 500,
      messages: [
        { role: 'system', content: prompts.suggestedToolExtractionSystem() },
        {
          role: 'user',
          content: prompts.suggestedToolExtractionUser({
            webResults,
            assistantReply: String(assistantReply || '').slice(0, 1500),
            existingDomains,
          }),
        },
      ],
      validate: v => (!v || !Array.isArray(v.tools) ? '"tools" must be an array.' : null),
    });

    for (const candidate of data.tools.slice(0, 3)) {
      const domain = domainOf(candidate.websiteUrl);
      if (!domain || existingDomains.includes(domain)) continue;

      await SuggestedTool.updateOne(
        { domain },
        {
          $setOnInsert: {
            domain,
            name: String(candidate.name || domain).slice(0, 120),
            websiteUrl: candidate.websiteUrl,
            tagline: String(candidate.tagline || '').slice(0, 200),
            suggestedCategory: String(candidate.suggestedCategory || ''),
            suggestedPricing: ['free', 'freemium', 'paid', 'contact'].includes(candidate.suggestedPricing)
              ? candidate.suggestedPricing
              : 'unknown',
            sourceQuery: String(sourceQuery || '').slice(0, 300),
            sourceUrl: webResults.find(r => domainOf(r.url) === domain)?.url || '',
            discoveredBy: userId || null,
            status: 'pending',
          },
        },
        { upsert: true }
      );
    }

    if (data.tools.length) {
      log.info('Queued tool suggestions for admin review', { count: data.tools.length, sourceQuery });
    }
  } catch (err) {
    log.warn('Tool discovery extraction failed', { error: err.message });
  }
}

export default { discoverAndQueueTools };
