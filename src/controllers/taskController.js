/**
 * Task boards — the "actually do the workflow" half of the product.
 *
 * A board is created by an explicit user action, never as a side effect of
 * generating a workflow (see models/TaskBoard.js for why that distinction
 * matters). Everything derived — status, blocking, elapsed time, due dates —
 * is recomputed from subtask completion on every write, so the board can't
 * drift into an inconsistent state.
 */

import crypto from 'crypto';
import TaskBoard from '../models/TaskBoard.js';
import UserProfile from '../models/UserProfile.js';
import { loadConversation } from '../ai/memory.js';
import { applySchedule, scheduleTasks, computeEstimateBias } from '../tasks/schedule.js';
import { commitWorkflowToBoard } from '../tasks/commitBoard.js';
import { ApiError } from '../middleware/errorHandler.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('tasks');

const newTaskId = () => `task_${crypto.randomBytes(6).toString('hex')}`;

/**
 * Due dates are stored at midnight, so comparing them against `now` would mark
 * anything due today as overdue from 00:01 onwards. Overdue means "an earlier
 * day has passed", not "the clock has moved past midnight".
 */
function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

const isOverdue = dueDate => Boolean(dueDate && new Date(dueDate) < startOfToday());

async function getEstimateBias(userId) {
  const profile = await UserProfile.findOne({ user: userId }).select('estimateBias').lean();
  return profile?.estimateBias || 1;
}

/** Recalibrate estimate bias from completed work. Fire-and-forget. */
async function recalibrate(userId) {
  const boards = await TaskBoard.find({ user: userId }).select('tasks').lean();
  const allTasks = boards.flatMap(b => b.tasks);

  const bias = computeEstimateBias(allTasks);
  if (bias === null) return;

  await UserProfile.updateOne(
    { user: userId },
    { $set: { estimateBias: bias }, $setOnInsert: { user: userId } },
    { upsert: true }
  );
}

/** Build the task list for a schedule preview from a generated workflow. */
function tasksFromWorkflow(workflow) {
  return (workflow.stages || []).map((stage, index) => ({
    taskId: newTaskId(),
    stageId: stage.id,
    toolSlug: stage.toolSlug,
    title: stage.title,
    order: index,
    estimateMinutes: stage.timeMinutes || 20,
    status: index === 0 ? 'todo' : 'blocked',
    subtasks: (stage.steps || []).map(step => ({
      title: step.title,
      detail: step.detail || '',
      done: false,
      completedAt: null,
    })),
  }));
}

// ─────────────────────────────────────────────────────────────
// POST /api/tasks — commit to a workflow
// ─────────────────────────────────────────────────────────────
export const createBoard = async (req, res, next) => {
  try {
    const { sessionId, targetDate, weeklyHours } = req.body;
    const { board, created } = await commitWorkflowToBoard({
      user: req.user,
      sessionId,
      targetDate,
      weeklyHours,
    });
    res.status(created ? 201 : 200).json({ success: true, data: { board } });
  } catch (error) {
    if (error.status === 402) {
      return res.status(402).json({
        success: false,
        code: error.code || 'INSUFFICIENT_CREDITS',
        message: error.message,
        data: error.data,
      });
    }
    if (error.status === 403 && error.code === 'BOARD_LIMIT_REACHED') {
      return res.status(403).json({
        success: false,
        code: error.code,
        message: error.message,
        data: error.data,
      });
    }
    if (error.status === 404) {
      return next(new ApiError(404, error.message));
    }
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────

/** GET /api/tasks — board summaries, newest activity first. */
export const listBoards = async (req, res, next) => {
  try {
    const filter = { user: req.user._id };
    if (['active', 'done', 'archived'].includes(req.query.status)) {
      filter.status = req.query.status;
    }

    const boards = await TaskBoard.find(filter).sort('-updatedAt').limit(50);
    res.json({ success: true, data: { boards: boards.map(b => b.summary()) } });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/tasks/today — what's actionable now, across every active board.
 *
 * Blocked tasks are excluded by construction: a stage whose input doesn't
 * exist yet isn't something anyone can start today.
 */
export const getToday = async (req, res, next) => {
  try {
    const boards = await TaskBoard.find({ user: req.user._id, status: 'active' });
    const endOfToday = new Date();
    endOfToday.setHours(23, 59, 59, 999);

    const items = [];
    for (const board of boards) {
      for (const task of board.tasks) {
        if (task.status !== 'todo' && task.status !== 'in_progress') continue;
        // Anything in progress stays on the list regardless of its date —
        // half-finished work is the most actionable work there is.
        const isDue = !task.dueDate || task.dueDate <= endOfToday;
        if (task.status === 'todo' && !isDue) continue;

        items.push({
          boardId: board._id,
          boardTitle: board.title,
          sourceSessionId: board.sourceSessionId,
          taskId: task.taskId,
          title: task.title,
          toolSlug: task.toolSlug,
          status: task.status,
          estimateMinutes: task.estimateMinutes,
          dueDate: task.dueDate,
          totalSubtasks: task.subtasks.length,
          doneSubtasks: task.subtasks.filter(s => s.done).length,
          isOverdue: isOverdue(task.dueDate),
        });
      }
    }

    // Overdue first, then by date — the order you'd actually work in.
    items.sort((a, b) => {
      if (a.isOverdue !== b.isOverdue) return a.isOverdue ? -1 : 1;
      return new Date(a.dueDate || 0) - new Date(b.dueDate || 0);
    });

    res.json({
      success: true,
      data: {
        items,
        totalMinutes: items.reduce((n, i) => n + i.estimateMinutes, 0),
        overdueCount: items.filter(i => i.isOverdue).length,
      },
    });
  } catch (error) {
    next(error);
  }
};

/** GET /api/tasks/:boardId */
export const getBoard = async (req, res, next) => {
  try {
    const board = await TaskBoard.findOne({ _id: req.params.boardId, user: req.user._id });
    if (!board) throw new ApiError(404, 'Task board not found');
    res.json({ success: true, data: { board } });
  } catch (error) {
    next(error);
  }
};

/** GET /api/tasks/by-session/:sessionId — does this workflow have a board yet? */
export const getBoardBySession = async (req, res, next) => {
  try {
    const board = await TaskBoard.findOne({
      user: req.user._id,
      sourceSessionId: req.params.sessionId,
    });
    res.json({ success: true, data: { board: board || null } });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────
// Writes
// ─────────────────────────────────────────────────────────────

/** PATCH /api/tasks/:boardId — scheduling inputs and status. */
export const updateBoard = async (req, res, next) => {
  try {
    const { targetDate, weeklyHours, status } = req.body;

    const board = await TaskBoard.findOne({ _id: req.params.boardId, user: req.user._id });
    if (!board) throw new ApiError(404, 'Task board not found');

    if (targetDate !== undefined) board.targetDate = targetDate ? new Date(targetDate) : null;
    if (weeklyHours !== undefined) board.weeklyHours = weeklyHours ? Number(weeklyHours) : null;
    if (['active', 'done', 'archived'].includes(status)) board.status = status;

    board.recompute();
    const schedule = applySchedule(board, { estimateBias: await getEstimateBias(req.user._id) });
    await board.save();

    res.json({ success: true, data: { board, schedule: { feasible: schedule.feasible } } });
  } catch (error) {
    next(error);
  }
};

/** PATCH /api/tasks/:boardId/tasks/:taskId/subtasks/:index — tick one step. */
export const toggleSubtask = async (req, res, next) => {
  try {
    const { boardId, taskId, index } = req.params;
    const done = Boolean(req.body.done);
    const idx = Number(index);

    const board = await TaskBoard.findOne({ _id: boardId, user: req.user._id });
    if (!board) throw new ApiError(404, 'Task board not found');

    const task = board.tasks.find(t => t.taskId === taskId);
    if (!task?.subtasks[idx]) throw new ApiError(404, 'Step not found');

    // Blocked means the previous stage hasn't produced this one's input yet,
    // so there is genuinely nothing to tick.
    if (task.status === 'blocked') {
      throw new ApiError(409, 'Finish the previous stage before starting this one.');
    }

    task.subtasks[idx].done = done;
    task.subtasks[idx].completedAt = done ? new Date() : null;

    board.recompute();
    applySchedule(board, { estimateBias: await getEstimateBias(req.user._id) });
    await board.save();

    // Fire-and-forget: never let calibration failure block a checkbox.
    recalibrate(req.user._id).catch(err =>
      log.warn('Estimate recalibration failed', { error: err.message })
    );

    res.json({ success: true, data: { board } });
  } catch (error) {
    next(error);
  }
};

/**
 * PATCH /api/tasks/:boardId/tasks/:taskId — per-task overrides.
 *
 * `actualMinutes` exists because the derived value is wall-clock: a user who
 * ticks a box and comes back tomorrow records a 19-hour stage. Letting them
 * correct it keeps the calibration data honest.
 */
export const updateTask = async (req, res, next) => {
  try {
    const { boardId, taskId } = req.params;
    const { dueDate, actualMinutes } = req.body;

    const board = await TaskBoard.findOne({ _id: boardId, user: req.user._id });
    if (!board) throw new ApiError(404, 'Task board not found');

    const task = board.tasks.find(t => t.taskId === taskId);
    if (!task) throw new ApiError(404, 'Task not found');

    if (dueDate !== undefined) task.dueDate = dueDate ? new Date(dueDate) : null;

    if (actualMinutes !== undefined) {
      if (actualMinutes === null) {
        // Clearing the override hands the value back to the derived span.
        task.actualMinutesOverridden = false;
      } else {
        task.actualMinutes = Math.max(1, Math.min(2000, Number(actualMinutes)));
        task.actualMinutesOverridden = true;
      }
    }

    board.recompute();
    await board.save();

    recalibrate(req.user._id).catch(() => {});

    res.json({ success: true, data: { board } });
  } catch (error) {
    next(error);
  }
};

/** POST /api/tasks/preview — schedule a workflow without committing to it. */
export const previewSchedule = async (req, res, next) => {
  try {
    const { sessionId, targetDate, weeklyHours } = req.body;

    const conversation = await loadConversation(req.user._id, sessionId);
    const workflow = conversation.lastWorkflow;
    if (!workflow?.stages?.length) throw new ApiError(404, 'No workflow in that session yet.');

    const result = scheduleTasks(tasksFromWorkflow(workflow), {
      targetDate: targetDate ? new Date(targetDate) : null,
      weeklyHours: weeklyHours ? Number(weeklyHours) : null,
      estimateBias: await getEstimateBias(req.user._id),
    });

    res.json({
      success: true,
      data: {
        weeklyHours: result.weeklyHours,
        finishDate: result.finishDate,
        totalMinutes: result.totalMinutes,
        feasible: result.feasible,
        taskCount: workflow.stages.length,
      },
    });
  } catch (error) {
    next(error);
  }
};

/** DELETE /api/tasks/:boardId */
export const deleteBoard = async (req, res, next) => {
  try {
    const result = await TaskBoard.deleteOne({ _id: req.params.boardId, user: req.user._id });
    if (!result.deletedCount) throw new ApiError(404, 'Task board not found');
    res.json({ success: true, message: 'Removed from tasks' });
  } catch (error) {
    next(error);
  }
};

/**
 * Keep boards in step when a deep dive rewrites a stage's playbook.
 *
 * Previously the regenerated steps never reached the server's tracking copy at
 * all, so the client and server diverged the moment a user hit "rewrite these
 * steps". Called fire-and-forget from the chat controller.
 */
export async function syncStagePlaybook({ userId, sessionId, stageId, steps }) {
  try {
    const board = await TaskBoard.findOne({ user: userId, sourceSessionId: sessionId });
    if (!board) return;

    const task = board.tasks.find(t => t.stageId === stageId);
    if (!task) return;

    const priorByTitle = new Map(task.subtasks.map(s => [s.title, s]));
    task.subtasks = (steps || []).map(step => {
      const prior = priorByTitle.get(step.title);
      return {
        title: step.title,
        detail: step.detail || '',
        // A step that survived the rewrite keeps its tick; a new one starts unticked.
        done: prior?.done || false,
        completedAt: prior?.completedAt || null,
      };
    });

    board.recompute();
    await board.save();
  } catch (err) {
    log.warn('Failed to sync regenerated playbook to task board', { error: err.message });
  }
}

/** Authenticated: return a signed ICS feed URL for this board. */
export const getCalendarFeedLink = async (req, res, next) => {
  try {
    const board = await TaskBoard.findOne({
      _id: req.params.boardId,
      user: req.user._id,
    }).select('_id');
    if (!board) throw new ApiError(404, 'Board not found');

    const { signCalendarToken } = await import('../integrations/crypto.js');
    const token = signCalendarToken(String(board._id), String(req.user._id));
    const path = `/api/tasks/calendar.ics?token=${encodeURIComponent(token)}`;

    res.json({
      success: true,
      data: {
        path,
        token,
      },
    });
  } catch (err) {
    next(err);
  }
};

/** Public (token-signed): download ICS for a board. Gated conceptually by exportWorkflow at link-creation time. */
export const downloadCalendarIcs = async (req, res, next) => {
  try {
    const { verifyCalendarToken } = await import('../integrations/crypto.js');
    const { boardToIcs } = await import('../tasks/ics.js');

    const verified = verifyCalendarToken(req.query.token);
    if (!verified) {
      return res.status(401).json({ success: false, message: 'Invalid calendar token' });
    }

    const board = await TaskBoard.findOne({
      _id: verified.boardId,
      user: verified.userId,
    });
    if (!board) {
      return res.status(404).json({ success: false, message: 'Board not found' });
    }

    const ics = boardToIcs(board);
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${String(board.title || 'tasks').slice(0, 40)}.ics"`
    );
    res.send(ics);
  } catch (err) {
    next(err);
  }
};

export default {
  createBoard,
  listBoards,
  getToday,
  getBoard,
  getBoardBySession,
  updateBoard,
  toggleSubtask,
  updateTask,
  previewSchedule,
  deleteBoard,
  syncStagePlaybook,
  getCalendarFeedLink,
  downloadCalendarIcs,
};
