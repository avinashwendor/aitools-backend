import mongoose from 'mongoose';

/**
 * A workflow the user has committed to executing.
 *
 * This replaces `WorkflowRun`, which was created automatically on every
 * workflow-producing turn. That conflated two different things: *generating* a
 * plan (cheap, exploratory, often abandoned) and *committing* to build it. The
 * result was a "my workflows" list full of half-explored ideas nobody intended
 * to do — which is why it was never worth surfacing in the UI.
 *
 * A board is created only by an explicit "Add to tasks" action, so everything
 * in the dashboard is something the user actually chose.
 *
 * Granularity: one task per workflow stage, one subtask per playbook step.
 * Stages are the level that carries a real time estimate (`timeMinutes`), and
 * they are strictly sequential — `normalizePlan` chains every stage's input to
 * the previous stage's output — so both the scheduling and the blocking below
 * describe real dependencies rather than invented ones.
 */

const subtaskSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    detail: { type: String, default: '' },
    done: { type: Boolean, default: false },
    completedAt: { type: Date, default: null },
  },
  { _id: false }
);

const taskSchema = new mongoose.Schema(
  {
    taskId: { type: String, required: true },
    /** The stage this came from, so a regenerated playbook can be matched back. */
    stageId: { type: String, required: true },
    toolSlug: { type: String, required: true },
    title: { type: String, required: true },

    /** Position in the chain. Task N is blocked until task N-1 is done. */
    order: { type: Number, required: true },

    estimateMinutes: { type: Number, default: 20, min: 1, max: 2000 },
    /**
     * Wall-clock minutes between the first and last subtask completion.
     * Deliberately not trusted blindly — see `tasks/schedule.js`, which only
     * feeds this into estimate calibration when it looks like real working
     * time rather than "ticked a box and came back the next morning".
     */
    actualMinutes: { type: Number, default: null },
    /**
     * Set when the user corrected the elapsed time by hand. The derived value
     * is wall-clock, so "ticked a box, came back tomorrow" reads as a 19-hour
     * stage; without this flag `recompute` would immediately overwrite the
     * correction and the override would be pointless.
     */
    actualMinutesOverridden: { type: Boolean, default: false },

    status: {
      type: String,
      enum: ['blocked', 'todo', 'in_progress', 'done'],
      default: 'todo',
    },

    dueDate: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },

    subtasks: { type: [subtaskSchema], default: [] },
  },
  { _id: false }
);

const taskBoardSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    /** The chat session this workflow was designed in. */
    sourceSessionId: { type: String, required: true },
    workflowId: { type: String, required: true },
    workflowVersion: { type: Number, default: 1 },

    title: { type: String, default: '' },
    outcome: { type: String, default: '' },

    status: {
      type: String,
      enum: ['active', 'done', 'archived'],
      default: 'active',
    },

    startedAt: { type: Date, default: Date.now },

    /** Scheduling inputs — either may be set; see `tasks/schedule.js`. */
    targetDate: { type: Date, default: null },
    weeklyHours: { type: Number, default: null, min: 1, max: 80 },

    tasks: { type: [taskSchema], default: [] },

    /** Dedupes daily email / Gmail nudges — one per board per calendar day. */
    lastRemindedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// One board per workflow per session: re-committing the same workflow updates
// the existing board rather than silently creating a duplicate to track.
taskBoardSchema.index({ user: 1, sourceSessionId: 1 }, { unique: true });
taskBoardSchema.index({ user: 1, status: 1, updatedAt: -1 });

/**
 * Recompute every derived field from subtask completion.
 *
 * Status is never set directly by a caller — deriving it means the board can't
 * drift into states like "done with unfinished subtasks", which is exactly the
 * class of bug the old `(toolSlug, step title)` re-matching produced.
 */
taskBoardSchema.methods.recompute = function recompute() {
  const ordered = [...this.tasks].sort((a, b) => a.order - b.order);

  let previousDone = true;

  for (const task of ordered) {
    const total = task.subtasks.length;
    const done = task.subtasks.filter(s => s.done).length;

    if (total > 0 && done === total) {
      task.status = 'done';
      const last = task.subtasks
        .map(s => s.completedAt)
        .filter(Boolean)
        .sort((a, b) => b - a)[0];
      task.completedAt = last || task.completedAt || new Date();
    } else if (!previousDone) {
      // Can't start a stage whose input hasn't been produced yet.
      task.status = 'blocked';
      task.completedAt = null;
    } else if (done > 0) {
      task.status = 'in_progress';
      task.completedAt = null;
    } else {
      task.status = 'todo';
      task.completedAt = null;
    }

    const first = task.subtasks
      .map(s => s.completedAt)
      .filter(Boolean)
      .sort((a, b) => a - b)[0];
    task.startedAt = first || null;

    if (!task.actualMinutesOverridden) {
      if (task.status === 'done' && task.startedAt && task.completedAt) {
        task.actualMinutes = Math.max(
          1,
          Math.round((task.completedAt - task.startedAt) / 60_000)
        );
      } else {
        // An unfinished stage has no elapsed time to report — leaving a stale
        // value would feed a half-done stage into estimate calibration.
        task.actualMinutes = null;
      }
    }

    previousDone = task.status === 'done';
  }

  const allDone = ordered.length > 0 && ordered.every(t => t.status === 'done');
  if (allDone) this.status = 'done';
  else if (this.status === 'done') this.status = 'active';
};

/** Progress summary for list views, without shipping every subtask. */
taskBoardSchema.methods.summary = function summary() {
  const total = this.tasks.length;
  const done = this.tasks.filter(t => t.status === 'done').length;

  const totalSubtasks = this.tasks.reduce((n, t) => n + t.subtasks.length, 0);
  const doneSubtasks = this.tasks.reduce(
    (n, t) => n + t.subtasks.filter(s => s.done).length,
    0
  );

  const remainingMinutes = this.tasks
    .filter(t => t.status !== 'done')
    .reduce((n, t) => n + (t.estimateMinutes || 0), 0);

  const next = [...this.tasks]
    .sort((a, b) => a.order - b.order)
    .find(t => t.status === 'todo' || t.status === 'in_progress');

  // Due dates sit at midnight, so "behind" means an earlier day has already
  // passed — not merely that the clock ticked past midnight today.
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  return {
    id: this._id,
    sourceSessionId: this.sourceSessionId,
    workflowId: this.workflowId,
    title: this.title,
    outcome: this.outcome,
    status: this.status,
    targetDate: this.targetDate,
    weeklyHours: this.weeklyHours,
    startedAt: this.startedAt,
    updatedAt: this.updatedAt,
    totalTasks: total,
    doneTasks: done,
    totalSubtasks,
    doneSubtasks,
    percent: totalSubtasks ? Math.round((doneSubtasks / totalSubtasks) * 100) : 0,
    remainingMinutes,
    nextTask: next ? { taskId: next.taskId, title: next.title, dueDate: next.dueDate } : null,
    isBehind: Boolean(next?.dueDate && next.dueDate < startOfToday),
  };
};

const TaskBoard = mongoose.model('TaskBoard', taskBoardSchema);

export default TaskBoard;
