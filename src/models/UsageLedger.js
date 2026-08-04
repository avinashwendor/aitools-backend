import mongoose from 'mongoose';

/**
 * Append-only usage ledger — one row per metered action.
 *
 * This collection is the evidence behind every number in both dashboards:
 * the user's "you've used 340 of 2,500 credits" and the admin's "we spent
 * ₹812 on tokens and ₹96 on search this month". Because it stores the user
 * price and our cost on the same row, margin is a single aggregation rather
 * than a reconciliation between two systems that will eventually disagree.
 *
 * Rows are never updated in place except to mark a refund — an action that
 * failed after we'd already charged for it gets `refunded: true` and a
 * compensating `credits` reading of 0, with the original amount preserved in
 * `creditsOriginal` so the audit trail survives.
 */
const usageLedgerSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    /** Metered action key from `billing/plans.js` — e.g. "workflow.generate". */
    action: {
      type: String,
      required: true,
      index: true,
    },

    /** Credits deducted from the user's allowance. 0 once refunded. */
    credits: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },

    /** What was charged before any refund, kept for the audit trail. */
    creditsOriginal: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },

    /**
     * What the action actually cost us, in paise, split by source so the admin
     * view can answer "how much of my spend is tokens vs search" directly
     * instead of inferring it.
     */
    cost: {
      llmPaise: { type: Number, default: 0, min: 0 },
      searchPaise: { type: Number, default: 0, min: 0 },
      /**
       * Legacy: amortised browser-session infra, from when agentic runs could
       * drive a real browser. Nothing writes it any more, but historical rows
       * carry a non-zero value and the margin aggregation still has to add it
       * up or last quarter's numbers change retroactively.
       */
      browserPaise: { type: Number, default: 0, min: 0 },
      totalPaise: { type: Number, default: 0, min: 0, index: true },
    },

    /** Token counts behind `cost.llmPaise`, for per-model cost analysis. */
    tokens: {
      prompt: { type: Number, default: 0, min: 0 },
      completion: { type: Number, default: 0, min: 0 },
    },

    /**
     * Provider/model ids that served this action, with a call count each.
     *
     * An array rather than a Map because model ids routinely contain dots
     * ("openrouter/openai/gpt-5.6-luna") and MongoDB forbids dots in map keys —
     * a Map here silently failed validation and dropped the whole ledger row.
     * The array also aggregates with a plain `$unwind`, no `$objectToArray`.
     */
    models: [
      {
        _id: false,
        model: { type: String, required: true },
        calls: { type: Number, default: 1, min: 0 },
      },
    ],

    /** Tavily search calls made during this action. */
    searchCalls: { type: Number, default: 0, min: 0 },

    /** The plan in force when this was charged — plans change, history shouldn't. */
    plan: {
      type: String,
      required: true,
      default: 'free',
      index: true,
    },

    /** Billing period this row counts against, as "YYYY-MM" of the period start. */
    periodKey: {
      type: String,
      required: true,
      index: true,
    },

    /** Chat session the action belonged to, when there was one. */
    sessionId: { type: String, default: null },

    /** Wall-clock duration of the action, for correlating cost with latency. */
    durationMs: { type: Number, default: 0, min: 0 },

    /** Set when a charged action later failed and the credits were returned. */
    refunded: { type: Boolean, default: false },
    refundReason: { type: String, default: null },

    /**
     * Whether the balance check passed. Denied attempts are recorded at zero
     * credits so the admin can see demand that the plan limits turned away —
     * that is the upgrade signal, and it is invisible if you only log success.
     */
    denied: { type: Boolean, default: false },

    /** Free-form detail (intent, cache hit, stage count). Never used for billing math. */
    meta: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true }
);

// Per-user dashboard: "my activity this period, newest first".
usageLedgerSchema.index({ user: 1, periodKey: 1, createdAt: -1 });

// Admin timeseries and per-action cost rollups.
usageLedgerSchema.index({ createdAt: -1, action: 1 });

/**
 * TTL index. Retention is a config value but a Mongo TTL index needs a literal
 * at definition time, so the seconds are read from config here; changing the
 * setting requires dropping and recreating the index (documented in SETUP.md).
 */
usageLedgerSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 400 * 24 * 60 * 60, name: 'ledger_ttl' }
);

const UsageLedger = mongoose.model('UsageLedger', usageLedgerSchema);

export default UsageLedger;
