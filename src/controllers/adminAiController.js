/**
 * Model routing admin — see what each role runs on, test it, repoint it.
 *
 * The problem this solves is specific. A gateway's `/v1/models` is a catalogue,
 * not a promise: ours listed twelve models and served one. Three of the four
 * roles were configured against models that returned "no active provider
 * available" on every call, and nothing surfaced it — routing quietly fell back
 * to heuristics, memory compaction stopped, and every symptom looked like a
 * different bug. Listing models is therefore not enough. The panel has to send
 * a real completion and report what came back.
 *
 * Endpoints:
 *   GET  /api/admin/ai/routing        what each role runs on, plus known health
 *   GET  /api/admin/ai/models         what each provider says it offers
 *   POST /api/admin/ai/test           probe specific models, live
 *   PUT  /api/admin/ai/routing        repoint roles (no redeploy)
 */

import config from '../config/index.js';
import ModelRouting from '../models/ModelRouting.js';
import { currentOverrides, applyOverrides } from '../ai/modelRouting.js';
import { getProviderStatus } from '../ai/llm.js';
import { bus, EVENTS } from '../utils/events.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('admin:ai');

export const ROLES = ['reasoning', 'planner', 'fast', 'utility'];

/**
 * What each role is for, in the terms that decide it. Served to the UI so the
 * panel explains the consequence of a choice instead of listing four words.
 */
const ROLE_INFO = {
  reasoning: {
    label: 'Reasoning',
    used: 'Workflow plan & refine, the agent architect, the AI Agent node',
    matters:
      'Writes the stage graph and the executable workflows. A plausible-but-wrong answer here is not a worse sentence — it is a workflow that runs unattended against real APIs. This role deliberately skips model fallback, so an unreachable model means no plan at all.',
    wants: 'The strongest model available.',
  },
  planner: {
    label: 'Planner',
    used: 'Stage playbooks, grounded Q&A, the agent acceptance review',
    matters:
      'Everything a person reads and can judge for themselves. Quality shows up as vague steps rather than a broken product.',
    wants: 'A strong mid-tier model. Runs several times per workflow, so latency and price both bite.',
  },
  fast: {
    label: 'Fast',
    used: 'Intent routing, profile extraction, tool discovery',
    matters:
      'Classification. A wrong answer costs one bad retrieval. An unreachable model is worse than it sounds: routing falls back to keyword heuristics, so intake questions go generic and nothing reports an error.',
    wants: 'The cheapest model that reads reliably. Reasoning-tier models need a generous token ceiling — they spend it thinking before writing.',
  },
  utility: {
    label: 'Utility',
    used: 'Conversation compaction, agent transcript summarisation',
    matters:
      'Dense compression, no judgement. Failures are invisible: long conversations quietly stop remembering their own earlier turns.',
    wants: 'The cheapest capable long-context model.',
  },
};

/** The model a role resolves to today, and where that value came from. */
function resolveRole(provider, role, overrides) {
  const override = overrides?.[provider.name]?.[role] || null;
  const envValue =
    role === 'reasoning' ? provider.reasoning || provider.planner
      : role === 'fast' ? provider.fast
      : role === 'utility' ? provider.utility || provider.fast
      : provider.planner;

  return {
    role,
    ...ROLE_INFO[role],
    active: override || envValue || null,
    source: override ? 'override' : 'env',
    envDefault: envValue || null,
    override,
  };
}

/** Providers as the panel needs them — never including the key. */
function providerView() {
  const status = getProviderStatus();
  return config.ai.providers.map(p => {
    const live = status.find(s => s.name === p.name) || {};
    return {
      name: p.name,
      baseUrl: p.baseUrl,
      planner: p.plannerModel,
      fast: p.fastModel,
      reasoning: p.reasoningModel,
      utility: p.utilityModel,
      fallbacks: p.fallbackModels,
      available: live.available !== false,
      benchedForSeconds: live.benchedForSeconds || 0,
    };
  });
}

// ─────────────────────────────────────────────────────────────
// GET /api/admin/ai/routing
// ─────────────────────────────────────────────────────────────
export const getRouting = async (req, res, next) => {
  try {
    const doc = await ModelRouting.findOne({ key: 'default' }).lean();
    const overrides = doc?.overrides || currentOverrides();
    const providers = providerView();

    res.json({
      success: true,
      data: {
        providers: providers.map(p => ({
          ...p,
          roles: ROLES.map(role => resolveRole(p, role, overrides)),
        })),
        health: doc?.health || {},
        updatedAt: doc?.updatedAt || null,
        /**
         * The chain only fails over between providers, never between roles, so
         * a single provider means a single point of failure for every role at
         * once. Worth saying in the UI rather than leaving to be discovered.
         */
        singleProvider: providers.length < 2,
      },
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────
// GET /api/admin/ai/models
// ─────────────────────────────────────────────────────────────
/**
 * What each provider claims to offer.
 *
 * Explicitly labelled as a claim in the response. Being listed here is not
 * evidence a model works — that is what the test endpoint is for, and the gap
 * between the two lists is the whole reason this page exists.
 */
export const listModels = async (req, res, next) => {
  try {
    const results = await Promise.all(
      config.ai.providers.map(async provider => {
        try {
          const response = await fetch(`${provider.baseUrl}/models`, {
            headers: { Authorization: `Bearer ${provider.apiKey}` },
            signal: AbortSignal.timeout(15_000),
          });

          if (!response.ok) {
            return { provider: provider.name, models: [], error: `HTTP ${response.status}` };
          }

          const body = await response.json();
          const models = (body.data || body.models || [])
            .map(m => (typeof m === 'string' ? m : m.id || m.name))
            .filter(Boolean)
            .sort();

          return { provider: provider.name, models, error: null };
        } catch (err) {
          return { provider: provider.name, models: [], error: err.message };
        }
      })
    );

    res.json({
      success: true,
      data: {
        providers: results,
        note: 'A listed model is what the gateway advertises, not proof it responds. Test before assigning a role.',
      },
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────
// POST /api/admin/ai/test
// ─────────────────────────────────────────────────────────────
/**
 * Send one real JSON-mode completion per model and report what came back.
 *
 * The request shape mirrors what the engine actually sends, because that is
 * what determines whether a model is usable here rather than in general. Two
 * details matter and both were learned the hard way:
 *
 *   - `max_tokens` is generous. Reasoning-tier models spend the allowance on
 *     hidden reasoning before emitting a character, so a small ceiling makes a
 *     working model look broken — it returns `finish_reason: length` and an
 *     empty string.
 *   - JSON mode is requested, because a provider that 400s on
 *     `response_format` is unusable for routing and planning no matter how
 *     well it chats.
 */
async function probeModel(provider, model) {
  const startedAt = Date.now();

  try {
    const response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'You output JSON only.' },
          { role: 'user', content: 'Return exactly {"ok":true}' },
        ],
        temperature: 0.1,
        max_tokens: 2000,
        ...(provider.noJsonMode ? {} : { response_format: { type: 'json_object' } }),
      }),
      signal: AbortSignal.timeout(60_000),
    });

    const ms = Date.now() - startedAt;
    const body = await response.json().catch(() => ({}));

    if (!response.ok || body.error) {
      return {
        ok: false,
        ms,
        status: response.status,
        error: String(body.error?.message || `HTTP ${response.status}`).replace(/\s+/g, ' ').slice(0, 160),
      };
    }

    const choice = body.choices?.[0];
    const content = choice?.message?.content ?? '';
    const reasoningTokens = body.usage?.completion_tokens_details?.reasoning_tokens ?? 0;

    let parses = false;
    try { JSON.parse(content); parses = true; } catch { /* not JSON */ }

    // Answered, but spent the whole budget thinking. Usable, and worth flagging
    // — every call site pointed at this model needs headroom for that.
    if (!content && choice?.finish_reason === 'length') {
      return {
        ok: false,
        ms,
        reasoningTokens,
        error: `Returned no content — spent all ${reasoningTokens || 'available'} tokens on internal reasoning. Usable only with a much larger token ceiling.`,
      };
    }

    return {
      ok: true,
      ms,
      parses,
      reasoningTokens,
      tokens: body.usage?.total_tokens ?? null,
      sample: String(content).slice(0, 80),
    };
  } catch (err) {
    return {
      ok: false,
      ms: Date.now() - startedAt,
      error: (err.name === 'TimeoutError' ? 'Timed out after 60s' : err.message).slice(0, 160),
    };
  }
}

export const testModels = async (req, res, next) => {
  try {
    const { provider: providerName, models } = req.body;

    const targets = config.ai.providers.filter(p => !providerName || p.name === providerName);
    if (!targets.length) {
      return res.status(404).json({ success: false, message: `No provider named "${providerName}".` });
    }

    const requested = Array.isArray(models) && models.length ? models.slice(0, 12) : null;

    const results = [];
    for (const provider of targets) {
      // Whatever was asked for, or everything this provider's roles depend on.
      const list = requested || [...new Set([
        provider.reasoningModel,
        provider.plannerModel,
        provider.fastModel,
        provider.utilityModel,
        ...provider.fallbackModels,
      ].filter(Boolean))];

      // Sequential: these are real billed completions, and a gateway that is
      // already struggling should not be hit with twelve at once.
      for (const model of list) {
        const result = await probeModel(provider, model);
        results.push({ provider: provider.name, model, ...result, checkedAt: new Date().toISOString() });
      }
    }

    // Remembered so the panel can show the last known state without re-billing
    // a probe on every page load.
    const health = {};
    for (const r of results) {
      health[r.provider] = health[r.provider] || {};
      health[r.provider][r.model] = { ok: r.ok, ms: r.ms, error: r.error || null, checkedAt: r.checkedAt };
    }

    await ModelRouting.findOneAndUpdate(
      { key: 'default' },
      { $set: Object.fromEntries(Object.entries(health).map(([p, v]) => [`health.${p}`, v])) },
      { upsert: true }
    ).catch(err => log.warn('Could not persist model health', { error: err.message }));

    log.info('Model availability tested', {
      tested: results.length,
      ok: results.filter(r => r.ok).length,
      failed: results.filter(r => !r.ok).map(r => r.model).join(', ') || 'none',
    });

    res.json({ success: true, data: { results } });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────
// PUT /api/admin/ai/routing
// ─────────────────────────────────────────────────────────────
export const updateRouting = async (req, res, next) => {
  try {
    const { provider: providerName, roles = {}, skipVerification = false } = req.body;

    const provider = config.ai.providers.find(p => p.name === providerName);
    if (!provider) {
      return res.status(404).json({ success: false, message: `No provider named "${providerName}".` });
    }

    const invalidRole = Object.keys(roles).find(r => !ROLES.includes(r));
    if (invalidRole) {
      return res.status(400).json({ success: false, message: `Unknown role "${invalidRole}".` });
    }

    /**
     * Verify before saving.
     *
     * The failure this prevents is the one that motivated the page: a role
     * pointed at a model the gateway lists but does not serve. That does not
     * announce itself — the `fast` role falls back to keyword heuristics and
     * the product keeps answering, slightly worse, indefinitely. Checking here
     * costs one completion per changed role and turns a silent degradation
     * into a message on the screen before it ships.
     */
    const verification = [];
    if (!skipVerification) {
      for (const [role, model] of Object.entries(roles)) {
        if (!model) continue;
        const result = await probeModel(provider, model);
        verification.push({ role, model, ...result });
      }

      const broken = verification.filter(v => !v.ok);
      if (broken.length) {
        return res.status(422).json({
          success: false,
          message:
            `Not saved — ${broken.length === 1 ? 'this model does not respond' : 'these models do not respond'}: ` +
            broken.map(b => `${b.role} → ${b.model} (${b.error})`).join('; '),
          data: { verification },
        });
      }
    }

    const existing = await ModelRouting.findOne({ key: 'default' }).lean();
    const overrides = { ...(existing?.overrides || {}) };
    overrides[providerName] = { ...(overrides[providerName] || {}) };

    for (const [role, model] of Object.entries(roles)) {
      // An empty value clears the override and hands the role back to the env
      // default, which is how you undo a change without knowing what it was.
      if (!model) delete overrides[providerName][role];
      else overrides[providerName][role] = String(model).slice(0, 120);
    }

    const doc = await ModelRouting.findOneAndUpdate(
      { key: 'default' },
      { $set: { overrides, updatedBy: req.user._id } },
      { upsert: true, new: true }
    ).lean();

    // Live on the next completion. Applied directly here rather than only
    // invalidated, because `llm.js` resolves roles synchronously and would
    // otherwise serve the previous model until a background reload landed —
    // for the one request most likely to be the admin checking their change.
    // Other instances pick it up on their own TTL.
    applyOverrides(doc.overrides);
    bus.emit(EVENTS.MODEL_ROUTING_CHANGED);

    log.info('Model routing updated', {
      provider: providerName,
      roles: Object.entries(roles).map(([r, m]) => `${r}=${m || 'env default'}`).join(', '),
      by: String(req.user._id),
    });

    res.json({
      success: true,
      data: {
        overrides: doc.overrides,
        verification,
        message: 'Routing updated — live on the next request, no redeploy needed.',
      },
    });
  } catch (error) {
    next(error);
  }
};

export default { getRouting, listModels, testModels, updateRouting, ROLES };
