/**
 * One-off migration: WorkflowRun → TaskBoard.
 *
 *   node scripts/migrate-task-boards.mjs [--dry]
 *
 * Idempotent — safe to run repeatedly. Existing boards are left alone.
 *
 * Only runs with at least one completed step become boards. The old
 * `WorkflowRun` was created automatically on every workflow-producing turn, so
 * the collection is mostly ideas nobody committed to; migrating those wholesale
 * would launch the new dashboard pre-filled with noise. Zero-progress runs are
 * dropped, and the user can re-add any of them from the workflow itself.
 *
 * `WorkflowRun` documents are not deleted, so this can be rolled back.
 */

import mongoose from 'mongoose';
import crypto from 'crypto';
import config from '../src/config/index.js';
import TaskBoard from '../src/models/TaskBoard.js';
import Conversation from '../src/models/Conversation.js';

const dryRun = process.argv.includes('--dry');

const newTaskId = () => `task_${crypto.randomBytes(6).toString('hex')}`;

async function main() {
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 15_000 });
  console.log(`Connected${dryRun ? ' (dry run — nothing will be written)' : ''}\n`);

  // Read through the raw collection: the WorkflowRun model is being retired,
  // so this must not depend on it still being registered.
  const runs = await mongoose.connection.collection('workflowruns').find({}).toArray();
  console.log(`Found ${runs.length} legacy workflow runs`);

  let created = 0;
  let skippedEmpty = 0;
  let skippedExisting = 0;
  let skippedNoWorkflow = 0;

  for (const run of runs) {
    const doneSteps = (run.stages || []).reduce(
      (n, s) => n + (s.steps || []).filter(st => st.done).length,
      0
    );

    if (doneSteps === 0) {
      skippedEmpty++;
      continue;
    }

    const existing = await TaskBoard.findOne({
      user: run.user,
      sourceSessionId: run.sessionId,
    });
    if (existing) {
      skippedExisting++;
      continue;
    }

    // The run only stored step titles, not estimates or the stage's full
    // playbook — pull those from the conversation's stored workflow.
    const conversation = await Conversation.findOne({
      user: run.user,
      sessionId: run.sessionId,
    }).lean();
    const workflow = conversation?.lastWorkflow;

    if (!workflow?.stages?.length) {
      skippedNoWorkflow++;
      continue;
    }

    const stageBySlug = new Map(workflow.stages.map(s => [s.toolSlug, s]));

    const tasks = (run.stages || []).map((stage, index) => {
      const source = stageBySlug.get(stage.toolSlug);
      const doneByTitle = new Map((stage.steps || []).map(s => [s.title, s]));

      // Prefer the workflow's steps (they carry `detail`), falling back to the
      // run's own titles when the workflow has since moved on.
      const steps = source?.steps?.length ? source.steps : stage.steps || [];

      return {
        taskId: newTaskId(),
        stageId: stage.stageId || source?.id || `stage-${index + 1}`,
        toolSlug: stage.toolSlug,
        title: stage.title,
        order: index,
        estimateMinutes: source?.timeMinutes || 20,
        status: 'todo',
        subtasks: steps.map(step => {
          const prior = doneByTitle.get(step.title);
          return {
            title: step.title,
            detail: step.detail || '',
            done: Boolean(prior?.done),
            completedAt: prior?.completedAt || null,
          };
        }),
      };
    });

    if (dryRun) {
      console.log(`  would create: "${run.title}" (${tasks.length} tasks, ${doneSteps} done)`);
      created++;
      continue;
    }

    const board = new TaskBoard({
      user: run.user,
      sourceSessionId: run.sessionId,
      workflowId: run.workflowId || workflow.id,
      workflowVersion: workflow.version || 1,
      title: run.title || workflow.title || 'Untitled workflow',
      outcome: workflow.outcome || '',
      status: run.status === 'done' ? 'done' : 'active',
      startedAt: run.createdAt || new Date(),
      tasks,
    });

    board.recompute();
    await board.save();
    created++;
  }

  console.log(`
  created:              ${created}
  skipped (no progress) ${skippedEmpty}
  skipped (already had) ${skippedExisting}
  skipped (no workflow) ${skippedNoWorkflow}
`);
  console.log('workflowruns left in place for rollback — drop the collection once verified.');

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
