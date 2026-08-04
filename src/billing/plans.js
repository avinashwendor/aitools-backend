/**
 * Plan catalog — the single source of truth for what each tier costs, what it
 * includes, and what every metered action deducts.
 *
 * Two numbers describe every action and they must not be confused:
 *
 *   • CREDITS      what the *user* spends. A product currency we control.
 *   • PROVIDER COST what *we* spend, in real rupees, on tokens and search
 *                  calls (see `pricing.js`). Never shown on the pricing page.
 *
 * Keeping them separate is what makes the admin margin view meaningful: a
 * workflow always costs the user 75 credits, but its true cost swings with
 * which provider in the failover chain served it, how many stages the planner
 * chose, and how many playbook calls hit the cache. The ledger records both
 * on every entry, which is what lets `/api/admin/billing/actions` report the
 * real margin per action type rather than an assumed one.
 *
 * Credit prices are derived from measured cost at roughly a 4× markup at the
 * Pro tier — see the note on `CREDIT_COSTS` for the measurements and the
 * arithmetic.
 */

/** Ordered cheapest → richest. Order drives display and upgrade suggestions. */
export const PLAN_IDS = ['free', 'pro', 'studio', 'enterprise'];

/**
 * What each metered action deducts from the user's monthly allowance.
 *
 * These are calibrated against **measured** provider cost, not estimates. Runs
 * against the live provider chain (gpt-5-mini for routing, gpt-5.6-luna for
 * planning) came out at:
 *
 *   chat.message        ₹0.49    2.4k prompt + 0.8k completion,  2 calls
 *   workflow.generate   ₹7.30    6.3k prompt + 7.5k completion,  7 calls (6 stages)
 *
 * A workflow costs ~15× a question, so pricing both at "1 request = 1 credit"
 * would let a workflow-heavy user cost fifteen times what their neighbour
 * costs on the same plan. The ratio below mirrors the real one.
 *
 * The anchor: **1 credit ≈ ₹0.10 of provider cost**, against ₹0.40 of revenue
 * per credit at the Pro tier (₹999 ÷ 2,500) — a ~75% gross margin with room
 * for cache misses, the free tier, and failover onto a pricier provider.
 *
 * Re-measure after any change to the model chain: `/api/admin/billing/actions`
 * reports live average cost per action, which is exactly the number these
 * should be derived from.
 */
export const CREDIT_COSTS = {
  /** A grounded answer about tools — one retrieval + one completion. ~₹0.49. */
  'chat.message': 5,
  /**
   * A full multi-stage workflow, playbooks included. ~₹7.30 at six stages,
   * nearer ₹4 at three, plus the two intake turns that precede it (which are
   * themselves free, so their cost is folded in here).
   */
  'workflow.generate': 75,
  /** Refine reuses unchanged playbooks — roughly 40% of a fresh generation. */
  'workflow.refine': 30,
  /** Regenerating one stage's playbook: a single planner call. */
  'workflow.deepdive': 10,
  /**
   * A cache hit costs us nothing but the lookup. Charging full price for it
   * would be dishonest metering, and users notice when an instant response
   * bills the same as a 50-second one. Priced to cover retrieval only.
   */
  'workflow.cached': 3,
  /** One Tavily search at $0.008 ≈ ₹0.70. Billed on top of its triggering action. */
  'search.web': 7,
  /** Committing a workflow to a task board — scheduling is deterministic, no LLM. */
  'taskboard.create': 2,
  /** Lightweight catalog search via MCP / API — retrieval only. */
  'catalog.search': 1,

  /**
   * Agentic runs and architect sessions are metered differently from
   * everything above, and the difference is worth stating plainly.
   *
   * Every action above is one bounded burst of inference: we know within a
   * factor of two what it will cost before it starts, so a fixed credit price
   * is honest. Agentic work is not bounded. A run is *a program someone else
   * wrote* — four free template nodes, or an agent node grinding through
   * twenty model calls against a rendered documentation page. A build is an
   * open-ended research loop: "add a Slack message at the end" is two model
   * calls, "watch three competitor pricing pages and email me a weekly diff"
   * is fifteen. Any fixed price is simultaneously extortion for the small case
   * and a subsidy for the large one.
   *
   * So these two entries are **base fees only**. They cover the queue slot,
   * the run or build document, the orchestration, and the attempts that fail
   * before doing any work. The rest of the charge is the tokens actually
   * consumed, converted to credits by `creditsForCost` after the work
   * finishes — see TOKEN_METERED_ACTIONS.
   */
  'agent.run': 8,
  'agent.build': 10,
};

/**
 * Actions charged as `base fee + what the tokens actually cost`.
 *
 * The rest of the catalog is fixed-price because its cost is predictable.
 * These are not, and pretending otherwise has a specific failure mode: to make
 * a fixed price safe you have to cap the work, and capping agentic work is how
 * you get an architect that stops reading documentation halfway through and
 * invents the rest of the endpoint. Metering the tokens instead means the
 * ceiling can come off — a build that needs to read six pages reads six pages,
 * and costs what six pages cost.
 */
export const TOKEN_METERED_ACTIONS = new Set(['agent.run', 'agent.build']);

/**
 * Provider paise that one credit is meant to cover.
 *
 * This is the anchor the whole catalog is derived from, made explicit: the
 * fixed prices above were each set at roughly `measured cost ÷ 10 paise`, and
 * token-metered actions apply the same conversion at settlement instead of in
 * advance. Against ₹0.40 of revenue per credit at the Pro tier (₹999 ÷ 2,500)
 * it leaves a ~75% gross margin, with the same room for cache misses, the free
 * tier and failover onto a pricier provider.
 *
 * Lower this number to charge more credits for the same work.
 */
export const PAISE_PER_CREDIT = 10;

/**
 * Convert real provider cost into credits.
 *
 * Rounded up, and never to zero for work that cost anything: a build that
 * consumed a rupee of tokens and billed nothing is a rounding rule that a
 * scripted client will find and exploit within a day.
 */
export function creditsForCost(paise) {
  const spent = Math.max(0, Number(paise) || 0);
  if (!spent) return 0;
  return Math.max(1, Math.ceil(spent / PAISE_PER_CREDIT));
}

/**
 * The full charge for a token-metered action.
 *
 * @param {string} action
 * @param {number} providerPaise  measured cost of the work, from the meter
 * @param {number} [extra]        fixed add-ons, e.g. per-node prices on a run
 */
export function meteredCost(action, providerPaise, extra = 0) {
  return creditCost(action) + creditsForCost(providerPaise) + Math.max(0, Math.round(extra));
}

/**
 * Intents that are never charged.
 *
 * Intake ("clarify") is the big one: those turns cost us two router calls
 * each, but they are questions *we* insisted on asking before we'd build
 * anything. Billing someone for answering our own onboarding would be
 * hostile, so the cost is folded into `workflow.generate` instead. They still
 * get a zero-credit ledger row so the spend stays visible to the operator.
 */
export const FREE_ACTIONS = new Set(['smalltalk', 'clarify', 'refused']);

/** Ledger action used for those unbilled-but-not-free turns. */
export const UNBILLED_ACTION = 'chat.clarify';

/**
 * The lowest price any metered action can have. Used as the pre-flight balance
 * check: we can't know a chat turn's real cost until the router has classified
 * it, so we verify the user can afford *something* up front and settle the
 * exact amount afterwards.
 */
export const MIN_ACTION_COST = Math.min(...Object.values(CREDIT_COSTS));

/**
 * How far a single action may push a balance negative.
 *
 * Because metered work settles after it is done, a user sitting at 1 credit can
 * start a turn that the router then classifies as a workflow, or a build that
 * turns out to need eight documentation pages. Refusing to record work already
 * paid for in real tokens is worse than letting the balance dip: the tokens are
 * gone either way, and a rejected `spend()` means we ate the cost silently.
 *
 * Set well above the largest fixed price rather than equal to it, because
 * token-metered actions have no fixed price to bound. It is still a bound —
 * the next request is refused normally, so the exposure is one action deep.
 */
export const MAX_OVERDRAFT_CREDITS = 500;

/**
 * Usage-based billing beyond the plan allowance.
 *
 * The alternative — hard-stopping at zero — is the right behaviour for a
 * hobbyist and the wrong one for anyone with a workflow on a schedule. Their
 * cron does not stop because their allowance ran out; it just starts failing,
 * silently, at 6am, and they find out from the absence of a report.
 *
 * So paid plans can opt in to continuing past the allowance at a per-credit
 * rate. Three properties make that safe to offer:
 *
 *   • **Opt-in.** Off until the account turns it on. Nobody is ever surprised
 *     by a charge they did not agree to.
 *   • **Capped.** Both by the plan and by a limit the user sets themselves.
 *     A runaway loop costs a known maximum, not an unknown one.
 *   • **Accrued, not charged.** There is no payment gateway here. Overage
 *     accumulates as an amount owed on the account, visible to the user and to
 *     the admin, settled out of band. Anything that says "billed" means
 *     "recorded"; no money moves in this codebase.
 *
 * `ratePaisePerCredit` is set to each plan's own effective credit price, so
 * overage costs the same per unit of work as the plan does. Charging a penalty
 * rate for going over is a way to make your best customers resent you.
 */
export const ON_DEMAND = {
  free: { available: false, ratePaisePerCredit: 0, maxCreditsPerPeriod: 0 },
  /** ₹999 ÷ 2,500 credits = 40 paise. Cap doubles the plan before it stops. */
  pro: { available: true, ratePaisePerCredit: 40, maxCreditsPerPeriod: 5_000 },
  /** ₹2,999 ÷ 9,000 = 33 paise. */
  studio: { available: true, ratePaisePerCredit: 33, maxCreditsPerPeriod: 20_000 },
  /** Negotiated per contract; enforcement lives in the agreement, not here. */
  enterprise: { available: true, ratePaisePerCredit: 0, maxCreditsPerPeriod: 0 },
};

/** On-demand terms for a plan. Unknown plans get the free tier's (none). */
export function onDemandTerms(planId) {
  return ON_DEMAND[planId] || ON_DEMAND.free;
}

/**
 * Plan definitions.
 *
 * `priceMonthly` / `priceYearly` are in whole rupees. Yearly is priced at ten
 * months, the standard "two months free" anchor, and is stored rather than
 * derived so it can be tuned per tier without touching display code.
 */
export const PLANS = {
  free: {
    id: 'free',
    name: 'Hobby',
    tagline: 'Enough to plan a real project and see if this fits how you work.',
    priceMonthly: 0,
    priceYearly: 0,
    currency: 'INR',
    /**
     * Monthly allowance, reset on the billing anniversary.
     * 300 credits ≈ 4 workflows or 60 questions — enough to genuinely evaluate
     * the product. Caps our worst-case exposure at roughly ₹30 per free user
     * per month, and almost nobody spends a free allowance to the last credit.
     */
    credits: 300,
    highlight: false,
    cta: 'Start free',
    /**
     * Hard limits that exist for reasons other than cost — abuse resistance,
     * storage, and keeping the free tier from being used as a team account.
     */
    limits: {
      /** Active (non-archived) task boards. */
      taskBoards: 3,
      /** Chat sessions retained; older ones are pruned. */
      sessionRetentionDays: 7,
      /** AI requests per minute. Protects the provider chain from bursts. */
      requestsPerMinute: 5,
      /** Concurrent in-flight AI requests per user. */
      concurrentRequests: 1,
      seats: 1,
      /** Saved executable workflows. Zero, because the tier can't run them. */
      agentWorkflows: -1,
      /** Runs per billing period, on top of the credit charge. */
      agentRunsPerMonth: -1,
      /** Architect sessions per period — the expensive half of the feature. */
      agentBuildsPerMonth: -1,
      /** Runs allowed in flight at once. */
      agentConcurrency: -1,
    },
    features: {
      workflowStudio: true,
      deepDive: true,
      taskBoards: true,
      /** Tavily-backed "look beyond our catalog". Real per-call cost, so paid only. */
      webSearch: false,
      /** Cross-session semantic recall of past projects. */
      memoryRecall: false,
      exportWorkflow: false,
      prioritySupport: false,
      apiAccess: false,
      /**
       * Executable workflows — the canvas, the architect and the runner.
       *
       * Off here, and it is the one feature that genuinely cannot be sampled on
       * a free tier. Everything else the free plan includes is a bounded burst
       * of inference the user waits for; an agentic workflow is *schedulable*,
       * which means one free account with a five-minute cron can cost more in a
       * week than the entire free tier is budgeted for in a month. The credit
       * allowance alone doesn't stop that, because the run happens whether or
       * not anyone is watching.
       */
      agenticWorkflows: false,
      /** Webhook and cron triggers — unattended execution. */
      agentTriggers: false,
    },
    /**
     * Plain-English equivalents shown on the pricing page. Derived from
     * `credits` and `CREDIT_COSTS` at build time by `describePlan()` so they
     * can never drift from what the enforcement layer actually charges.
     */
    headline: ['workflow.generate', 'chat.message'],
  },

  pro: {
    id: 'pro',
    name: 'Pro',
    tagline: 'For the person who ships. Agentic workflows, real research, full history.',
    priceMonthly: 999,
    priceYearly: 9990,
    currency: 'INR',
    /** ≈33 workflows or 500 questions. ~₹250 of provider cost against ₹999. */
    credits: 2500,
    highlight: true,
    cta: 'Upgrade to Pro',
    limits: {
      taskBoards: 25,
      sessionRetentionDays: 365,
      requestsPerMinute: 20,
      concurrentRequests: 3,
      seats: 1,
      agentWorkflows: 10,
      /**
       * A run cap on top of the credit charge, because credits alone don't
       * bound concurrency or wall-clock — and a cron firing every fifteen
       * minutes would exhaust an allowance in a day, 2,880 runs deep, before
       * anyone noticed the schedule was wrong.
       */
      agentRunsPerMonth: 400,
      agentBuildsPerMonth: 60,
      agentConcurrency: 2,
    },
    features: {
      workflowStudio: true,
      deepDive: true,
      taskBoards: true,
      webSearch: true,
      memoryRecall: true,
      exportWorkflow: true,
      prioritySupport: false,
      apiAccess: false,
      agenticWorkflows: true,
      agentTriggers: true,
    },
    headline: ['workflow.generate', 'agent.run', 'chat.message'],
  },

  studio: {
    id: 'studio',
    name: 'Studio',
    tagline: 'For teams running many builds at once, with the headroom to match.',
    priceMonthly: 2999,
    priceYearly: 29990,
    currency: 'INR',
    /** ≈120 workflows or 1,800 questions. ~₹900 of cost against ₹2,999. */
    credits: 9000,
    highlight: false,
    cta: 'Upgrade to Studio',
    limits: {
      taskBoards: 0, // 0 = unlimited
      sessionRetentionDays: 0,
      requestsPerMinute: 60,
      concurrentRequests: 8,
      seats: 5,
      agentWorkflows: 100,
      agentRunsPerMonth: 3000,
      agentBuildsPerMonth: 400,
      agentConcurrency: 6,
    },
    features: {
      workflowStudio: true,
      deepDive: true,
      taskBoards: true,
      webSearch: true,
      memoryRecall: true,
      exportWorkflow: true,
      prioritySupport: true,
      apiAccess: false,
      agenticWorkflows: true,
      agentTriggers: true,
    },
    headline: ['workflow.generate', 'agent.run', 'chat.message'],
  },

  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    tagline: 'Custom volume, SSO, a private catalog and an agreement your legal team signs.',
    priceMonthly: null, // null = "Talk to us"
    priceYearly: null,
    currency: 'INR',
    credits: 0, // negotiated; assigned per account
    highlight: false,
    cta: 'Talk to us',
    limits: {
      taskBoards: 0,
      sessionRetentionDays: 0,
      requestsPerMinute: 120,
      concurrentRequests: 20,
      seats: 0,
      agentWorkflows: 0,
      agentRunsPerMonth: 0,
      agentBuildsPerMonth: 0,
      agentConcurrency: 20,
    },
    features: {
      workflowStudio: true,
      deepDive: true,
      taskBoards: true,
      webSearch: true,
      memoryRecall: true,
      exportWorkflow: true,
      prioritySupport: true,
      apiAccess: true,
      agenticWorkflows: true,
      agentTriggers: true,
    },
    headline: [],
  },
};

export const DEFAULT_PLAN_ID = 'free';

/** Never throws — an unknown or missing plan id degrades to the free tier. */
export function getPlan(planId) {
  return PLANS[planId] || PLANS[DEFAULT_PLAN_ID];
}

export function isValidPlanId(planId) {
  return Object.prototype.hasOwnProperty.call(PLANS, planId);
}

/** Credit price of an action. Unknown actions cost nothing rather than guessing. */
export function creditCost(action) {
  return CREDIT_COSTS[action] ?? 0;
}

/**
 * Feature gate. Reads the plan's flag rather than comparing tier names, so
 * granting one account an off-plan capability later is a data change, not a
 * code change.
 */
export function planAllows(planId, feature) {
  return Boolean(getPlan(planId).features?.[feature]);
}

/**
 * Numeric limit lookup. A limit of 0 means unlimited — callers must use this
 * helper rather than testing the raw number, because `0` compares as "always
 * exceeded" under a naive `used >= limit`.
 */
export function planLimit(planId, key) {
  const value = getPlan(planId).limits?.[key];
  return Number.isFinite(value) ? value : 0;
}

export function isUnlimited(planId, key) {
  return planLimit(planId, key) === 0;
}

/**
 * Turns a plan's credit allowance into the "≈ 250 workflows or 2,500 questions"
 * copy the pricing page shows.
 *
 * Computed rather than hand-written: hand-written equivalents are exactly the
 * kind of marketing copy that silently becomes a lie the first time a credit
 * price is tuned.
 */
export function describePlan(planId) {
  const plan = getPlan(planId);
  const equivalents = (plan.headline || []).map(action => ({
    action,
    label: ACTION_LABELS[action] || action,
    count: Math.floor(plan.credits / creditCost(action)),
  }));
  return { ...plan, equivalents };
}

/** Human labels for metered actions, used in the UI and the ledger. */
export const ACTION_LABELS = {
  'chat.message': 'Assistant answers',
  'chat.clarify': 'Intake questions (free)',
  'workflow.generate': 'Workflows generated',
  'workflow.refine': 'Workflow refinements',
  'workflow.deepdive': 'Stage deep dives',
  'workflow.cached': 'Instant (cached) workflows',
  'search.web': 'Web searches',
  'taskboard.create': 'Task boards created',
  'catalog.search': 'Catalog searches',
  'agent.run': 'Agentic runs',
  'agent.build': 'Architect sessions',
};

/**
 * Human labels for plan limits, so a 429/403 can name what ran out without
 * every call site inventing its own phrasing.
 */
export const LIMIT_LABELS = {
  taskBoards: 'task boards',
  seats: 'seats',
  agentWorkflows: 'saved agentic workflows',
  agentRunsPerMonth: 'agentic runs this period',
  agentBuildsPerMonth: 'architect sessions this period',
  agentConcurrency: 'agentic runs at once',
};

/**
 * Labels for audit rows that share the ledger but aren't user work.
 *
 * Kept out of ACTION_LABELS on purpose: that map defines what counts as a
 * billable action, and the user's "where your credits went" breakdown filters
 * on it. Adding these there would put "Plan changes" in someone's usage
 * receipt. The admin view falls back to this map so its tables still read
 * properly instead of showing a raw key.
 */
export const BOOKKEEPING_LABELS = {
  'plan.change': 'Plan changes (audit)',
  'credits.grant': 'Credit grants (audit)',
};

/** The whole catalog, described, for the pricing page and admin UI. */
export function listPlans() {
  return PLAN_IDS.map(describePlan);
}

/** The next tier up, for "you're out of credits — upgrade" prompts. */
export function nextPlanUp(planId) {
  const idx = PLAN_IDS.indexOf(planId);
  if (idx === -1 || idx >= PLAN_IDS.length - 1) return null;
  return PLANS[PLAN_IDS[idx + 1]];
}

export default {
  PLANS,
  PLAN_IDS,
  CREDIT_COSTS,
  TOKEN_METERED_ACTIONS,
  PAISE_PER_CREDIT,
  ON_DEMAND,
  ACTION_LABELS,
  LIMIT_LABELS,
  DEFAULT_PLAN_ID,
  MIN_ACTION_COST,
  MAX_OVERDRAFT_CREDITS,
  getPlan,
  isValidPlanId,
  creditCost,
  creditsForCost,
  meteredCost,
  onDemandTerms,
  planAllows,
  planLimit,
  isUnlimited,
  describePlan,
  listPlans,
  nextPlanUp,
};
