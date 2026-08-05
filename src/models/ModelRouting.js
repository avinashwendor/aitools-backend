import mongoose from 'mongoose';

/**
 * Which model serves each role — the live source of truth for model ids.
 *
 * `AI_PROVIDERS` still owns keys, base URLs and provider failover order
 * (secrets that belong in the deployment). Its model-name fields are bootstrap
 * defaults only: `initModelRouting` copies any missing role into this document
 * once at boot, and from then on only the admin panel changes what runs.
 *
 * The failure that motivated this: a gateway listed four models in `/v1/models`
 * and served exactly one. Three of the four roles were pointed at models that
 * returned "no active provider available" on every call, so routing silently
 * fell back to heuristics and memory compaction stopped working — with nothing
 * in the product saying so, because each call failed the same way a transient
 * outage would.
 *
 * A single document: routing is global, not per-user, and a singleton keyed row
 * makes "what is live right now" one lookup with no ambiguity about precedence.
 */
const modelRoutingSchema = new mongoose.Schema(
  {
    /** Always 'default'. Present so the unique index has something to hold. */
    key: { type: String, default: 'default', unique: true, immutable: true },

    /**
     * `{ [providerName]: { reasoning, planner, fast, utility } }` — model ids.
     *
     * After boot seeding, every role for every configured provider should be
     * present. A missing role is a bug, not a silent env fallback.
     */
    overrides: { type: mongoose.Schema.Types.Mixed, default: {} },

    /**
     * `{ [providerName]: { reasoning, planner, fast, utility } }` — max_tokens
     * ceilings. Owned by the admin panel the same way model ids are. Env
     * `AI_MAX_TOKENS` / `AI_AGENTIC_MAX_TOKENS` are bootstrap defaults only.
     *
     * Per-provider on purpose: OpenRouter reserves credits against the
     * requested ceiling, so a key that can only afford 3500 needs a lower
     * planner cap than Omega even when both serve the same role.
     */
    tokenLimits: { type: mongoose.Schema.Types.Mixed, default: {} },

    /**
     * Last observed reachability per model id, from the admin panel's test
     * button: `{ [providerName]: { [modelId]: { ok, ms, checkedAt, error } } }`.
     *
     * Kept so the panel can show what was true a minute ago without re-probing
     * every model on every page load — each probe is a real billed completion.
     */
    health: { type: mongoose.Schema.Types.Mixed, default: {} },

    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

const ModelRouting = mongoose.model('ModelRouting', modelRoutingSchema);

export default ModelRouting;
