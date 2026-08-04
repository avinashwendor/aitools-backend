/**
 * Credit engine — balance, period rollover, and spend.
 *
 * MongoDB is the source of truth here, not Redis. The cache, telemetry and
 * rate limiter all fail open into an in-process fallback because losing a
 * rate-limit counter costs nothing; losing a credit charge costs money and
 * loses the audit trail. So every balance mutation is a conditional atomic
 * update against the user document, and every one of them writes a ledger row.
 *
 * The two operations that matter:
 *
 *   spend()   atomic `$inc` guarded by a balance condition, so two concurrent
 *             requests cannot both spend the last credit. Mongo evaluates the
 *             filter and the update as one operation; a read-then-write would
 *             race, and at exactly the moment a user is most likely to be
 *             firing parallel requests (they're out of credits and retrying).
 *
 *   refund()  compensating entry when work fails after being charged. Marks
 *             the original ledger row rather than deleting it — "this was
 *             charged and then returned" and "this never happened" are
 *             different facts and only one of them is true.
 */

import mongoose from 'mongoose';
import { User, UsageLedger } from '../models/index.js';
import config from '../config/index.js';
import { createLogger } from '../utils/logger.js';
import {
  getPlan,
  creditCost,
  planLimit,
  ACTION_LABELS,
  MAX_OVERDRAFT_CREDITS,
} from './plans.js';
import { advancePeriod, daysRemaining, periodKeyFor } from './period.js';
import { summarize } from './meterContext.js';

const log = createLogger('billing:credits');

/**
 * Roll the user's billing period forward if it has elapsed.
 *
 * Lazy rather than a cron job: a scheduled reset across every user is a large
 * periodic write that has to be idempotent, monitored and re-run after any
 * outage, and it gets the answer wrong for anyone whose period boundary falls
 * during the outage. Doing it on read means a user's allowance is always
 * correct at the moment they use it, and dormant accounts cost nothing.
 *
 * The update is conditional on `periodKey` still being the stale value, so if
 * two requests arrive together only one rollover applies and the other is a
 * no-op rather than a double reset.
 *
 * @returns {Promise<object>} the user document with a current period
 */
export async function ensureCurrentPeriod(user) {
  const now = new Date();
  const start = user.subscription?.periodStart || user.createdAt || now;
  const end = user.subscription?.periodEnd;

  // Fast path: the period is still open.
  if (end && new Date(end) > now && user.subscription?.periodKey) return user;

  const next = advancePeriod(start, now);
  const plan = getPlan(user.subscription?.plan);

  const updated = await User.findOneAndUpdate(
    {
      _id: user._id,
      // Only roll if nobody else already did.
      'subscription.periodKey': user.subscription?.periodKey ?? '',
    },
    {
      $set: {
        'subscription.periodStart': next.periodStart,
        'subscription.periodEnd': next.periodEnd,
        'subscription.periodKey': next.periodKey,
        'credits.included': plan.credits,
        'credits.used': 0,
      },
    },
    { new: true }
  );

  if (updated) {
    log.info('Billing period rolled over', {
      user: String(user._id),
      period: next.periodKey,
      plan: plan.id,
      allowance: plan.credits,
    });
    return updated;
  }

  // Someone else rolled it first — re-read rather than trusting our stale copy.
  return (await User.findById(user._id)) || user;
}

/** Total credits available this period. */
export function allowanceOf(user) {
  return (user.credits?.included || 0) + (user.credits?.bonus || 0);
}

/** Credits left. Can go negative by at most one action (see MAX_OVERDRAFT_CREDITS). */
export function balanceOf(user) {
  return allowanceOf(user) - (user.credits?.used || 0);
}

/**
 * Can this user afford `cost` credits right now?
 *
 * Enterprise accounts and any plan with a 0 allowance configured as unlimited
 * are handled by `isUnmetered`. Soft-limit mode lets everyone through and
 * relies on the ledger for after-the-fact visibility.
 */
export function canAfford(user, cost) {
  if (isUnmetered(user)) return true;
  if (config.billing.softLimits) return true;
  return balanceOf(user) >= cost;
}

/**
 * Accounts that are never blocked: enterprise (volume is negotiated per
 * contract, not enforced in code) and admins (locking the operator out of
 * their own product because they tested it too much is a bad afternoon).
 */
export function isUnmetered(user) {
  return user?.role === 'admin' || user?.subscription?.plan === 'enterprise';
}

/**
 * Atomically spend credits and record the action.
 *
 * @param {object}  opts
 * @param {object}  opts.user       the authenticated user document
 * @param {string}  opts.action     metered action key from `plans.js`
 * @param {number} [opts.cost]      override the action's list price
 * @param {object} [opts.usage]     live accumulator from `meterContext`
 * @param {string} [opts.sessionId]
 * @param {object} [opts.meta]
 * @param {boolean}[opts.allowOverdraft] permit dipping below zero by one action
 *
 * @returns {Promise<{ok:boolean, ledgerId?:string, balance:number, charged:number, reason?:string}>}
 *   `ok:false` means the balance check failed and nothing was charged. The
 *   caller must not perform the work.
 */
export async function spend({
  user,
  action,
  cost = null,
  usage = null,
  sessionId = null,
  meta = {},
  allowOverdraft = false,
}) {
  const charge = cost === null ? creditCost(action) : Number(cost);
  const plan = getPlan(user.subscription?.plan);
  const periodKey = user.subscription?.periodKey || periodKeyFor(new Date());
  const summary = summarize(usage);

  // Free actions and unmetered accounts still get a ledger row — the admin
  // cost view has to see what an admin's testing costs us, and a zero-credit
  // action can still burn real tokens.
  const metered = charge > 0 && !isUnmetered(user) && !config.billing.softLimits;

  if (!metered) {
    const entry = await writeLedger({
      user, action, credits: 0, charge: 0, plan: plan.id, periodKey,
      sessionId, summary, meta: { ...meta, unmetered: isUnmetered(user) || undefined },
    });
    return { ok: true, ledgerId: entry?._id, balance: balanceOf(user), charged: 0 };
  }

  // The balance condition, evaluated server-side as part of the write.
  // `$expr` lets us compare two fields of the same document, which a plain
  // filter cannot do — this is what makes the check-and-spend atomic.
  const ceiling = allowOverdraft ? MAX_OVERDRAFT_CREDITS : 0;
  const updated = await User.findOneAndUpdate(
    {
      _id: user._id,
      $expr: {
        $lte: [
          { $add: ['$credits.used', charge] },
          { $add: ['$credits.included', '$credits.bonus', ceiling] },
        ],
      },
    },
    {
      $inc: {
        'credits.used': charge,
        'credits.lifetimeUsed': charge,
      },
    },
    { new: true }
  );

  if (!updated) {
    // Record the refusal: demand turned away by plan limits is the clearest
    // upgrade signal there is, and it's invisible if you only log successes.
    await writeLedger({
      user, action, credits: 0, charge, plan: plan.id, periodKey,
      sessionId, summary, denied: true, meta,
    });

    log.info('Credit check failed', {
      user: String(user._id),
      action,
      charge,
      balance: balanceOf(user),
      plan: plan.id,
    });

    return {
      ok: false,
      balance: balanceOf(user),
      charged: 0,
      reason: 'INSUFFICIENT_CREDITS',
    };
  }

  const entry = await writeLedger({
    user, action, credits: charge, charge, plan: plan.id, periodKey,
    sessionId, summary, meta,
  });

  return {
    ok: true,
    ledgerId: entry?._id,
    balance: balanceOf(updated),
    charged: charge,
  };
}

/**
 * Record an action that burned real provider cost but delivered nothing.
 *
 * Metered endpoints charge *after* the work succeeds, so a failure costs the
 * user zero credits — that part needs no compensating entry. But the tokens
 * were still spent, and a cost view that only counts successful actions will
 * under-report exactly when something is going wrong: a provider erroring
 * after generation, or a repair loop retrying an unparseable response.
 *
 * So failures get a ledger row at zero credits with the true cost attached.
 * `meta.failed` keeps them out of the user's activity feed while leaving them
 * fully visible in the admin spend total.
 */
export async function recordFailure({ user, action, usage = null, sessionId = null, reason = '', meta = {} }) {
  const plan = getPlan(user.subscription?.plan);
  const summary = summarize(usage);

  // Nothing was spent and nothing was charged — not worth a row.
  if (!summary.cost.totalPaise && !summary.llmCalls) return null;

  return writeLedger({
    user,
    action,
    credits: 0,
    charge: 0,
    plan: plan.id,
    periodKey: user.subscription?.periodKey || periodKeyFor(new Date()),
    sessionId,
    summary,
    meta: { ...meta, failed: true, reason: String(reason).slice(0, 200) },
  });
}

/** Grant credits outside the plan allowance (admin top-up, goodwill, promo). */
export async function grantBonus({ userId, credits, grantedBy = null, note = '' }) {
  const amount = Math.max(0, Math.round(Number(credits) || 0));
  if (!amount) return null;

  const updated = await User.findByIdAndUpdate(
    userId,
    { $inc: { 'credits.bonus': amount } },
    { new: true }
  );
  if (!updated) return null;

  await UsageLedger.create({
    user: userId,
    action: 'credits.grant',
    credits: 0,
    creditsOriginal: 0,
    plan: updated.subscription?.plan || 'free',
    periodKey: updated.subscription?.periodKey || periodKeyFor(new Date()),
    meta: { granted: amount, grantedBy: grantedBy ? String(grantedBy) : null, note },
  }).catch(err => log.warn('Failed to log bonus grant', { error: err.message }));

  log.info('Bonus credits granted', { user: String(userId), credits: amount });
  return updated;
}

/**
 * Move a user onto a different plan.
 *
 * Deliberately resets the allowance and opens a fresh period rather than
 * pro-rating: with no payment gateway there's no money to pro-rate against,
 * and "your new plan starts now with a full allowance" is both simpler and
 * more generous than any partial-month arithmetic we'd have to explain.
 */
export async function changePlan({ userId, planId, cycle = 'monthly', changedBy = null, note = '' }) {
  const plan = getPlan(planId);
  const now = new Date();
  const next = advancePeriod(now, now);

  const before = await User.findById(userId).select('subscription credits');
  if (!before) return null;

  const updated = await User.findByIdAndUpdate(
    userId,
    {
      $set: {
        'subscription.plan': plan.id,
        'subscription.status': 'active',
        'subscription.billingCycle': cycle === 'yearly' ? 'yearly' : 'monthly',
        'subscription.periodStart': next.periodStart,
        'subscription.periodEnd': next.periodEnd,
        'subscription.periodKey': next.periodKey,
        'subscription.cancelAtPeriodEnd': false,
        'subscription.assignedBy': changedBy,
        'subscription.assignedAt': now,
        'subscription.note': note,
        'credits.included': plan.credits,
        'credits.used': 0,
      },
    },
    { new: true }
  );

  await UsageLedger.create({
    user: userId,
    action: 'plan.change',
    credits: 0,
    creditsOriginal: 0,
    plan: plan.id,
    periodKey: next.periodKey,
    meta: {
      from: before.subscription?.plan || 'free',
      to: plan.id,
      cycle,
      changedBy: changedBy ? String(changedBy) : null,
      note,
    },
  }).catch(err => log.warn('Failed to log plan change', { error: err.message }));

  log.info('Plan changed', {
    user: String(userId),
    from: before.subscription?.plan,
    to: plan.id,
    allowance: plan.credits,
  });

  return updated;
}

/**
 * Everything the user dashboard needs about the current period, in one read.
 *
 * The per-action breakdown comes from the ledger rather than from counters on
 * the user document: counters would need a new field for every action we ever
 * meter, and could drift from the ledger with no way to tell which was right.
 */
export async function getUsageSummary(user) {
  const current = await ensureCurrentPeriod(user);
  const plan = getPlan(current.subscription?.plan);
  const periodKey = current.subscription?.periodKey;

  const [byAction] = await Promise.all([
    UsageLedger.aggregate([
      {
        $match: {
          user: new mongoose.Types.ObjectId(String(current._id)),
          periodKey,
          denied: false,
        },
      },
      {
        $group: {
          _id: '$action',
          count: { $sum: 1 },
          credits: { $sum: '$credits' },
        },
      },
      { $sort: { credits: -1 } },
    ]),
  ]);

  const allowance = allowanceOf(current);
  const used = current.credits?.used || 0;

  return {
    plan: {
      id: plan.id,
      name: plan.name,
      priceMonthly: plan.priceMonthly,
      priceYearly: plan.priceYearly,
      currency: plan.currency,
      features: plan.features,
      limits: plan.limits,
    },
    subscription: {
      status: current.subscription?.status || 'active',
      billingCycle: current.subscription?.billingCycle || 'monthly',
      periodStart: current.subscription?.periodStart,
      periodEnd: current.subscription?.periodEnd,
      periodKey,
      cancelAtPeriodEnd: Boolean(current.subscription?.cancelAtPeriodEnd),
      daysRemaining: daysRemaining(current.subscription?.periodEnd || new Date()),
    },
    credits: {
      included: current.credits?.included || 0,
      bonus: current.credits?.bonus || 0,
      allowance,
      used,
      remaining: Math.max(0, allowance - used),
      // Clamped so a rounding artefact can't render a 101%-full meter.
      percentUsed: allowance ? Math.min(100, Math.round((used / allowance) * 100)) : 0,
      unmetered: isUnmetered(current),
      lifetimeUsed: current.credits?.lifetimeUsed || 0,
    },
    // Bookkeeping rows (`plan.change`, `credits.grant`) live in the same
    // collection so the audit trail is in one place, but they aren't work the
    // user asked for — showing them under "where your credits went" is just
    // confusing, and they have no label to render. Anything without an entry in
    // ACTION_LABELS is bookkeeping by definition.
    breakdown: byAction
      .filter(a => ACTION_LABELS[a._id])
      .map(a => ({
        action: a._id,
        count: a.count,
        credits: a.credits,
      })),
  };
}

/**
 * Whether a countable resource is still under its plan cap.
 * @returns {{allowed:boolean, limit:number, used:number, unlimited:boolean}}
 */
export function checkLimit(user, key, currentCount) {
  const limit = planLimit(user.subscription?.plan, key);
  const unlimited = limit === 0 || isUnmetered(user);
  return {
    allowed: unlimited || currentCount < limit,
    limit,
    used: currentCount,
    unlimited,
  };
}

/** Write one ledger row. Never throws — accounting must not break the request. */
async function writeLedger({
  user, action, credits, charge, plan, periodKey,
  sessionId = null, summary, denied = false, meta = {},
}) {
  try {
    return await UsageLedger.create({
      user: user._id,
      action,
      credits,
      creditsOriginal: charge,
      plan,
      periodKey,
      sessionId,
      denied,
      cost: summary.cost,
      tokens: summary.tokens,
      models: summary.models,
      searchCalls: summary.searchCalls,
      durationMs: summary.durationMs,
      meta,
    });
  } catch (err) {
    log.error('Failed to write ledger row', { action, user: String(user._id), error: err.message });
    return null;
  }
}

export default {
  ensureCurrentPeriod,
  allowanceOf,
  balanceOf,
  canAfford,
  isUnmetered,
  spend,
  recordFailure,
  grantBonus,
  changePlan,
  getUsageSummary,
  checkLimit,
};
