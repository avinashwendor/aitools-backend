/**
 * Turning a workflow into a dated plan.
 *
 * Entirely deterministic — scheduling is arithmetic over the stage estimates
 * the planner already produced, and running it through a model would make it
 * slower, more expensive and less predictable for no gain.
 *
 * Two directions, because users arrive with one of two constraints:
 *   - "I have ~6 hours a week"  → work out when it lands
 *   - "It has to ship by the 20th" → work out the hours a week that needs
 */

/** Assume a working week, so a 5-hour plan doesn't get spread over Sunday. */
const WORKING_DAYS = [1, 2, 3, 4, 5];

const DAY_MS = 86_400_000;

const startOfDay = date => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
};

const isWorkingDay = date => WORKING_DAYS.includes(date.getDay());

/** Next working day at or after `date`. */
function nextWorkingDay(date) {
  const d = startOfDay(date);
  while (!isWorkingDay(d)) d.setDate(d.getDate() + 1);
  return d;
}

/** Working days in [from, to], inclusive — used to solve for required capacity. */
export function countWorkingDays(from, to) {
  let count = 0;
  const cursor = startOfDay(from);
  const end = startOfDay(to);

  while (cursor <= end) {
    if (isWorkingDay(cursor)) count++;
    cursor.setDate(cursor.getDate() + 1);
  }
  return count;
}

/**
 * Assign a due date to every task, in order, respecting a daily time budget.
 *
 * Tasks are never split across days: a stage is one sitting, and telling
 * someone to do "40% of the voiceover today" is not a plan they can act on.
 * A task larger than the daily budget simply takes its own day.
 *
 * @param {Array<{order:number, estimateMinutes:number, status:string}>} tasks
 * @param {object} opts
 * @param {Date}   [opts.targetDate]  deadline; capacity is solved to hit it
 * @param {number} [opts.weeklyHours] available hours per week
 * @param {Date}   [opts.from]        defaults to today
 * @param {number} [opts.estimateBias] multiplier from the user's own history
 * @returns {{dueDates: Map<number, Date>, weeklyHours: number, finishDate: Date|null,
 *            totalMinutes: number, feasible: boolean}}
 */
export function scheduleTasks(tasks, { targetDate, weeklyHours, from = new Date(), estimateBias = 1 } = {}) {
  const pending = [...tasks]
    .filter(t => t.status !== 'done')
    .sort((a, b) => a.order - b.order);

  const bias = Number.isFinite(estimateBias) && estimateBias > 0 ? estimateBias : 1;
  const minutesFor = task => Math.max(1, Math.round((task.estimateMinutes || 20) * bias));

  const totalMinutes = pending.reduce((n, t) => n + minutesFor(t), 0);
  const start = nextWorkingDay(from);

  let effectiveWeeklyHours = weeklyHours;

  // Solve capacity from the deadline when that's the constraint the user gave.
  if (!effectiveWeeklyHours && targetDate) {
    const workingDays = Math.max(1, countWorkingDays(start, targetDate));
    const minutesPerDay = totalMinutes / workingDays;
    effectiveWeeklyHours = Math.max(1, Math.ceil((minutesPerDay * WORKING_DAYS.length) / 60));
  }

  // Default pace for someone who gave neither: roughly an hour a working day.
  if (!effectiveWeeklyHours) effectiveWeeklyHours = 5;

  const dailyBudgetMinutes = Math.max(
    15,
    Math.round((effectiveWeeklyHours * 60) / WORKING_DAYS.length)
  );

  const dueDates = new Map();
  let cursor = new Date(start);
  let remainingToday = dailyBudgetMinutes;
  let finishDate = null;

  for (const task of pending) {
    const minutes = minutesFor(task);

    // Move to the next working day when today can't fit this task — unless the
    // day is already empty, in which case an oversized task takes the day.
    if (minutes > remainingToday && remainingToday < dailyBudgetMinutes) {
      cursor = nextWorkingDay(new Date(cursor.getTime() + DAY_MS));
      remainingToday = dailyBudgetMinutes;
    }

    dueDates.set(task.order, new Date(cursor));
    finishDate = new Date(cursor);
    remainingToday -= minutes;

    if (remainingToday <= 0) {
      cursor = nextWorkingDay(new Date(cursor.getTime() + DAY_MS));
      remainingToday = dailyBudgetMinutes;
    }
  }

  return {
    dueDates,
    weeklyHours: effectiveWeeklyHours,
    finishDate,
    totalMinutes,
    // Honest about an impossible deadline rather than quietly producing dates
    // that have already passed.
    feasible: !targetDate || !finishDate || finishDate <= startOfDay(targetDate),
  };
}

/** Apply a computed schedule onto a board's tasks, in place. */
export function applySchedule(board, { estimateBias = 1 } = {}) {
  const result = scheduleTasks(board.tasks, {
    targetDate: board.targetDate,
    weeklyHours: board.weeklyHours,
    from: new Date(),
    estimateBias,
  });

  for (const task of board.tasks) {
    const due = result.dueDates.get(task.order);
    task.dueDate = due || null;
  }

  board.weeklyHours = result.weeklyHours;
  return result;
}

// ─────────────────────────────────────────────────────────────
// Estimate calibration
// ─────────────────────────────────────────────────────────────

/**
 * An elapsed span this much larger than the estimate is treated as "walked
 * away", not "took a long time".
 *
 * `actualMinutes` is wall-clock between the first and last subtask tick, so a
 * user who checks one box and returns the next morning records 19 hours on a
 * 30-minute stage. Feeding that into calibration would push every future
 * estimate toward nonsense within a handful of workflows.
 */
export const MAX_TRUSTED_RATIO = 4;

/** Enough samples that one unusual stage can't swing the multiplier. */
const MIN_SAMPLES = 3;

/**
 * Median actual/estimate ratio across the stages a user has actually finished.
 * Median rather than mean so a single outlier that slipped past the ratio
 * guard still can't dominate.
 *
 * @param {Array<{estimateMinutes:number, actualMinutes:number, status:string}>} tasks
 * @returns {number|null} multiplier, or null when there isn't enough signal
 */
export function computeEstimateBias(tasks) {
  const ratios = tasks
    .filter(t => t.status === 'done' && t.actualMinutes > 0 && t.estimateMinutes > 0)
    .map(t => t.actualMinutes / t.estimateMinutes)
    .filter(r => r <= MAX_TRUSTED_RATIO && r >= 1 / MAX_TRUSTED_RATIO)
    .sort((a, b) => a - b);

  if (ratios.length < MIN_SAMPLES) return null;

  const mid = Math.floor(ratios.length / 2);
  const median =
    ratios.length % 2 === 0 ? (ratios[mid - 1] + ratios[mid]) / 2 : ratios[mid];

  // Clamped to the range UserProfile.estimateBias accepts.
  return Math.min(4, Math.max(0.25, Number(median.toFixed(2))));
}

export default { scheduleTasks, applySchedule, computeEstimateBias, countWorkingDays };
