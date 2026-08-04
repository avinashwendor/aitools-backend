/**
 * Billing endpoints for the account holder.
 *
 *   GET  /api/billing/plans     → the public plan catalog (no auth)
 *   GET  /api/billing/me        → plan, period, credit balance, breakdown
 *   GET  /api/billing/activity  → recent metered actions, paginated
 *   GET  /api/billing/history   → daily credit usage, for the dashboard chart
 *   POST /api/billing/upgrade   → register upgrade intent (no gateway yet)
 *   DELETE /api/billing/upgrade → withdraw a pending request
 *
 * Note what is deliberately absent: nothing here lets a user change their own
 * plan. With no payment gateway in front, a self-serve plan change would be a
 * free upgrade button. Intent is captured; an admin grants the plan.
 */

import mongoose from 'mongoose';
import { UsageLedger, UpgradeRequest } from '../models/index.js';
import { getUsageSummary, isUnmetered } from '../billing/credits.js';
import { listPlans, isValidPlanId, getPlan, ACTION_LABELS, CREDIT_COSTS } from '../billing/plans.js';
import { ApiError } from '../middleware/errorHandler.js';
import config from '../config/index.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('billing');

/**
 * GET /api/billing/plans — public.
 *
 * Serves the same catalog the enforcement layer reads, with the credit prices
 * included, so the pricing page's "≈250 workflows" copy and the middleware's
 * refusals can never describe different products.
 */
export const getPlans = async (req, res, next) => {
  try {
    res.json({
      success: true,
      data: {
        plans: listPlans(),
        creditCosts: CREDIT_COSTS,
        actionLabels: ACTION_LABELS,
        currency: 'INR',
        salesEmail: config.billing.salesEmail,
      },
    });
  } catch (error) {
    next(error);
  }
};

/** GET /api/billing/me — the dashboard's primary read. */
export const getMyBilling = async (req, res, next) => {
  try {
    const summary = await getUsageSummary(req.user);

    const pendingRequest = await UpgradeRequest.findOne({
      user: req.user._id,
      status: 'pending',
    }).select('requestedPlan billingCycle createdAt trigger');

    res.json({
      success: true,
      data: {
        ...summary,
        // Labels travel with the data so the client never hard-codes a copy of
        // the action taxonomy that can fall behind the server's.
        actionLabels: ACTION_LABELS,
        creditCosts: CREDIT_COSTS,
        pendingUpgrade: pendingRequest || null,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/billing/activity — what the credits were spent on.
 *
 * Failed and denied rows are excluded: this is the user's receipt, and a row
 * they weren't charged for only raises questions. Both remain in the admin
 * view, where they're diagnostic rather than confusing.
 */
export const getActivity = async (req, res, next) => {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);

    const filter = {
      user: req.user._id,
      denied: false,
      credits: { $gt: 0 },
    };

    const [entries, total] = await Promise.all([
      UsageLedger.find(filter)
        .sort('-createdAt')
        .skip((page - 1) * limit)
        .limit(limit)
        .select('action credits createdAt sessionId meta durationMs'),
      UsageLedger.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: {
        entries: entries.map(e => ({
          id: e._id,
          action: e.action,
          label: ACTION_LABELS[e.action] || e.action,
          credits: e.credits,
          sessionId: e.sessionId,
          durationMs: e.durationMs,
          cached: Boolean(e.meta?.cached),
          createdAt: e.createdAt,
        })),
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/billing/history — daily credit spend for the usage chart.
 *
 * Zero-filled across the whole window rather than returning only days with
 * activity: a line chart fed sparse points draws a straight line between two
 * distant days and implies usage that never happened.
 */
export const getHistory = async (req, res, next) => {
  try {
    const days = Math.min(90, Math.max(7, parseInt(req.query.days, 10) || 30));

    // Anchor the window so it *ends* on today: `days` buckets running from
    // (today - days + 1) through today inclusive. Starting `days` back and
    // filling `days` buckets forward stops one short, which silently hides the
    // current day — the one day a usage chart is most often opened to check.
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    since.setUTCDate(since.getUTCDate() - (days - 1));

    const rows = await UsageLedger.aggregate([
      {
        $match: {
          user: new mongoose.Types.ObjectId(String(req.user._id)),
          createdAt: { $gte: since },
          denied: false,
        },
      },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' } },
          credits: { $sum: '$credits' },
          actions: { $sum: 1 },
        },
      },
    ]);

    const byDate = new Map(rows.map(r => [r._id, r]));
    const series = [];

    for (let i = 0; i < days; i++) {
      const d = new Date(since.getTime() + i * 24 * 60 * 60 * 1000);
      const key = d.toISOString().slice(0, 10);
      const row = byDate.get(key);
      series.push({
        date: key,
        credits: row?.credits || 0,
        actions: row?.actions || 0,
      });
    }

    res.json({ success: true, data: { series, days } });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/billing/upgrade — register intent to move plans.
 *
 * Upserts against the partial unique index on (user, status:'pending') so
 * clicking Upgrade repeatedly updates one queue item instead of spamming the
 * admin with duplicates.
 */
export const requestUpgrade = async (req, res, next) => {
  try {
    const { plan, billingCycle = 'monthly', note = '', company = '', trigger = 'pricing_page' } = req.body;

    if (!isValidPlanId(plan)) throw new ApiError(400, 'Unknown plan.');
    if (plan === req.user.subscription?.plan) {
      throw new ApiError(400, `You're already on the ${getPlan(plan).name} plan.`);
    }

    const request = await UpgradeRequest.findOneAndUpdate(
      { user: req.user._id, status: 'pending' },
      {
        $set: {
          requestedPlan: plan,
          currentPlan: req.user.subscription?.plan || 'free',
          billingCycle: billingCycle === 'yearly' ? 'yearly' : 'monthly',
          note: String(note).slice(0, 1000),
          company: String(company).slice(0, 120),
          contactEmail: req.user.email,
          trigger: ['pricing_page', 'quota_exhausted', 'feature_locked', 'dashboard'].includes(trigger)
            ? trigger
            : 'pricing_page',
          status: 'pending',
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    log.info('Upgrade requested', {
      user: String(req.user._id),
      from: req.user.subscription?.plan,
      to: plan,
      trigger,
    });

    res.status(201).json({
      success: true,
      message:
        `Thanks — we've got your request for ${getPlan(plan).name}. ` +
        `Our team will be in touch at ${req.user.email} to get you set up.`,
      data: { request },
    });
  } catch (error) {
    next(error);
  }
};

/** DELETE /api/billing/upgrade — withdraw a pending request. */
export const cancelUpgradeRequest = async (req, res, next) => {
  try {
    const updated = await UpgradeRequest.findOneAndUpdate(
      { user: req.user._id, status: 'pending' },
      { $set: { status: 'cancelled' } },
      { new: true }
    );

    if (!updated) throw new ApiError(404, 'No pending upgrade request to cancel.');

    res.json({ success: true, message: 'Upgrade request withdrawn.' });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/billing/entitlements — compact capability map for the client.
 *
 * Lets the UI disable a locked control up front and explain why, rather than
 * offering it and surfacing a 403 after the user has committed to the action.
 */
export const getEntitlements = async (req, res, next) => {
  try {
    const plan = getPlan(req.user.subscription?.plan);
    res.json({
      success: true,
      data: {
        plan: plan.id,
        planName: plan.name,
        features: plan.features,
        limits: plan.limits,
        unmetered: isUnmetered(req.user),
      },
    });
  } catch (error) {
    next(error);
  }
};

export default {
  getPlans,
  getMyBilling,
  getActivity,
  getHistory,
  requestUpgrade,
  cancelUpgradeRequest,
  getEntitlements,
};
