/**
 * Billing tests — plan catalog, credit pricing, and period arithmetic.
 *
 * No database and no LLM: everything exercised here is pure derivation from
 * the plan definitions and the calendar, which is exactly what makes it worth
 * pinning down. The parts that need Mongo (atomic spend, ledger writes) are
 * covered by the end-to-end run documented in SETUP.md.
 *
 *   npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  PLANS,
  PLAN_IDS,
  CREDIT_COSTS,
  ACTION_LABELS,
  BOOKKEEPING_LABELS,
  MIN_ACTION_COST,
  MAX_OVERDRAFT_CREDITS,
  TOKEN_METERED_ACTIONS,
  getPlan,
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
  isValidPlanId,
} from '../src/billing/plans.js';

import {
  addOneMonth,
  periodKeyFor,
  advancePeriod,
  daysRemaining,
} from '../src/billing/period.js';

import { priceForModel, llmCostPaise, searchCostPaise } from '../src/billing/pricing.js';

// ─────────────────────────────────────────────────────────────
describe('plan catalog', () => {
  test('every listed plan id resolves to a real plan', () => {
    for (const id of PLAN_IDS) {
      assert.ok(PLANS[id], `${id} missing from PLANS`);
      assert.equal(getPlan(id).id, id);
      assert.ok(isValidPlanId(id));
    }
  });

  test('an unknown plan degrades to free rather than throwing', () => {
    assert.equal(getPlan('does-not-exist').id, 'free');
    assert.equal(getPlan(undefined).id, 'free');
    assert.equal(isValidPlanId('does-not-exist'), false);
  });

  test('allowances increase monotonically across the paid tiers', () => {
    // Enterprise is negotiated per account (credits: 0), so it's excluded.
    const tiers = ['free', 'pro', 'studio'].map(id => PLANS[id].credits);
    for (let i = 1; i < tiers.length; i++) {
      assert.ok(tiers[i] > tiers[i - 1], `tier ${i} does not exceed tier ${i - 1}`);
    }
  });

  test('a paid tier never removes a capability the tier below it had', () => {
    const ordered = ['free', 'pro', 'studio', 'enterprise'];
    for (let i = 1; i < ordered.length; i++) {
      const lower = PLANS[ordered[i - 1]].features;
      const higher = PLANS[ordered[i]].features;
      for (const [feature, enabled] of Object.entries(lower)) {
        if (enabled) {
          assert.ok(
            higher[feature],
            `${ordered[i]} drops "${feature}" that ${ordered[i - 1]} includes`
          );
        }
      }
    }
  });

  test('yearly pricing is a genuine discount on twelve months', () => {
    for (const id of ['pro', 'studio']) {
      const plan = PLANS[id];
      assert.ok(
        plan.priceYearly < plan.priceMonthly * 12,
        `${id} yearly price is not a discount`
      );
    }
  });

  test('web search is paid-only — it has a real per-call cost', () => {
    assert.equal(planAllows('free', 'webSearch'), false);
    assert.equal(planAllows('pro', 'webSearch'), true);
    assert.equal(planAllows('studio', 'webSearch'), true);
  });

  test('a limit of 0 means unlimited, not "always exceeded"', () => {
    assert.equal(planLimit('studio', 'taskBoards'), 0);
    assert.equal(isUnlimited('studio', 'taskBoards'), true);
    assert.equal(isUnlimited('free', 'taskBoards'), false);
    assert.equal(planLimit('free', 'taskBoards'), 3);
  });

  test('nextPlanUp walks the ladder and stops at the top', () => {
    assert.equal(nextPlanUp('free').id, 'pro');
    assert.equal(nextPlanUp('pro').id, 'studio');
    assert.equal(nextPlanUp('studio').id, 'enterprise');
    assert.equal(nextPlanUp('enterprise'), null);
  });
});

// ─────────────────────────────────────────────────────────────
describe('credit pricing', () => {
  test('every metered action has a positive price', () => {
    for (const [action, cost] of Object.entries(CREDIT_COSTS)) {
      assert.ok(cost > 0, `${action} costs ${cost}`);
      assert.equal(Number.isInteger(cost), true, `${action} is not a whole number`);
    }
  });

  test('every metered action has a user-facing label', () => {
    for (const action of Object.keys(CREDIT_COSTS)) {
      assert.ok(ACTION_LABELS[action], `${action} has no label`);
    }
  });

  test('bookkeeping labels stay out of the billable action map', () => {
    // The user's usage breakdown filters on ACTION_LABELS, so anything in
    // BOOKKEEPING_LABELS appearing there would show "Plan changes" on a receipt.
    for (const action of Object.keys(BOOKKEEPING_LABELS)) {
      assert.equal(ACTION_LABELS[action], undefined, `${action} leaked into ACTION_LABELS`);
      assert.equal(CREDIT_COSTS[action], undefined, `${action} is priced as billable work`);
    }
  });

  test('price ordering reflects the real cost ordering of the work', () => {
    // Measured: a workflow is ~15x a question, a refine reuses playbooks, and
    // a cache hit costs almost nothing. If these invert, pricing is wrong.
    assert.ok(CREDIT_COSTS['workflow.generate'] > CREDIT_COSTS['workflow.refine']);
    assert.ok(CREDIT_COSTS['workflow.refine'] > CREDIT_COSTS['workflow.deepdive']);
    assert.ok(CREDIT_COSTS['workflow.deepdive'] > CREDIT_COSTS['workflow.cached']);
    assert.ok(CREDIT_COSTS['workflow.generate'] > CREDIT_COSTS['chat.message'] * 10);
  });

  test('an unknown action costs nothing rather than guessing a price', () => {
    assert.equal(creditCost('not.a.real.action'), 0);
  });

  test('MIN_ACTION_COST is the cheapest thing anyone can do', () => {
    const prices = Object.values(CREDIT_COSTS);
    assert.equal(MIN_ACTION_COST, Math.min(...prices));
    // The pre-flight check spends the minimum; it must be affordable on any plan.
    assert.ok(MIN_ACTION_COST <= PLANS.free.credits);
  });

  test('the overdraft clears every fixed price with room for a metered one', () => {
    // It cannot be `max(prices)` any more: token-metered actions have no fixed
    // price, and a build that settles above the overdraft would be refused
    // *after* its tokens were already spent — we'd eat the cost silently.
    assert.ok(MAX_OVERDRAFT_CREDITS > Math.max(...Object.values(CREDIT_COSTS)));
  });

  test('token-metered actions are base fees, not full prices', () => {
    for (const action of TOKEN_METERED_ACTIONS) {
      assert.ok(CREDIT_COSTS[action] > 0, `${action} has no base fee`);
      // A base fee that rivals a whole advisory workflow stops being a base fee.
      assert.ok(
        CREDIT_COSTS[action] < CREDIT_COSTS['workflow.generate'],
        `${action}'s base fee is priced like finished work`
      );
    }
  });

  test('cost converts to credits at the anchor rate, never rounding to free', () => {
    assert.equal(creditsForCost(0), 0);
    assert.equal(creditsForCost(100), 10);
    // Sub-credit spend still costs a credit: a rounding rule that bills zero
    // for real work is one a scripted client finds within a day.
    assert.equal(creditsForCost(1), 1);
    assert.equal(creditsForCost(101), 11);
  });

  test('a metered charge is the base fee plus the tokens plus any add-ons', () => {
    assert.equal(
      meteredCost('agent.run', 250, 12),
      CREDIT_COSTS['agent.run'] + 25 + 12
    );
    // A run that made no model calls still pays the base fee and nothing more.
    assert.equal(meteredCost('agent.run', 0), CREDIT_COSTS['agent.run']);
  });

  test('on-demand is off on free and priced at each plan’s own credit rate', () => {
    assert.equal(onDemandTerms('free').available, false);

    for (const id of ['pro', 'studio']) {
      const terms = onDemandTerms(id);
      const plan = PLANS[id];
      assert.equal(terms.available, true, `${id} should offer on-demand`);

      // Overage must cost what the plan costs, near enough. Charging a penalty
      // rate for going over is how you make your best customers resent you.
      const planRate = (plan.priceMonthly * 100) / plan.credits;
      assert.ok(
        Math.abs(terms.ratePaisePerCredit - planRate) <= 1,
        `${id} overage is ${terms.ratePaisePerCredit}p against a plan rate of ${planRate.toFixed(1)}p`
      );
    }
  });

  test('an unknown plan gets no on-demand rather than the last one’s terms', () => {
    assert.equal(onDemandTerms('nonsense').available, false);
  });

  test('headline equivalents are derived, never hand-written', () => {
    const free = describePlan('free');
    const workflows = free.equivalents.find(e => e.action === 'workflow.generate');
    assert.equal(
      workflows.count,
      Math.floor(PLANS.free.credits / CREDIT_COSTS['workflow.generate'])
    );
  });

  test('listPlans returns the catalog in ladder order, each described', () => {
    const listed = listPlans();
    assert.deepEqual(listed.map(p => p.id), PLAN_IDS);
    for (const plan of listed) assert.ok(Array.isArray(plan.equivalents));
  });

  test('each paid plan sells credits for more than they cost us', () => {
    // The whole model rests on this. ~₹0.10 of provider cost per credit was the
    // measured anchor; anything at or above that per-credit revenue is a loss.
    const COST_PER_CREDIT_INR = 0.1;
    for (const id of ['pro', 'studio']) {
      const plan = PLANS[id];
      const revenuePerCredit = plan.priceMonthly / plan.credits;
      assert.ok(
        revenuePerCredit > COST_PER_CREDIT_INR,
        `${id} earns ₹${revenuePerCredit.toFixed(3)}/credit against ~₹${COST_PER_CREDIT_INR} cost`
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────
describe('billing periods', () => {
  test('adding a month clamps to the target month length', () => {
    // 31 Jan + 1 month must land in February, not skip to March.
    const jan31 = new Date(Date.UTC(2026, 0, 31));
    const next = addOneMonth(jan31);
    assert.equal(next.getUTCMonth(), 1, 'did not land in February');
    assert.equal(next.getUTCDate(), 28);
  });

  test('a leap February clamps to the 29th', () => {
    const jan31 = new Date(Date.UTC(2028, 0, 31));
    const next = addOneMonth(jan31);
    assert.equal(next.getUTCMonth(), 1);
    assert.equal(next.getUTCDate(), 29);
  });

  test('a mid-month anniversary is preserved across a rollover', () => {
    const mar20 = new Date(Date.UTC(2026, 2, 20));
    const next = addOneMonth(mar20);
    assert.equal(next.getUTCMonth(), 3);
    assert.equal(next.getUTCDate(), 20);
  });

  test('the period key is derived from the period start, not from "now"', () => {
    // A period running 20 Mar → 20 Apr stays labelled 2026-03 throughout,
    // so a user's "used this period" total matches their activity list.
    const start = new Date(Date.UTC(2026, 2, 20));
    assert.equal(periodKeyFor(start), '2026-03');
  });

  test('a dormant account rolls forward to the period containing today', () => {
    // Six months idle must land in one current period, not hand out six
    // allowances one request at a time.
    const start = new Date(Date.UTC(2026, 0, 15));
    const now = new Date(Date.UTC(2026, 6, 3));
    const next = advancePeriod(start, now);

    assert.ok(next.periodStart <= now, 'period starts after now');
    assert.ok(next.periodEnd > now, 'period already ended');
    assert.equal(next.periodKey, periodKeyFor(next.periodStart));
    assert.equal(next.periodStart.getUTCDate(), 15, 'lost the billing anniversary');
  });

  test('an open period is returned unchanged', () => {
    const now = new Date(Date.UTC(2026, 2, 25));
    const start = new Date(Date.UTC(2026, 2, 20));
    const next = advancePeriod(start, now);
    assert.equal(next.periodStart.getTime(), start.getTime());
  });

  test('a corrupt far-past start still yields a usable period', () => {
    const now = new Date(Date.UTC(2026, 6, 3));
    const next = advancePeriod(new Date(Date.UTC(1971, 0, 1)), now);
    assert.ok(next.periodEnd > now);
    assert.ok(next.periodStart <= now);
  });

  test('daysRemaining never goes negative', () => {
    const past = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    assert.equal(daysRemaining(past), 0);
    const future = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    assert.ok(daysRemaining(future) >= 4 && daysRemaining(future) <= 5);
  });
});

// ─────────────────────────────────────────────────────────────
describe('provider cost model', () => {
  test('a provider-prefixed model id still matches its price entry', () => {
    const price = priceForModel('openrouter/openai/gpt-5-mini');
    assert.equal(price.matched, 'gpt-5-mini');
  });

  test('the longest matching key wins', () => {
    // "gpt-5-mini" must not be priced as the much dearer "gpt-5".
    const mini = priceForModel('openai/gpt-5-mini');
    const full = priceForModel('openai/gpt-5');
    assert.equal(mini.matched, 'gpt-5-mini');
    assert.equal(full.matched, 'gpt-5');
    assert.ok(mini.output < full.output);
  });

  test('an unpriced model falls back to a non-zero rate', () => {
    // A silent zero would make an unrecognised (often expensive) model look
    // free, exactly when you most want to notice it.
    const price = priceForModel('some-brand-new-model-v9');
    assert.equal(price.matched, null);
    assert.ok(price.input > 0 && price.output > 0);
  });

  test('cost is returned as whole paise', () => {
    const paise = llmCostPaise({ model: 'gpt-5-mini', promptTokens: 2365, completionTokens: 765 });
    assert.equal(Number.isInteger(paise), true);
    assert.ok(paise > 0);
  });

  test('a call with no tokens costs nothing', () => {
    assert.equal(llmCostPaise({ model: 'gpt-5-mini', promptTokens: 0, completionTokens: 0 }), 0);
  });

  test('output tokens are priced above input tokens', () => {
    const inputHeavy = llmCostPaise({ model: 'gpt-5-mini', promptTokens: 10000, completionTokens: 0 });
    const outputHeavy = llmCostPaise({ model: 'gpt-5-mini', promptTokens: 0, completionTokens: 10000 });
    assert.ok(outputHeavy > inputHeavy);
  });

  test('search cost scales with credits spent', () => {
    const one = searchCostPaise(1);
    const four = searchCostPaise(4);

    assert.ok(one > 0);
    assert.equal(searchCostPaise(0), 0);

    // Rounding happens once, on the total — so four credits need not equal
    // four times the rounded single-credit price, and shouldn't. Asserting
    // exact multiples would be asserting an accumulated rounding error.
    assert.ok(Math.abs(four - one * 4) <= 4, `${four} is not ~4x ${one}`);
    assert.ok(four > one);
  });
});
