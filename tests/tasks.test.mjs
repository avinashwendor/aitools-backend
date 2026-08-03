/**
 * Task board + scheduling tests.
 *
 * No LLM and no network: scheduling, blocking and calibration are all pure
 * derivations from stage estimates and completion timestamps, which is exactly
 * why they're worth pinning down here.
 *
 *   npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import TaskBoard from '../src/models/TaskBoard.js';
import {
  scheduleTasks,
  computeEstimateBias,
  countWorkingDays,
  MAX_TRUSTED_RATIO,
} from '../src/tasks/schedule.js';

/** A board with `n` two-subtask stages, in memory — never saved. */
const makeBoard = (estimates = [30, 45, 30]) =>
  new TaskBoard({
    user: new mongoose.Types.ObjectId(),
    sourceSessionId: 'wf-test',
    workflowId: 'wf_test',
    title: 'Test',
    tasks: estimates.map((minutes, i) => ({
      taskId: `task_${i}`,
      stageId: `stage-${i + 1}`,
      toolSlug: `tool-${i}`,
      title: `Stage ${i + 1}`,
      order: i,
      estimateMinutes: minutes,
      subtasks: [
        { title: 'a', detail: '', done: false, completedAt: null },
        { title: 'b', detail: '', done: false, completedAt: null },
      ],
    })),
  });

const statuses = board =>
  [...board.tasks].sort((a, b) => a.order - b.order).map(t => t.status);

const completeTask = (board, order, at = new Date()) => {
  const task = board.tasks.find(t => t.order === order);
  task.subtasks.forEach((s, i) => {
    s.done = true;
    // Spread the ticks so the derived elapsed time is non-zero.
    s.completedAt = new Date(at.getTime() + i * 60_000);
  });
};

// ─────────────────────────────────────────────────────────────
describe('task board', () => {
  test('only the first stage is actionable, and finishing one unblocks exactly one more', () => {
    const board = makeBoard();
    board.recompute();
    assert.deepEqual(statuses(board), ['todo', 'blocked', 'blocked']);

    completeTask(board, 0);
    board.recompute();
    assert.deepEqual(
      statuses(board),
      ['done', 'todo', 'blocked'],
      'finishing stage 1 must not unblock stage 3'
    );

    completeTask(board, 1);
    board.recompute();
    assert.deepEqual(statuses(board), ['done', 'done', 'todo']);
  });

  test('a partially ticked stage is in_progress, not done', () => {
    const board = makeBoard();
    board.tasks[0].subtasks[0].done = true;
    board.tasks[0].subtasks[0].completedAt = new Date();
    board.recompute();

    assert.equal(board.tasks[0].status, 'in_progress');
    assert.equal(board.tasks[1].status, 'blocked');
  });

  test('re-opening a stage does not un-complete work already finished after it', () => {
    const board = makeBoard();
    completeTask(board, 0);
    completeTask(board, 1);
    board.recompute();
    assert.deepEqual(statuses(board), ['done', 'done', 'todo']);

    board.tasks[0].subtasks[1].done = false;
    board.tasks[0].subtasks[1].completedAt = null;
    board.recompute();

    // Blocking exists to stop you *starting* a stage whose input doesn't exist
    // yet. Work you have already done stays done — retroactively marking stage
    // 2 "blocked" would be telling the user they can't do something they
    // demonstrably already did. Stage 3 stays available for the same reason:
    // its input (stage 2's output) exists.
    assert.deepEqual(statuses(board), ['in_progress', 'done', 'todo']);
  });

  test('an unfinished stage still blocks the one after it', () => {
    const board = makeBoard();
    board.tasks[0].subtasks[0].done = true;
    board.tasks[0].subtasks[0].completedAt = new Date();
    board.recompute();

    assert.deepEqual(statuses(board), ['in_progress', 'blocked', 'blocked']);
  });

  test('elapsed time is cleared when a stage stops being done', () => {
    const board = makeBoard();
    completeTask(board, 0);
    board.recompute();
    assert.ok(board.tasks[0].actualMinutes > 0);

    board.tasks[0].subtasks[1].done = false;
    board.tasks[0].subtasks[1].completedAt = null;
    board.recompute();

    // Otherwise a half-finished stage would report elapsed time and feed
    // nonsense into estimate calibration.
    assert.equal(board.tasks[0].actualMinutes, null);
  });

  test('a hand-corrected elapsed time survives recompute', () => {
    const board = makeBoard();
    completeTask(board, 0);
    board.recompute();

    board.tasks[0].actualMinutes = 55;
    board.tasks[0].actualMinutesOverridden = true;
    board.recompute();

    // The derived value is wall-clock, so without the flag the correction
    // would be overwritten on the very next write.
    assert.equal(board.tasks[0].actualMinutes, 55);
  });

  test('board completes only when every stage does', () => {
    const board = makeBoard([10, 10]);
    completeTask(board, 0);
    board.recompute();
    assert.equal(board.status, 'active');

    completeTask(board, 1);
    board.recompute();
    assert.equal(board.status, 'done');

    // Reopening a stage reopens the board.
    board.tasks[1].subtasks[0].done = false;
    board.recompute();
    assert.equal(board.status, 'active');
  });

  test('summary reports progress by subtask, not by stage', () => {
    const board = makeBoard([30, 45, 30]);
    board.tasks[0].subtasks[0].done = true;
    board.tasks[0].subtasks[0].completedAt = new Date();
    board.recompute();

    const s = board.summary();
    assert.equal(s.totalSubtasks, 6);
    assert.equal(s.doneSubtasks, 1);
    assert.equal(s.percent, 17);
    assert.equal(s.doneTasks, 0);
    assert.equal(s.remainingMinutes, 105, 'an in-progress stage still counts as remaining');
    assert.equal(s.nextTask.title, 'Stage 1');
  });
});

// ─────────────────────────────────────────────────────────────
describe('scheduling', () => {
  // A fixed Monday, so the working-week logic is tested deterministically
  // rather than differently depending on the day the suite runs.
  const monday = new Date('2026-08-03T09:00:00');

  const tasks = (...estimates) =>
    estimates.map((estimateMinutes, order) => ({ order, estimateMinutes, status: 'todo' }));

  test('fills a daily budget before moving to the next working day', () => {
    // 5h/week over 5 working days = 60 min/day.
    const { dueDates } = scheduleTasks(tasks(45, 60, 45), { weeklyHours: 5, from: monday });

    assert.equal(dueDates.get(0).toDateString(), 'Mon Aug 03 2026');
    assert.equal(dueDates.get(1).toDateString(), 'Tue Aug 04 2026');
    assert.equal(dueDates.get(2).toDateString(), 'Wed Aug 05 2026');
  });

  test('several small stages share one day', () => {
    const { dueDates } = scheduleTasks(tasks(15, 15, 15, 15), { weeklyHours: 5, from: monday });
    assert.equal(dueDates.get(0).toDateString(), dueDates.get(3).toDateString());
  });

  test('skips weekends', () => {
    const friday = new Date('2026-08-07T09:00:00');
    const { dueDates } = scheduleTasks(tasks(60, 60), { weeklyHours: 5, from: friday });

    assert.equal(dueDates.get(0).toDateString(), 'Fri Aug 07 2026');
    assert.equal(
      dueDates.get(1).toDateString(),
      'Mon Aug 10 2026',
      'the next stage must land on Monday, not Saturday'
    );
  });

  test('a deadline solves for the weekly hours it needs', () => {
    const target = new Date('2026-08-06T00:00:00'); // Thu — 4 working days
    const result = scheduleTasks(tasks(60, 60, 60, 60), { targetDate: target, from: monday });

    assert.ok(result.weeklyHours >= 5, `expected a real weekly commitment, got ${result.weeklyHours}`);
    assert.equal(result.feasible, true);
  });

  test('an impossible deadline is reported rather than papered over', () => {
    const target = new Date('2026-08-03T00:00:00');
    // 20 hours of work cannot fit into one day at any sane daily budget.
    const result = scheduleTasks(tasks(...Array(20).fill(60)), {
      targetDate: target,
      weeklyHours: 5,
      from: monday,
    });
    assert.equal(result.feasible, false);
  });

  test('a stage larger than the daily budget takes its own day rather than splitting', () => {
    // 2h/week ≈ 24 min/day, but a 90-minute stage is still one sitting.
    const { dueDates } = scheduleTasks(tasks(90, 20), { weeklyHours: 2, from: monday });
    assert.equal(dueDates.get(0).toDateString(), 'Mon Aug 03 2026');
    assert.notEqual(dueDates.get(1).toDateString(), 'Mon Aug 03 2026');
  });

  test('completed stages are not scheduled again', () => {
    const mixed = [
      { order: 0, estimateMinutes: 60, status: 'done' },
      { order: 1, estimateMinutes: 60, status: 'todo' },
    ];
    const { dueDates, totalMinutes } = scheduleTasks(mixed, { weeklyHours: 5, from: monday });

    assert.equal(dueDates.has(0), false);
    assert.equal(totalMinutes, 60);
  });

  test('the same inputs always produce the same dates', () => {
    const opts = { weeklyHours: 5, from: monday };
    const a = scheduleTasks(tasks(45, 60, 45), opts);
    const b = scheduleTasks(tasks(45, 60, 45), opts);
    assert.deepEqual([...a.dueDates.values()], [...b.dueDates.values()]);
  });

  test('estimate bias stretches the plan', () => {
    const fast = scheduleTasks(tasks(30, 30, 30), { weeklyHours: 5, from: monday });
    const slow = scheduleTasks(tasks(30, 30, 30), {
      weeklyHours: 5,
      from: monday,
      estimateBias: 2,
    });
    assert.ok(slow.totalMinutes > fast.totalMinutes);
    assert.ok(slow.finishDate >= fast.finishDate);
  });

  test('countWorkingDays excludes weekends', () => {
    // Mon 3rd → Mon 10th inclusive: 3,4,5,6,7 + 10 = 6
    assert.equal(countWorkingDays(new Date('2026-08-03'), new Date('2026-08-10')), 6);
  });
});

// ─────────────────────────────────────────────────────────────
describe('estimate calibration', () => {
  const done = (estimateMinutes, actualMinutes) => ({
    status: 'done',
    estimateMinutes,
    actualMinutes,
  });

  test('needs enough samples before it claims to know anything', () => {
    assert.equal(computeEstimateBias([done(30, 45), done(30, 45)]), null);
  });

  test('finds the median ratio once there is signal', () => {
    const bias = computeEstimateBias([done(30, 45), done(30, 45), done(30, 45)]);
    assert.equal(bias, 1.5);
  });

  test('ignores a stage that was clearly left open overnight', () => {
    // 30 min estimate, 19 hours elapsed — the user walked away, they did not
    // spend 19 hours on it. Trusting this would wreck every future estimate.
    const withOutlier = [done(30, 45), done(30, 45), done(30, 45), done(30, 19 * 60)];
    assert.equal(computeEstimateBias(withOutlier), 1.5);
    assert.ok(19 * 60 / 30 > MAX_TRUSTED_RATIO);
  });

  test('unfinished stages contribute nothing', () => {
    const mixed = [
      done(30, 45),
      done(30, 45),
      { status: 'in_progress', estimateMinutes: 30, actualMinutes: 200 },
    ];
    assert.equal(computeEstimateBias(mixed), null);
  });

  test('stays inside the range the profile accepts', () => {
    const bias = computeEstimateBias([done(10, 39), done(10, 39), done(10, 39)]);
    assert.ok(bias >= 0.25 && bias <= 4, `bias ${bias} out of storable range`);
  });
});
