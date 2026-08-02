/**
 * Workflow task-tracking — server-persisted "my tasks" for a generated
 * workflow, replacing what used to be `WorkflowOutput.jsx`'s
 * `localStorage`-only completion state (`workflow_studio_v2_completed`).
 */

import WorkflowRun from '../models/WorkflowRun.js';
import { ApiError } from '../middleware/errorHandler.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('workflow');

/**
 * Fire-and-forget from the chat controller whenever a turn produces a
 * workflow. Merges into the session's existing run rather than replacing it,
 * so a refine's untouched stages keep their checked-off steps — matched by
 * (toolSlug, step title), which the stage-diff fix in workflowEngine.js
 * already keeps stable for anything the planner didn't actually change.
 */
export async function upsertWorkflowRun({ userId, sessionId, workflow }) {
  if (!userId || !workflow?.stages?.length) return;

  try {
    const prior = await WorkflowRun.findOne({ user: userId, sessionId });
    const priorByTool = new Map((prior?.stages || []).map(s => [s.toolSlug, s]));

    const stages = workflow.stages.map(stage => {
      const priorStage = priorByTool.get(stage.toolSlug);
      const priorStepsByTitle = new Map((priorStage?.steps || []).map(s => [s.title, s]));

      return {
        stageId: stage.id,
        toolSlug: stage.toolSlug,
        title: stage.title,
        steps: (stage.steps || []).map(s => {
          const priorStep = priorStepsByTitle.get(s.title);
          return {
            title: s.title,
            done: priorStep?.done || false,
            completedAt: priorStep?.done ? priorStep.completedAt : null,
          };
        }),
      };
    });

    const run = await WorkflowRun.findOneAndUpdate(
      { user: userId, sessionId },
      { $set: { workflowId: workflow.id, title: workflow.title, stages } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    run.recomputeStatus();
    await run.save();
  } catch (err) {
    log.warn('Failed to persist workflow run', { error: err.message });
  }
}

/** GET /api/workflows — "my workflows" list. */
export const getMyWorkflows = async (req, res, next) => {
  try {
    const { status } = req.query;
    const filter = { user: req.user._id };
    if (['in_progress', 'done', 'abandoned'].includes(status)) filter.status = status;

    const runs = await WorkflowRun.find(filter).sort('-updatedAt').limit(50);
    res.json({ success: true, data: { workflows: runs } });
  } catch (error) {
    next(error);
  }
};

/** GET /api/workflows/:sessionId — one run, by session. */
export const getWorkflowRun = async (req, res, next) => {
  try {
    const run = await WorkflowRun.findOne({ user: req.user._id, sessionId: req.params.sessionId });
    if (!run) throw new ApiError(404, 'No workflow run for this session yet');
    res.json({ success: true, data: { workflow: run } });
  } catch (error) {
    next(error);
  }
};

/** PATCH /api/workflows/:sessionId/steps/:stageId/:stepIndex — toggle one step. */
export const toggleStep = async (req, res, next) => {
  try {
    const { sessionId, stageId, stepIndex } = req.params;
    const { done } = req.body;
    const idx = Number(stepIndex);

    const run = await WorkflowRun.findOne({ user: req.user._id, sessionId });
    if (!run) throw new ApiError(404, 'No workflow run for this session');

    const stage = run.stages.find(s => s.stageId === stageId);
    if (!stage || !stage.steps[idx]) throw new ApiError(404, 'Step not found');

    stage.steps[idx].done = Boolean(done);
    stage.steps[idx].completedAt = done ? new Date() : null;
    run.recomputeStatus();
    await run.save();

    res.json({ success: true, data: { workflow: run } });
  } catch (error) {
    next(error);
  }
};

export default { upsertWorkflowRun, getMyWorkflows, getWorkflowRun, toggleStep };
