/**
 * Provider cost model — what a request actually costs us, in rupees.
 *
 * This is the other half of `plans.js`: that file prices what the user spends,
 * this one prices what we spend. The admin margin view is the difference, so
 * both have to be measured rather than assumed.
 *
 * Token prices are per 1M tokens in USD (how every provider publishes them),
 * converted to INR at a configured rate. The rate is deliberately a config
 * value and not a live FX lookup — a billing dashboard that changes its
 * historical numbers because the rupee moved is useless for spotting a real
 * cost regression. Ledger rows store the rupee cost computed at write time, so
 * history stays stable even when the rate is later updated.
 *
 * Unknown models fall back to `DEFAULT_MODEL_PRICE` rather than costing zero.
 * A silent zero is the worst failure mode here: it makes an unrecognised
 * (often expensive) model look free, exactly when you most want to notice it.
 */

import config from '../config/index.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('billing:pricing');

/**
 * USD per 1M tokens, keyed by a substring of the model id.
 *
 * Matching is by substring because model ids arrive prefixed with the provider
 * that served them (`openrouter/openai/gpt-5-mini`) and often carry a date or
 * quantisation suffix. Longest match wins, so `gpt-5-mini` beats `gpt-5`.
 */
export const MODEL_PRICES_USD = {
  // OpenAI
  'gpt-5-mini': { input: 0.25, output: 2.0 },
  'gpt-5-nano': { input: 0.05, output: 0.4 },
  'gpt-5': { input: 1.25, output: 10.0 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10.0 },
  'gpt-oss-120b': { input: 0.15, output: 0.6 },
  'gpt-oss-20b': { input: 0.075, output: 0.3 },

  // Anthropic
  'claude-haiku-4': { input: 1.0, output: 5.0 },
  'claude-sonnet-4': { input: 3.0, output: 15.0 },
  'claude-opus-4': { input: 15.0, output: 75.0 },

  // Meta / Groq-hosted open weights
  'llama-3.3-70b': { input: 0.59, output: 0.79 },
  'llama-3.1-8b': { input: 0.05, output: 0.08 },
  'llama-4-scout': { input: 0.11, output: 0.34 },
  'llama-4-maverick': { input: 0.2, output: 0.6 },

  // Mistral / DeepSeek / Qwen commonly seen on OpenRouter
  'mixtral-8x7b': { input: 0.24, output: 0.24 },
  'deepseek-chat': { input: 0.27, output: 1.1 },
  'deepseek-r1': { input: 0.55, output: 2.19 },
  'qwen-2.5-72b': { input: 0.35, output: 0.4 },

  // Google
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gemini-2.5-pro': { input: 1.25, output: 10.0 },
};

/**
 * Used when a model id matches nothing above. Set at roughly a mid-tier
 * model's price so an unpriced model shows up as a plausible cost rather than
 * as free (invisible) or absurd (drowns out everything else).
 */
export const DEFAULT_MODEL_PRICE = { input: 0.5, output: 1.5 };

/** Models we've already warned about, so an unpriced model logs once, not per call. */
const warnedModels = new Set();

/**
 * Resolve a model id to its USD/1M-token price.
 * @param {string} model  may be provider-prefixed, e.g. "groq/llama-3.3-70b-versatile"
 */
export function priceForModel(model) {
  const id = String(model || '').toLowerCase();
  if (!id) return { ...DEFAULT_MODEL_PRICE, matched: null };

  let best = null;
  for (const key of Object.keys(MODEL_PRICES_USD)) {
    if (id.includes(key) && (!best || key.length > best.length)) best = key;
  }

  if (best) return { ...MODEL_PRICES_USD[best], matched: best };

  if (!warnedModels.has(id)) {
    warnedModels.add(id);
    log.warn('No price entry for model — using default rate', {
      model: id,
      hint: 'Add it to MODEL_PRICES_USD in src/billing/pricing.js for accurate margin reporting.',
    });
  }
  return { ...DEFAULT_MODEL_PRICE, matched: null };
}

/**
 * Cost of one LLM call, in paise (integer hundredths of a rupee).
 *
 * Integer paise rather than floating rupees: these values are summed over
 * hundreds of thousands of ledger rows, and float drift in an accounting
 * column is a bug you only discover once the totals stop reconciling.
 */
export function llmCostPaise({ model, promptTokens = 0, completionTokens = 0 }) {
  const price = priceForModel(model);
  const usd =
    (Number(promptTokens) / 1_000_000) * price.input +
    (Number(completionTokens) / 1_000_000) * price.output;
  return Math.round(usd * config.billing.usdToInr * 100);
}

/** Cost of one web search call, in paise. Tavily bills per credit, 1 per basic search. */
export function searchCostPaise(credits = 1) {
  return Math.round(Number(credits) * config.billing.searchCreditUsd * config.billing.usdToInr * 100);
}

/** Format paise for display: 12345 → "₹123.45". */
export function formatPaise(paise) {
  const rupees = Number(paise || 0) / 100;
  return `₹${rupees.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default {
  MODEL_PRICES_USD,
  DEFAULT_MODEL_PRICE,
  priceForModel,
  llmCostPaise,
  searchCostPaise,
  formatPaise,
};
