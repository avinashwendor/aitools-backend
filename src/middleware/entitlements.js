/**
 * Entitlement middleware — the layer that turns a plan into a "no".
 *
 * Three distinct jobs, deliberately separate rather than one do-everything
 * gate, because they fail differently and the client has to tell them apart:
 *
 *   requireFeature  the plan doesn't include this capability at all   → 403
 *   requireCredits  the plan includes it, the allowance is spent      → 402
 *   planRateLimit   allowed and affordable, just too fast right now   → 429
 *
 * A single "denied" status would leave the UI unable to choose between
 * "upgrade to unlock", "upgrade for more" and "wait five seconds" — three
 * completely different things to say to someone.
 *
 * Every rejection carries the machine-readable `code`, the plan that would
 * lift the restriction, and enough numbers for the UI to render a real
 * explanation instead of a generic error toast.
 */

import {
  getPlan,
  planAllows,
  nextPlanUp,
  creditCost,
  MIN_ACTION_COST,
  LIMIT_LABELS,
} from '../billing/plans.js';
import {
  ensureCurrentPeriod,
  canAfford,
  balanceOf,
  allowanceOf,
  isUnmetered,
  checkLimit,
} from '../billing/credits.js';
import { rateLimit } from './rateLimit.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('entitlements');

/** Shared upgrade hint, so every 402/403 gives the client the same shape to render. */
function upgradeHint(user) {
  const current = getPlan(user.subscription?.plan);
  const next = nextPlanUp(current.id);
  if (!next) return null;
  return {
    planId: next.id,
    planName: next.name,
    priceMonthly: next.priceMonthly,
    currency: next.currency,
    credits: next.credits,
  };
}

/**
 * Refresh the user's billing period before anything reads their balance.
 *
 * Mounted ahead of the entitlement checks rather than folded into them,
 * because a stale period makes every downstream number wrong — including the
 * ones on endpoints that only *read* usage and never spend.
 */
export async function withCurrentPeriod(req, res, next) {
  if (!req.user) return next();
  try {
    req.user = await ensureCurrentPeriod(req.user);
  } catch (err) {
    // A rollover failure must not take the API down. The user keeps their
    // stale (never larger) allowance until the next request retries.
    log.warn('Period rollover failed — continuing with existing period', {
      user: String(req.user._id),
      error: err.message,
    });
  }
  next();
}

/**
 * Gate an endpoint on a plan feature flag.
 * @param {string} feature key from a plan's `features` block
 */
export function requireFeature(feature) {
  return (req, res, next) => {
    if (!req.user) return next();
    if (isUnmetered(req.user) || planAllows(req.user.subscription?.plan, feature)) return next();

    const plan = getPlan(req.user.subscription?.plan);
    return res.status(403).json({
      success: false,
      code: 'FEATURE_NOT_IN_PLAN',
      message: `${FEATURE_LABELS[feature] || 'This feature'} isn't included in the ${plan.name} plan.`,
      data: { feature, currentPlan: plan.id, upgrade: upgradeHint(req.user) },
    });
  };
}

/**
 * Refuse the request when the user can't afford it.
 *
 * `action` may be a string or a function of the request, because some
 * endpoints charge different amounts depending on the body (a deep dive is
 * fixed, a chat turn is not). When the cost genuinely can't be known until the
 * work has run — the chat pipeline doesn't know if a message is a question or
 * a workflow until the router replies — pass `estimate: 'minimum'`, which
 * checks only that the account isn't empty and leaves the real charge to the
 * controller.
 */
export function requireCredits(action, { estimate = 'exact' } = {}) {
  return (req, res, next) => {
    if (!req.user) return next();
    if (isUnmetered(req.user)) return next();

    const resolved = typeof action === 'function' ? action(req) : action;
    const cost = estimate === 'minimum' ? MIN_ACTION_COST : creditCost(resolved);

    if (canAfford(req.user, cost)) {
      // Carried so the controller charges the same action it was gated on.
      req.metering = { action: resolved, estimatedCost: cost };
      return next();
    }

    const plan = getPlan(req.user.subscription?.plan);
    log.info('Request refused for insufficient credits', {
      user: String(req.user._id),
      action: resolved,
      cost,
      balance: balanceOf(req.user),
    });

    return res.status(402).json({
      success: false,
      code: 'INSUFFICIENT_CREDITS',
      message:
        `You've used all ${allowanceOf(req.user).toLocaleString('en-IN')} credits on the ` +
        `${plan.name} plan for this period. Your allowance resets on ` +
        `${formatDate(req.user.subscription?.periodEnd)}.`,
      data: {
        action: resolved,
        required: cost,
        remaining: Math.max(0, balanceOf(req.user)),
        allowance: allowanceOf(req.user),
        currentPlan: plan.id,
        resetsAt: req.user.subscription?.periodEnd,
        upgrade: upgradeHint(req.user),
      },
    });
  };
}

/**
 * Per-minute request cap that follows the user's plan.
 *
 * Wraps the existing Redis limiter rather than replacing it, but resolves
 * `max` per request instead of once at mount time — a fixed limit would either
 * throttle Studio accounts to Hobby speed or hand Hobby accounts Studio
 * throughput, and the mount-time config can't know which user is calling.
 */
export function planRateLimit() {
  /** One limiter instance per distinct cap, built lazily and reused. */
  const limiters = new Map();

  return (req, res, next) => {
    const plan = getPlan(req.user?.subscription?.plan);
    const max = plan.limits?.requestsPerMinute || 5;

    if (!limiters.has(max)) {
      limiters.set(
        max,
        rateLimit({
          windowMs: 60_000,
          max,
          message:
            `You're sending requests faster than the ${plan.name} plan allows ` +
            `(${max}/minute). Give it a few seconds.`,
        })
      );
    }

    return limiters.get(max)(req, res, next);
  };
}

/**
 * Refuse when a countable plan cap is already reached.
 *
 * Separate from `requireCredits` because they answer different questions and
 * the client says different things about them. Credits are fungible and the
 * user can buy more of the same thing by upgrading; a cap ("10 saved
 * workflows") is structural — you delete one or you move tiers, and no amount
 * of credit balance changes the answer.
 *
 * `count` is async because every one of these is a database count the request
 * would otherwise do twice.
 *
 * @param {string} key    a key from a plan's `limits` block
 * @param {(req) => Promise<number>} count  current usage
 */
export function requireLimit(key, count) {
  return async (req, res, next) => {
    if (!req.user) return next();

    let used;
    try {
      used = await count(req);
    } catch (err) {
      // A failed count must not become a false denial — that turns a database
      // blip into "your plan says no", which is the worst possible error to
      // show someone who is paying.
      log.warn('Limit count failed — allowing request', { key, error: err.message });
      return next();
    }

    const check = checkLimit(req.user, key, used);
    if (check.allowed) return next();

    const plan = getPlan(req.user.subscription?.plan);
    const label = LIMIT_LABELS[key] || key;

    return res.status(403).json({
      success: false,
      code: 'PLAN_LIMIT_REACHED',
      message: check.limit === 0
        ? `The ${plan.name} plan doesn't include ${label}.`
        : `You've reached the ${plan.name} plan's limit of ${check.limit} ${label}.`,
      data: {
        limit: key,
        max: check.limit,
        used: check.used,
        currentPlan: plan.id,
        upgrade: upgradeHint(req.user),
      },
    });
  };
}

const FEATURE_LABELS = {
  webSearch: 'Searching the web beyond our catalog',
  agenticWorkflows: 'Agentic workflows',
  agentTriggers: 'Scheduled and webhook triggers',
  memoryRecall: 'Cross-project memory',
  exportWorkflow: 'Exporting workflows',
  deepDive: 'Stage deep dives',
  taskBoards: 'Task boards',
  apiAccess: 'API access',
  prioritySupport: 'Priority support',
};

function formatDate(date) {
  if (!date) return 'the start of your next period';
  return new Date(date).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export default {
  withCurrentPeriod,
  requireFeature,
  requireCredits,
  requireLimit,
  planRateLimit,
};
