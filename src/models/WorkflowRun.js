import mongoose from 'mongoose';

/**
 * Server-persisted execution tracking for a generated workflow.
 *
 * Previously this only existed as `localStorage` state inside
 * `WorkflowOutput.jsx` (`workflow_studio_v2_completed`) — invisible to the
 * backend, lost on a cleared browser, and not shareable across devices. This
 * is the real "my tasks" system: one document per workflow a user has
 * started, with per-step completion so progress survives and is queryable.
 */
const stepSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    done: { type: Boolean, default: false },
    completedAt: { type: Date, default: null },
  },
  { _id: false }
);

const stageSchema = new mongoose.Schema(
  {
    stageId: { type: String, required: true },
    toolSlug: { type: String, required: true },
    title: { type: String, required: true },
    steps: { type: [stepSchema], default: [] },
  },
  { _id: false }
);

const workflowRunSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    /**
     * Keyed by session, not by `workflow.id` — a refine generates a brand-new
     * `workflow.id` every time (see ai/workflowEngine.js `assemble()`), but a
     * user's task progress on "the workflow I'm building in this chat" should
     * survive every refine, not reset. `workflowId` is kept for display/
     * reference only (the id of the most recently generated version).
     */
    sessionId: { type: String, required: true },
    workflowId: { type: String, required: true },

    title: { type: String, default: '' },
    stages: { type: [stageSchema], default: [] },

    status: { type: String, enum: ['in_progress', 'done', 'abandoned'], default: 'in_progress' },
  },
  { timestamps: true }
);

workflowRunSchema.index({ user: 1, sessionId: 1 }, { unique: true });
workflowRunSchema.index({ user: 1, updatedAt: -1 });

/** Recomputes `status` from step completion — call after any step toggle. */
workflowRunSchema.methods.recomputeStatus = function recomputeStatus() {
  const totalSteps = this.stages.reduce((n, s) => n + s.steps.length, 0);
  const doneSteps = this.stages.reduce((n, s) => n + s.steps.filter(st => st.done).length, 0);
  if (totalSteps > 0 && doneSteps === totalSteps) this.status = 'done';
  else if (this.status === 'done') this.status = 'in_progress';
};

const WorkflowRun = mongoose.model('WorkflowRun', workflowRunSchema);

export default WorkflowRun;
