import mongoose from 'mongoose';

/**
 * Which model serves each role, overriding `AI_PROVIDERS`.
 *
 * The env var is the bootstrap default; this is the live value. The split
 * matters because the two answer different questions. `AI_PROVIDERS` is where
 * keys and base URLs live — secrets that belong in the deployment. Which model
 * serves the `fast` role is an operational decision that changes when a gateway
 * drops a model, and pushing it through an env var means a redeploy to react to
 * something that has already started failing.
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
     * `{ [providerName]: { reasoning, planner, fast, utility } }`.
     *
     * Sparse by design — a role absent here means "use what AI_PROVIDERS said".
     * Storing only the deltas keeps the env meaningful as the documented
     * baseline instead of a value that is always shadowed.
     */
    overrides: { type: mongoose.Schema.Types.Mixed, default: {} },

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
