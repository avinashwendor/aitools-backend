/**
 * Per-operation provider-cost accumulator.
 *
 * The problem: one user action fans out into a dozen independent provider
 * calls — a router completion, a planner completion, six playbook completions
 * running on a worker pool, maybe a Tavily search — across four modules that
 * know nothing about billing. To report what that *one action* cost, every one
 * of those calls has to report home.
 *
 * The alternatives were both bad. Threading a `meter` object through
 * `handleMessage → plan → writeAllPlaybooks → writePlaybook → complete` means
 * touching every signature in the engine and adding a parameter that exists
 * purely for accounting. A module-level mutable total is worse: concurrent
 * requests would silently bill each other's tokens.
 *
 * `AsyncLocalStorage` gives each request its own store, inherited by every
 * async call it makes, with no signature changes and no cross-talk — the
 * worker pool in `writeAllPlaybooks` inherits it automatically. Call sites just
 * do `recordProviderUsage(...)` and stay ignorant of billing entirely.
 *
 * Recording is always safe to call: outside a metered operation there is no
 * active store and the call is a no-op, so `llm.js` needs no branch for
 * background jobs, the seeder, or tests.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { llmCostPaise, searchCostPaise, browserCostPaise } from './pricing.js';

const storage = new AsyncLocalStorage();

/** Shape of a fresh accumulator. */
function emptyUsage() {
  return {
    llmPaise: 0,
    searchPaise: 0,
    /** Amortised infra cost of any browser session the operation held open. */
    browserPaise: 0,
    browserSeconds: 0,
    promptTokens: 0,
    completionTokens: 0,
    llmCalls: 0,
    searchCalls: 0,
    /** model id → number of calls, so cost can be attributed per model later. */
    models: new Map(),
    startedAt: Date.now(),
  };
}

/**
 * Run `fn` inside a fresh metering scope.
 *
 * @param {(usage: object) => Promise<any>} fn
 *   Receives the live accumulator — read it *after* awaiting the work to get
 *   the totals. It keeps mutating as calls land, so snapshot with
 *   `summarize()` rather than holding a reference.
 */
export function withMetering(fn) {
  const usage = emptyUsage();
  return storage.run(usage, () => fn(usage));
}

/** The active accumulator, or null outside a metered operation. */
export function currentUsage() {
  return storage.getStore() || null;
}

/**
 * Record one LLM call. Called from `ai/llm.js` on both success and failure —
 * a failed call that burned tokens still cost us money, and hiding that is how
 * a retry storm becomes an invisible cost overrun.
 */
export function recordLlmUsage({ model, promptTokens = 0, completionTokens = 0 }) {
  const usage = storage.getStore();
  if (!usage) return;

  usage.llmPaise += llmCostPaise({ model, promptTokens, completionTokens });
  usage.promptTokens += Number(promptTokens) || 0;
  usage.completionTokens += Number(completionTokens) || 0;
  usage.llmCalls += 1;
  if (model) usage.models.set(model, (usage.models.get(model) || 0) + 1);
}

/**
 * Record browser session wall-clock. Called once by the runner when it closes
 * the session, with the whole held duration — the cost is the session being
 * open, not the individual steps, so attributing it per-step would double-count
 * the gaps between them.
 */
export function recordBrowserUsage({ seconds = 0 } = {}) {
  const usage = storage.getStore();
  if (!usage) return;

  usage.browserPaise += browserCostPaise(seconds);
  usage.browserSeconds += Number(seconds) || 0;
}

/** Record one web search. Called from `ai/tools/webSearch.js` after a billed call. */
export function recordSearchUsage({ credits = 1 } = {}) {
  const usage = storage.getStore();
  if (!usage) return;

  usage.searchPaise += searchCostPaise(credits);
  usage.searchCalls += Number(credits) || 0;
}

/**
 * Freeze an accumulator into the plain shape the ledger stores.
 * Safe to call with null (no active scope) — returns a zeroed summary.
 */
export function summarize(usage) {
  if (!usage) {
    return {
      cost: { llmPaise: 0, searchPaise: 0, browserPaise: 0, totalPaise: 0 },
      tokens: { prompt: 0, completion: 0 },
      models: [],
      searchCalls: 0,
      llmCalls: 0,
      browserSeconds: 0,
      durationMs: 0,
    };
  }

  return {
    cost: {
      llmPaise: usage.llmPaise,
      searchPaise: usage.searchPaise,
      browserPaise: usage.browserPaise,
      totalPaise: usage.llmPaise + usage.searchPaise + usage.browserPaise,
    },
    tokens: { prompt: usage.promptTokens, completion: usage.completionTokens },
    // Array of {model, calls} — model ids contain dots, which MongoDB rejects
    // as map keys, so this must not be flattened into an object.
    models: [...usage.models].map(([model, calls]) => ({ model, calls })),
    searchCalls: usage.searchCalls,
    llmCalls: usage.llmCalls,
    browserSeconds: usage.browserSeconds,
    durationMs: Date.now() - usage.startedAt,
  };
}

export default {
  withMetering,
  currentUsage,
  recordLlmUsage,
  recordSearchUsage,
  recordBrowserUsage,
  summarize,
};
