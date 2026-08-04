/**
 * Admin billing & cost analytics.
 *
 * The question this exists to answer is "what is this product costing me and
 * who is spending it" — and specifically, cost split by *source*: LLM tokens
 * are one bill, Tavily search is another, and they scale with completely
 * different things. A single blended number hides which one is running away.
 *
 * All money is stored and aggregated in integer paise (see billing/pricing.js)
 * and converted to rupees only at the response boundary. Aggregating floats
 * across a hundred thousand ledger rows is how totals stop reconciling.
 *
 *   GET   /api/admin/billing/overview   → revenue, spend, margin, plan mix
 *   GET   /api/admin/billing/timeseries → daily credits + cost, split by source
 *   GET   /api/admin/billing/users      → per-user usage and cost, sortable
 *   GET   /api/admin/billing/actions    → cost per action type
 *   GET   /api/admin/billing/requests   → upgrade queue
 *   POST  /api/admin/billing/requests/:id/approve|reject
 *   PUT   /api/admin/billing/users/:id/plan    → assign a plan
 *   POST  /api/admin/billing/users/:id/credits → grant bonus credits
 */

import { User, UsageLedger, UpgradeRequest } from '../models/index.js';
import { changePlan, grantBonus } from '../billing/credits.js';
import {
  getPlan, isValidPlanId, listPlans,
  ACTION_LABELS, BOOKKEEPING_LABELS, PLAN_IDS,
} from '../billing/plans.js';
import { getSearchBudget } from '../ai/tools/webSearch.js';
import { ApiError } from '../middleware/errorHandler.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('admin:billing');

const paiseToRupees = p => Math.round((Number(p) || 0)) / 100;

/**
 * Window helper — `?days=30` on every analytics endpoint, clamped and defaulted.
 *
 * The window ends on today: `days` buckets running from (today - days + 1)
 * through today inclusive. Anchoring `days` back and then filling `days`
 * buckets forward lands one short and drops the current day, which is exactly
 * the day someone opens a cost dashboard to look at.
 */
function windowFrom(req, fallback = 30) {
  const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || fallback));
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  since.setUTCDate(since.getUTCDate() - (days - 1));
  return { days, since };
}

/**
 * GET /api/admin/billing/overview
 *
 * Revenue here is *contracted* MRR — the list price of every active paid plan.
 * With no gateway wired up nothing has actually been collected, so the response
 * labels it `committed` rather than passing it off as cash received.
 */
export const getOverview = async (req, res, next) => {
  try {
    const { days, since } = windowFrom(req);

    const [planMix, spend, deniedCount, searchBudget, pendingRequests, activeUsers] = await Promise.all([
      User.aggregate([
        { $match: { isActive: true } },
        { $group: { _id: '$subscription.plan', users: { $sum: 1 } } },
      ]),

      UsageLedger.aggregate([
        { $match: { createdAt: { $gte: since } } },
        {
          $group: {
            _id: null,
            credits: { $sum: '$credits' },
            llmPaise: { $sum: '$cost.llmPaise' },
            searchPaise: { $sum: '$cost.searchPaise' },
            totalPaise: { $sum: '$cost.totalPaise' },
            promptTokens: { $sum: '$tokens.prompt' },
            completionTokens: { $sum: '$tokens.completion' },
            searchCalls: { $sum: '$searchCalls' },
            actions: { $sum: 1 },
          },
        },
      ]),

      // Requests turned away by plan limits — the upgrade-demand signal.
      UsageLedger.countDocuments({ createdAt: { $gte: since }, denied: true }),

      getSearchBudget(),
      UpgradeRequest.countDocuments({ status: 'pending' }),

      // Distinct users who actually did something billable in the window.
      UsageLedger.distinct('user', { createdAt: { $gte: since }, credits: { $gt: 0 } }),
    ]);

    const mix = new Map(planMix.map(p => [p._id || 'free', p.users]));

    let committedMonthlyPaise = 0;
    const plans = PLAN_IDS.map(id => {
      const plan = getPlan(id);
      const users = mix.get(id) || 0;
      const monthlyPaise = (plan.priceMonthly || 0) * 100 * users;
      committedMonthlyPaise += monthlyPaise;
      return {
        id,
        name: plan.name,
        users,
        priceMonthly: plan.priceMonthly,
        monthlyRevenue: paiseToRupees(monthlyPaise),
      };
    });

    const s = spend[0] || {};
    const totalCostPaise = s.totalPaise || 0;
    const marginPaise = committedMonthlyPaise - totalCostPaise;

    res.json({
      success: true,
      data: {
        windowDays: days,

        revenue: {
          /** List price of active paid plans. Not money received — no gateway yet. */
          committedMrr: paiseToRupees(committedMonthlyPaise),
          currency: 'INR',
          collected: null,
          note: 'Committed MRR from assigned plans. No payment gateway is connected yet.',
        },

        // The split the operator actually needs: which bill is growing.
        spend: {
          llm: paiseToRupees(s.llmPaise),
          search: paiseToRupees(s.searchPaise),
          total: paiseToRupees(totalCostPaise),
          promptTokens: s.promptTokens || 0,
          completionTokens: s.completionTokens || 0,
          totalTokens: (s.promptTokens || 0) + (s.completionTokens || 0),
          searchCalls: s.searchCalls || 0,
        },

        margin: {
          amount: paiseToRupees(marginPaise),
          percent: committedMonthlyPaise
            ? Math.round((marginPaise / committedMonthlyPaise) * 100)
            : null,
        },

        usage: {
          creditsSpent: s.credits || 0,
          actions: s.actions || 0,
          activeUsers: activeUsers.length,
          deniedRequests: deniedCount,
          /** Average provider cost per billable action, in rupees. */
          costPerAction: s.actions ? paiseToRupees(totalCostPaise / s.actions) : 0,
        },

        plans,

        /** Tavily's monthly credit pool against the configured cap. */
        searchBudget,

        pendingUpgradeRequests: pendingRequests,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/admin/billing/timeseries — daily credits and cost, split by source.
 * Zero-filled so the chart can't imply activity on days that had none.
 */
export const getTimeseries = async (req, res, next) => {
  try {
    const { days, since } = windowFrom(req);

    const rows = await UsageLedger.aggregate([
      { $match: { createdAt: { $gte: since } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' } },
          credits: { $sum: '$credits' },
          llmPaise: { $sum: '$cost.llmPaise' },
          searchPaise: { $sum: '$cost.searchPaise' },
          actions: { $sum: 1 },
          denied: { $sum: { $cond: ['$denied', 1, 0] } },
        },
      },
    ]);

    const byDate = new Map(rows.map(r => [r._id, r]));
    const series = [];

    for (let i = 0; i < days; i++) {
      const d = new Date(since.getTime() + i * 24 * 60 * 60 * 1000);
      const key = d.toISOString().slice(0, 10);
      const r = byDate.get(key);
      series.push({
        date: key,
        credits: r?.credits || 0,
        llmCost: paiseToRupees(r?.llmPaise),
        searchCost: paiseToRupees(r?.searchPaise),
        totalCost: paiseToRupees((r?.llmPaise || 0) + (r?.searchPaise || 0)),
        actions: r?.actions || 0,
        denied: r?.denied || 0,
      });
    }

    res.json({ success: true, data: { series, days } });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/admin/billing/users — per-user cost table.
 *
 * Sorted by provider cost by default, not by credits: the user costing the
 * most real money is the one worth looking at, and thanks to caching and
 * cheap-model routing that isn't always the user who spent the most credits.
 */
export const getUserUsage = async (req, res, next) => {
  try {
    const { days, since } = windowFrom(req);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);

    const sortField = { cost: 'totalPaise', credits: 'credits', actions: 'actions' }[req.query.sort] || 'totalPaise';

    const pipeline = [
      { $match: { createdAt: { $gte: since } } },
      {
        $group: {
          _id: '$user',
          credits: { $sum: '$credits' },
          totalPaise: { $sum: '$cost.totalPaise' },
          llmPaise: { $sum: '$cost.llmPaise' },
          searchPaise: { $sum: '$cost.searchPaise' },
          actions: { $sum: 1 },
          denied: { $sum: { $cond: ['$denied', 1, 0] } },
          lastActive: { $max: '$createdAt' },
        },
      },
      { $sort: { [sortField]: -1 } },
      { $skip: (page - 1) * limit },
      { $limit: limit },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'user',
          pipeline: [{ $project: { name: 1, email: 1, subscription: 1, credits: 1, role: 1 } }],
        },
      },
      { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
    ];

    const [rows, totalUsers] = await Promise.all([
      UsageLedger.aggregate(pipeline),
      UsageLedger.distinct('user', { createdAt: { $gte: since } }),
    ]);

    res.json({
      success: true,
      data: {
        users: rows.map(r => {
          const plan = getPlan(r.user?.subscription?.plan);
          const allowance = (r.user?.credits?.included || 0) + (r.user?.credits?.bonus || 0);
          const used = r.user?.credits?.used || 0;
          // Revenue is a monthly figure; comparing it to an arbitrary window's
          // cost would be meaningless, so margin is only reported at 30 days.
          const revenuePaise = (plan.priceMonthly || 0) * 100;

          return {
            id: r._id,
            name: r.user?.name || 'Deleted user',
            email: r.user?.email || '—',
            role: r.user?.role || 'user',
            plan: plan.id,
            planName: plan.name,
            creditsUsedInWindow: r.credits,
            creditsUsedThisPeriod: used,
            allowance,
            percentUsed: allowance ? Math.min(100, Math.round((used / allowance) * 100)) : 0,
            cost: {
              llm: paiseToRupees(r.llmPaise),
              search: paiseToRupees(r.searchPaise),
              total: paiseToRupees(r.totalPaise),
            },
            monthlyRevenue: plan.priceMonthly || 0,
            margin: days === 30 ? paiseToRupees(revenuePaise - r.totalPaise) : null,
            actions: r.actions,
            denied: r.denied,
            lastActive: r.lastActive,
          };
        }),
        pagination: {
          page,
          limit,
          total: totalUsers.length,
          pages: Math.ceil(totalUsers.length / limit),
        },
        windowDays: days,
      },
    });
  } catch (error) {
    next(error);
  }
};

/** GET /api/admin/billing/actions — where the money goes, by action type. */
export const getActionBreakdown = async (req, res, next) => {
  try {
    const { days, since } = windowFrom(req);

    const rows = await UsageLedger.aggregate([
      { $match: { createdAt: { $gte: since }, denied: false } },
      {
        $group: {
          _id: '$action',
          count: { $sum: 1 },
          credits: { $sum: '$credits' },
          llmPaise: { $sum: '$cost.llmPaise' },
          searchPaise: { $sum: '$cost.searchPaise' },
          totalPaise: { $sum: '$cost.totalPaise' },
          avgDurationMs: { $avg: '$durationMs' },
          failed: { $sum: { $cond: ['$meta.failed', 1, 0] } },
        },
      },
      { $sort: { totalPaise: -1 } },
    ]);

    res.json({
      success: true,
      data: {
        windowDays: days,
        actions: rows.map(r => ({
          action: r._id,
          label: ACTION_LABELS[r._id] || BOOKKEEPING_LABELS[r._id] || r._id,
          count: r.count,
          credits: r.credits,
          cost: {
            llm: paiseToRupees(r.llmPaise),
            search: paiseToRupees(r.searchPaise),
            total: paiseToRupees(r.totalPaise),
          },
          /** What one of these actually costs us — the number that sets its credit price. */
          avgCost: r.count ? paiseToRupees(r.totalPaise / r.count) : 0,
          avgDurationMs: Math.round(r.avgDurationMs || 0),
          failed: r.failed,
        })),
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/admin/billing/models — spend per model.
 * Shows which member of the failover chain is actually serving traffic, and
 * what that routing is costing.
 */
export const getModelBreakdown = async (req, res, next) => {
  try {
    const { days, since } = windowFrom(req);

    const rows = await UsageLedger.aggregate([
      { $match: { createdAt: { $gte: since }, 'models.0': { $exists: true } } },
      { $unwind: '$models' },
      {
        $group: {
          _id: '$models.model',
          calls: { $sum: '$models.calls' },
          // Rows can span several models; this attributes the row's whole LLM
          // cost to each model that appeared on it, so treat per-model cost as
          // indicative of routing share rather than an exact per-model bill.
          approxPaise: { $sum: '$cost.llmPaise' },
        },
      },
      { $sort: { calls: -1 } },
      { $limit: 20 },
    ]);

    res.json({
      success: true,
      data: {
        windowDays: days,
        models: rows.map(r => ({
          model: r._id,
          calls: r.calls,
          approxCost: paiseToRupees(r.approxPaise),
        })),
        note: 'Cost is attributed per row; rows using several models count toward each.',
      },
    });
  } catch (error) {
    next(error);
  }
};

/** GET /api/admin/billing/requests — the upgrade queue. */
export const getUpgradeRequests = async (req, res, next) => {
  try {
    const status = ['pending', 'approved', 'rejected', 'cancelled'].includes(req.query.status)
      ? req.query.status
      : 'pending';

    const requests = await UpgradeRequest.find({ status })
      .sort('-createdAt')
      .limit(100)
      .populate('user', 'name email subscription credits')
      .populate('reviewedBy', 'name email');

    res.json({ success: true, data: { requests, status } });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /api/admin/billing/requests/:id/approve
 * Approving both grants the plan and closes the request, so the two can't
 * drift apart into "approved but still on free".
 */
export const approveUpgradeRequest = async (req, res, next) => {
  try {
    const request = await UpgradeRequest.findById(req.params.id);
    if (!request) throw new ApiError(404, 'Upgrade request not found.');
    if (request.status !== 'pending') throw new ApiError(400, 'That request has already been reviewed.');

    const updated = await changePlan({
      userId: request.user,
      planId: request.requestedPlan,
      cycle: request.billingCycle,
      changedBy: req.user._id,
      note: req.body?.note || `Approved upgrade request ${request._id}`,
    });

    if (!updated) throw new ApiError(404, 'The requesting user no longer exists.');

    request.status = 'approved';
    request.reviewedBy = req.user._id;
    request.reviewedAt = new Date();
    request.reviewNote = String(req.body?.note || '').slice(0, 1000);
    await request.save();

    log.info('Upgrade approved', {
      user: String(request.user),
      plan: request.requestedPlan,
      by: String(req.user._id),
    });

    res.json({
      success: true,
      message: `${updated.name} is now on the ${getPlan(request.requestedPlan).name} plan.`,
      data: { request, user: updated },
    });
  } catch (error) {
    next(error);
  }
};

/** POST /api/admin/billing/requests/:id/reject */
export const rejectUpgradeRequest = async (req, res, next) => {
  try {
    const request = await UpgradeRequest.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          status: 'rejected',
          reviewedBy: req.user._id,
          reviewedAt: new Date(),
          reviewNote: String(req.body?.note || '').slice(0, 1000),
        },
      },
      { new: true }
    );

    if (!request) throw new ApiError(404, 'Upgrade request not found.');
    res.json({ success: true, message: 'Request rejected.', data: { request } });
  } catch (error) {
    next(error);
  }
};

/** PUT /api/admin/billing/users/:id/plan — assign a plan directly. */
export const assignPlan = async (req, res, next) => {
  try {
    const { plan, billingCycle = 'monthly', note = '' } = req.body;
    if (!isValidPlanId(plan)) throw new ApiError(400, 'Unknown plan.');

    const updated = await changePlan({
      userId: req.params.id,
      planId: plan,
      cycle: billingCycle,
      changedBy: req.user._id,
      note: String(note).slice(0, 500),
    });

    if (!updated) throw new ApiError(404, 'User not found.');

    res.json({
      success: true,
      message: `${updated.name} moved to ${getPlan(plan).name}.`,
      data: { user: updated },
    });
  } catch (error) {
    next(error);
  }
};

/** POST /api/admin/billing/users/:id/credits — grant bonus credits. */
export const grantCredits = async (req, res, next) => {
  try {
    const credits = Math.round(Number(req.body?.credits) || 0);
    if (credits <= 0 || credits > 1_000_000) {
      throw new ApiError(400, 'Grant a positive number of credits (up to 1,000,000).');
    }

    const updated = await grantBonus({
      userId: req.params.id,
      credits,
      grantedBy: req.user._id,
      note: String(req.body?.note || '').slice(0, 500),
    });

    if (!updated) throw new ApiError(404, 'User not found.');

    res.json({
      success: true,
      message: `Granted ${credits.toLocaleString('en-IN')} credits to ${updated.name}.`,
      data: { user: updated },
    });
  } catch (error) {
    next(error);
  }
};

/** GET /api/admin/billing/plans — catalog, for the plan-assignment dropdown. */
export const getPlanCatalog = async (req, res, next) => {
  try {
    res.json({ success: true, data: { plans: listPlans() } });
  } catch (error) {
    next(error);
  }
};

export default {
  getOverview,
  getTimeseries,
  getUserUsage,
  getActionBreakdown,
  getModelBreakdown,
  getUpgradeRequests,
  approveUpgradeRequest,
  rejectUpgradeRequest,
  assignPlan,
  grantCredits,
  getPlanCatalog,
};
