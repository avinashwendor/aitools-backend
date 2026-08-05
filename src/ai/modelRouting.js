/**
 * Live role → model routing.
 *
 * `llm.js` resolves a role to a model on the hot path of every call, so the
 * lookup has to be synchronous. That rules out reading Mongo per call and rules
 * out an async cache miss. The shape here is the same one `catalog.js` uses for
 * the same reason: an in-process snapshot, refreshed on a TTL and invalidated
 * explicitly the moment an admin writes, so a change is live in under a second
 * without a redeploy and without a database round trip per completion.
 *
 * Everything degrades to the `AI_PROVIDERS` env value: an unreachable database,
 * an empty collection and a role nobody has overridden all resolve the same
 * way. Routing must never be the reason the assistant stops answering.
 */

import ModelRouting from '../models/ModelRouting.js';
import { bus, EVENTS } from '../utils/events.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('ai:routing');

const REFRESH_MS = 60 * 1000;

const state = {
  /** `{ [providerName]: { [role]: modelId } }` */
  overrides: {},
  loadedAt: 0,
  loading: null,
};

async function load() {
  try {
    const doc = await ModelRouting.findOne({ key: 'default' }).lean();
    state.overrides = doc?.overrides || {};
    state.loadedAt = Date.now();
  } catch (err) {
    // Keep whatever we had. A routing table that cannot be read is not a
    // reason to stop serving — the env defaults are still correct.
    state.loadedAt = Date.now();
    log.warn('Could not load model routing overrides — using env defaults', { error: err.message });
  }
  return state.overrides;
}

/** Warm the snapshot at boot so the first request doesn't run on an empty map. */
export async function initModelRouting() {
  await load();
  const count = Object.values(state.overrides).reduce((n, roles) => n + Object.keys(roles || {}).length, 0);
  if (count) {
    log.info('Model routing overrides active', {
      count,
      detail: Object.entries(state.overrides)
        .map(([p, roles]) => `${p}:{${Object.entries(roles).map(([r, m]) => `${r}=${m}`).join(',')}}`)
        .join(' '),
    });
  }
  return state.overrides;
}

/**
 * The override for one role, or null to use the env default.
 *
 * Synchronous by contract. A stale snapshot triggers a background refresh and
 * returns the current value rather than awaiting one — a completion must never
 * block on the routing table.
 */
export function overrideFor(providerName, role) {
  if (Date.now() - state.loadedAt > REFRESH_MS && !state.loading) {
    state.loading = load().finally(() => { state.loading = null; });
  }
  return state.overrides?.[providerName]?.[role] || null;
}

/** Everything currently overridden, for the admin panel. */
export function currentOverrides() {
  return JSON.parse(JSON.stringify(state.overrides || {}));
}

/**
 * Publish a write to this instance's snapshot immediately.
 *
 * Invalidating alone is not enough. `overrideFor` is synchronous, so a stale
 * snapshot can only *schedule* a reload and must return the old value in the
 * meantime — which meant the request right after a save still ran on the model
 * the admin had just moved away from, while the UI said the change was live.
 * The writer already holds the new document, so hand it over directly and let
 * the TTL carry it to the other instances.
 */
export function applyOverrides(overrides) {
  state.overrides = overrides || {};
  state.loadedAt = Date.now();
  log.debug('Model routing applied', { providers: Object.keys(state.overrides).join(',') || 'none' });
}

/** Force the next `overrideFor` to reload from the database. */
export function invalidateModelRouting() {
  state.loadedAt = 0;
  log.debug('Model routing invalidated');
}

bus.on(EVENTS.MODEL_ROUTING_CHANGED, invalidateModelRouting);

export default {
  initModelRouting,
  overrideFor,
  currentOverrides,
  applyOverrides,
  invalidateModelRouting,
};
