/**
 * Shared task-board creation used by HTTP controller and MCP tools.
 */

import crypto from 'crypto';
import TaskBoard from '../models/TaskBoard.js';
import UserProfile from '../models/UserProfile.js';
import { loadConversation } from '../ai/memory.js';
import { applySchedule, computeEstimateBias } from '../tasks/schedule.js';
import { checkLimit, spend, canAfford, isUnmetered } from '../billing/credits.js';
import { getPlan, nextPlanUp, creditCost } from '../billing/plans.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('tasks:service');

const newTaskId = () => `task_${crypto.randomBytes(6).toString('hex')}`;

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

function mergeProgress(nextTasks, priorTasks) {
  const priorByStage = new Map((priorTasks || []).map(t => [t.stageId, t]));

  for (const task of nextTasks) {
    const prior = priorByStage.get(task.stageId);
    if (!prior) continue;

    const priorByTitle = new Map(prior.subtasks.map(s => [s.title, s]));
    for (const subtask of task.subtasks) {
      const match = priorByTitle.get(subtask.title);
      if (!match?.done) continue;
      subtask.done = true;
      subtask.completedAt = match.completedAt;
    }
    task.actualMinutes = prior.actualMinutes ?? null;
    task.actualMinutesOverridden = prior.actualMinutesOverridden || false;
  }

  return nextTasks;
}

async function getEstimateBias(userId) {
  const profile = await UserProfile.findOne({ user: userId }).select('estimateBias').lean();
  return profile?.estimateBias || 1;
}

/**
 * @returns {{ board: object, created: boolean }}
 * @throws {{ status: number, code?: string, message: string, data?: object }}
 */
export async function commitWorkflowToBoard({ user, sessionId, targetDate, weeklyHours }) {
  const userId = user._id;
  const conversation = await loadConversation(userId, sessionId);
  const workflow = conversation.lastWorkflow;

  if (!workflow?.stages?.length) {
    const err = new Error('No workflow in that session to add to tasks yet.');
    err.status = 404;
    throw err;
  }

  const existing = await TaskBoard.findOne({ user: userId, sourceSessionId: sessionId });

  if (!existing) {
    const activeBoards = await TaskBoard.countDocuments({ user: userId, status: 'active' });
    const limit = checkLimit(user, 'taskBoards', activeBoards);

    if (!limit.allowed) {
      const plan = getPlan(user.subscription?.plan);
      const next = nextPlanUp(plan.id);
      const err = new Error(
        `The ${plan.name} plan keeps ${limit.limit} task boards active at a time. ` +
          `Archive one you've finished, or upgrade for more room.`
      );
      err.status = 403;
      err.code = 'BOARD_LIMIT_REACHED';
      err.data = {
        limit: limit.limit,
        used: limit.used,
        currentPlan: plan.id,
        upgrade: next
          ? { planId: next.id, planName: next.name, limit: next.limits.taskBoards || 'Unlimited' }
          : null,
      };
      throw err;
    }

    const boardCost = creditCost('taskboard.create');
    if (!isUnmetered(user) && !canAfford(user, boardCost)) {
      const err = new Error('Not enough credits to create a task board.');
      err.status = 402;
      err.code = 'INSUFFICIENT_CREDITS';
      err.data = { required: boardCost, action: 'taskboard.create' };
      throw err;
    }
  }

  const tasks = mergeProgress(tasksFromWorkflow(workflow), existing?.tasks);

  const board =
    existing ||
    new TaskBoard({ user: userId, sourceSessionId: sessionId, workflowId: workflow.id });

  board.workflowId = workflow.id;
  board.workflowVersion = workflow.version || 1;
  board.title = workflow.title || 'Untitled workflow';
  board.outcome = workflow.outcome || '';
  board.tasks = tasks;
  if (targetDate) board.targetDate = new Date(targetDate);
  if (weeklyHours) board.weeklyHours = Number(weeklyHours);
  if (board.status === 'archived') board.status = 'active';

  board.recompute();
  applySchedule(board, { estimateBias: await getEstimateBias(userId) });
  await board.save();

  const created = !existing;
  if (created) {
    const outcome = await spend({
      user,
      action: 'taskboard.create',
      cost: creditCost('taskboard.create'),
      sessionId,
      meta: { boardId: String(board._id) },
    });
    if (!outcome.ok) {
      await TaskBoard.deleteOne({ _id: board._id }).catch(() => {});
      const err = new Error('Not enough credits to create a task board.');
      err.status = 402;
      err.code = 'INSUFFICIENT_CREDITS';
      throw err;
    }
  }

  log.info('Task board committed', {
    userId: String(userId),
    tasks: board.tasks.length,
    reused: Boolean(existing),
  });

  return { board, created };
}
