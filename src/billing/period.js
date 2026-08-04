/**
 * Billing period arithmetic.
 *
 * Periods are anchored to the account's signup day, not to the 1st of the
 * calendar month: someone who subscribes on the 20th should get a full month,
 * and resetting everyone's allowance at midnight on the 1st also concentrates
 * every rollover into one spike.
 *
 * Kept dependency-free (no models, no config) so both the User model and the
 * credit engine can import it without a cycle.
 */

/**
 * Add one calendar month, clamping the day to the target month's length.
 *
 * Naive `setMonth(+1)` on the 31st of January lands in March, silently giving
 * that user a two-month period. Clamping to the 28th of February is the
 * behaviour every billing system converges on.
 */
export function addOneMonth(date) {
  const d = new Date(date);
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()));
  const daysInTarget = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, daysInTarget));
  return target;
}

/** Add twelve months, clamping the same way (matters only for Feb 29). */
export function addOneYear(date) {
  const d = new Date(date);
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear() + 1, d.getUTCMonth(), 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()));
  const daysInTarget = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, daysInTarget));
  return target;
}

/**
 * Stable label for a period, used as the ledger's grouping key.
 *
 * Derived from the period *start*, so a period running 20 Mar → 20 Apr is
 * labelled "2026-03" throughout. Grouping ledger rows by their own timestamps
 * instead would split a single period across two labels and make the user's
 * "used this period" total disagree with their activity list.
 */
export function periodKeyFor(date) {
  const d = new Date(date);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Roll a period forward until it contains `now`.
 *
 * Loops rather than adding a single month because an account dormant for
 * several months would otherwise come back with a period that is still stale
 * after one rollover — and would then be handed several months of allowance
 * one request at a time. Bounded at 120 iterations so a corrupt date can't
 * spin forever; past that we simply restart the period at `now`.
 */
export function advancePeriod(periodStart, now = new Date()) {
  let start = new Date(periodStart);
  let end = addOneMonth(start);
  let guard = 0;

  while (end <= now && guard++ < 120) {
    start = end;
    end = addOneMonth(start);
  }

  if (end <= now) {
    start = new Date(now);
    end = addOneMonth(start);
  }

  return { periodStart: start, periodEnd: end, periodKey: periodKeyFor(start) };
}

/** Whole days left in the current period, floored at 0. */
export function daysRemaining(periodEnd, now = new Date()) {
  const ms = new Date(periodEnd).getTime() - now.getTime();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

export default { addOneMonth, addOneYear, periodKeyFor, advancePeriod, daysRemaining };
