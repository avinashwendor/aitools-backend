/**
 * Live role → model routing and per-role token ceilings.
 *
 * `llm.js` resolves a role to a model (and a max_tokens ceiling) on the hot
 * path of every call, so the lookup has to be synchronous. That rules out
 * reading Mongo per call and rules out an async cache miss. The shape here is
 * the same one `catalog.js` uses for the same reason: an in-process snapshot,
 * refreshed on a TTL and invalidated explicitly the moment an admin writes.
 *
 * Source of truth for *model ids* and *token ceilings* is the admin panel.
 * Env `AI_PROVIDERS` still owns keys, base URLs and provider order; its model
 * fields and `AI_MAX_TOKENS` / `AI_AGENTIC_MAX_TOKENS` are bootstrap defaults
 * seeded into Mongo once at boot.
 */

import config from '../config/index.js';
import ModelRouting from '../models/ModelRouting.js';
import { bus, EVENTS } from '../utils/events.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('ai:routing');

const REFRESH_MS = 60 * 1000;
export const ROUTING_ROLES = ['reasoning', 'planner', 'fast', 'utility'];

/** Hard bounds so a typo in the panel cannot request a million tokens. */
export const TOKEN_LIMIT_BOUNDS = {
  reasoning: { min: 500, max: 64_000 },
  planner: { min: 256, max: 16_000 },
  fast: { min: 256, max: 8_000 },
  utility: { min: 256, max: 8_000 },
};

const state = {
  /** `{ [providerName]: { [role]: modelId } }` */
  overrides: {},
  /** `{ [providerName]: { [role]: number } }` */
  tokenLimits: {},
  loadedAt: 0,
  loading: null,
};

function envModelFor(provider, role) {
  if (role === 'reasoning') return provider.reasoningModel || provider.plannerModel || null;
  if (role === 'fast') return provider.fastModel || null;
  if (role === 'utility') return provider.utilityModel || provider.fastModel || null;
  return provider.plannerModel || null;
}

function envTokenLimitFor(role) {
  if (role === 'reasoning') return config.ai.agenticMaxTokens || 32_000;
  if (role === 'fast') return Math.min(config.ai.maxTokens || 4096, 3000);
  if (role === 'utility') return Math.min(config.ai.maxTokens || 4096, 2000);
  return config.ai.maxTokens || 4096;
}

function clampTokenLimit(role, value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const bounds = TOKEN_LIMIT_BOUNDS[role] || { min: 256, max: 32_000 };
  return Math.max(bounds.min, Math.min(bounds.max, Math.round(n)));
}

async function load() {
  try {
    const doc = await ModelRouting.findOne({ key: 'default' }).lean();
    state.overrides = doc?.overrides || {};
    state.tokenLimits = doc?.tokenLimits || {};
    state.loadedAt = Date.now();
  } catch (err) {
    state.loadedAt = Date.now();
    log.warn('Could not load model routing — will use env bootstrap', { error: err.message });
  }
  return state.overrides;
}

/**
 * Copy any role / token ceiling still missing from Mongo from the env config.
 */
async function seedMissingFromEnv() {
  const providers = config.ai.providers || [];
  if (!providers.length) return false;

  let changed = false;
  const overrides = JSON.parse(JSON.stringify(state.overrides || {}));
  const tokenLimits = JSON.parse(JSON.stringify(state.tokenLimits || {}));

  for (const provider of providers) {
    const roles = { ...(overrides[provider.name] || {}) };
    const limits = { ...(tokenLimits[provider.name] || {}) };

    for (const role of ROUTING_ROLES) {
      if (!roles[role]) {
        const bootstrap = envModelFor(provider, role);
        if (bootstrap) {
          roles[role] = bootstrap;
          changed = true;
        }
      }
      if (limits[role] == null) {
        limits[role] = envTokenLimitFor(role);
        changed = true;
      }
    }

    overrides[provider.name] = roles;
    tokenLimits[provider.name] = limits;
  }

  if (!changed) return false;

  await ModelRouting.findOneAndUpdate(
    { key: 'default' },
    { $set: { overrides, tokenLimits } },
    { upsert: true }
  );

  state.overrides = overrides;
  state.tokenLimits = tokenLimits;
  state.loadedAt = Date.now();

  log.info('Seeded model routing + token limits from env — admin panel is now the source of truth', {
    detail: Object.entries(overrides)
      .map(([p, roles]) => {
        const lim = tokenLimits[p] || {};
        return `${p}:{${Object.entries(roles).map(([r, m]) => `${r}=${m}@${lim[r] || '?'}`).join(',')}}`;
      })
      .join(' '),
  });

  return true;
}

/** Warm the snapshot at boot so the first request doesn't run on an empty map. */
export async function initModelRouting() {
  await load();
  await seedMissingFromEnv().catch(err =>
    log.warn('Could not seed model routing from env', { error: err.message })
  );

  const count = Object.values(state.overrides).reduce((n, roles) => n + Object.keys(roles || {}).length, 0);
  if (count) {
    log.info('Model routing active (admin panel)', {
      count,
      detail: Object.entries(state.overrides)
        .map(([p, roles]) => {
          const lim = state.tokenLimits[p] || {};
          return `${p}:{${Object.entries(roles).map(([r, m]) => `${r}=${m}@${lim[r] || '?'}`).join(',')}}`;
        })
        .join(' '),
    });
  }
  return state.overrides;
}

function maybeRefresh() {
  if (Date.now() - state.loadedAt > REFRESH_MS && !state.loading) {
    state.loading = load().finally(() => { state.loading = null; });
  }
}

/**
 * The model id for one role, or null if neither the panel nor env has one.
 * Synchronous by contract.
 */
export function overrideFor(providerName, role) {
  maybeRefresh();
  return state.overrides?.[providerName]?.[role] || null;
}

/**
 * Admin-panel max_tokens for this provider + role, or null if unset.
 * Synchronous by contract — same snapshot as `overrideFor`.
 */
export function tokenLimitFor(providerName, role) {
  maybeRefresh();
  const raw = state.tokenLimits?.[providerName]?.[role];
  if (raw == null) return null;
  return clampTokenLimit(role, raw);
}

/** Everything currently routed, for the admin panel. */
export function currentOverrides() {
  return JSON.parse(JSON.stringify(state.overrides || {}));
}

export function currentTokenLimits() {
  return JSON.parse(JSON.stringify(state.tokenLimits || {}));
}

/**
 * Publish a write to this instance's snapshot immediately.
 */
export function applyOverrides(overrides, tokenLimits) {
  if (overrides != null) state.overrides = overrides || {};
  if (tokenLimits != null) state.tokenLimits = tokenLimits || {};
  state.loadedAt = Date.now();
  log.debug('Model routing applied', {
    providers: Object.keys(state.overrides).join(',') || 'none',
  });
}

/** Force the next lookup to reload from the database. */
export function invalidateModelRouting() {
  state.loadedAt = 0;
  log.debug('Model routing invalidated');
}

bus.on(EVENTS.MODEL_ROUTING_CHANGED, invalidateModelRouting);

export { clampTokenLimit, envTokenLimitFor };

export default {
  initModelRouting,
  overrideFor,
  tokenLimitFor,
  currentOverrides,
  currentTokenLimits,
  applyOverrides,
  invalidateModelRouting,
  ROUTING_ROLES,
  TOKEN_LIMIT_BOUNDS,
  clampTokenLimit,
};
