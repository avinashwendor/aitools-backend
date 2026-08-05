/**
 * Run queue and scheduler.
 *
 * Same shape as `jobs/index.js`: BullMQ when `REDIS_URL` is set, an in-process
 * fallback when it isn't. The fallback is not a toy — it executes the run
 * properly, just in the web process — because a developer running the stack on
 * a laptop should be able to press Run and watch it work without standing up
 * Redis first, and a single-instance deploy is a legitimate way to run this.
 *
 * What Redis buys, and why it's the recommended production shape:
 *
 *   • Long work stops competing with HTTP requests for the event loop. An
 *     architect session is a minute of model calls and page fetches; in-process
 *     that is a minute of added latency on everything else the instance serves.
 *   • Concurrency becomes a number you set, not a number you discover.
 *   • A crash mid-job leaves it on the queue instead of losing it.
 *
 * The scheduler is a single repeating job that sweeps for due workflows. One
 * sweep for all users rather than a timer per workflow: a thousand scheduled
 * workflows is one indexed range query a minute, not a thousand live timers.
 */

import { randomBytes } from 'crypto';
import { Queue, Worker } from 'bullmq';
import config from '../config/index.js';
import { AgentRun, AgentBuild, AgentWorkflow, User } from '../models/index.js';
import { executeRun } from './runner.js';
import { executeBuild } from './architect/index.js';
import { tryAcquireLock } from '../jobs/lock.js';
import { planAllows } from '../billing/plans.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('agentic:queue');

const RUN_QUEUE = 'agentic-runs';
const BUILD_QUEUE = 'agentic-builds';
const SWEEP_QUEUE = 'agentic-schedule';

/** BullMQ rejects custom job ids that contain `:`. Keep a stable, deduping prefix. */
function jobId(kind, id) {
  return `${kind}-${String(id)}`;
}

/**
 * Builds are continued on the same AgentBuild id. A fixed jobId makes BullMQ
 * ignore the second enqueue while a completed intake job is still retained.
 */
function uniqueBuildJobId(buildId) {
  return jobId('build', `${buildId}-${Date.now()}-${randomBytes(3).toString('hex')}`);
}

let runQueue = null;
let runWorker = null;
let buildQueue = null;
let buildWorker = null;
let sweepQueue = null;
let sweepWorker = null;
let sweepTimer = null;

function connection() {
  return process.env.REDIS_URL ? { url: process.env.REDIS_URL } : null;
}

export function isQueueConfigured() {
  return Boolean(process.env.REDIS_URL);
}

/**
 * Hand a queued run to a worker.
 *
 * Returns immediately in both modes. The inline path deliberately does not
 * await the run: the HTTP handler that called this needs to answer with a run
 * id so the client can start streaming, and awaiting here would hold the
 * response open for the entire execution.
 */
export async function enqueueRun({ runId, userId }) {
  if (!config.agentic.enabled) {
    throw new Error('Agentic runs are disabled on this server.');
  }

  if (!isQueueConfigured()) {
    runInline({ runId, userId });
    return { queued: false, inline: true };
  }

  if (!runQueue) runQueue = new Queue(RUN_QUEUE, { connection: connection() });

  await runQueue.add(
    'run',
    { runId: String(runId), userId: String(userId) },
    {
      // No automatic retries. Retrying a workflow is not safe in general — it
      // may have already sent an email, posted a webhook, or clicked "confirm
      // order". A failed run is presented to the user, who decides.
      attempts: 1,
      removeOnComplete: 100,
      removeOnFail: 200,
      jobId: jobId('run', runId),
    }
  );

  return { queued: true, inline: false };
}

/** Execute in this process. Errors are recorded on the run, never rethrown. */
function runInline({ runId, userId }) {
  setImmediate(async () => {
    try {
      const user = await User.findById(userId);
      if (!user) throw new Error('The run’s owner no longer exists.');
      await executeRun({ runId, user });
    } catch (err) {
      log.error('Inline run failed', { runId: String(runId), error: err.message });
      await markRunCrashed(runId, err.message);
    }
  });
}

/**
 * Write a terminal state for a run whose executor never got to.
 *
 * Without this a crashed run sits at `queued` forever, and the UI shows a
 * spinner with no way to tell "starting" from "never going to start".
 */
async function markRunCrashed(runId, message) {
  await AgentRun.updateOne(
    { _id: runId, status: { $in: ['queued', 'running'] } },
    {
      $set: {
        status: 'failed',
        error: `The run could not be started: ${String(message).slice(0, 300)}`,
        finishedAt: new Date(),
      },
    }
  ).catch(() => {});
}

// ─── Architect builds ───────────────────────────────────────

/**
 * Hand a queued architect session to a worker.
 *
 * Same shape as `enqueueRun` and for the same reason: the HTTP handler answers
 * with a build id so the client can open its stream and watch the architect
 * think, rather than holding a request open for ninety seconds and showing
 * nothing until it lands.
 */
export async function enqueueBuild({ buildId, userId }) {
  if (!isQueueConfigured()) {
    buildInline({ buildId, userId });
    return { queued: false, inline: true };
  }

  if (!buildQueue) buildQueue = new Queue(BUILD_QUEUE, { connection: connection() });

  await buildQueue.add(
    'build',
    { buildId: String(buildId), userId: String(userId) },
    {
      // No retries, for a softer version of the reason runs don't retry: a
      // build has already partially edited the graph and already charged for
      // the calls it made, so a silent second attempt doubles both.
      attempts: 1,
      removeOnComplete: 50,
      removeOnFail: 100,
      // Unique per enqueue — continues reuse the same buildId and must not
      // collide with the completed intake job still sitting in Redis.
      jobId: uniqueBuildJobId(buildId),
    }
  );

  log.info('Architect build enqueued', { buildId: String(buildId) });
  return { queued: true, inline: false };
}

function buildInline({ buildId, userId }) {
  setImmediate(async () => {
    try {
      const user = await User.findById(userId);
      if (!user) throw new Error('The build’s owner no longer exists.');
      await executeBuild({ buildId, user });
    } catch (err) {
      log.error('Inline build failed', { buildId: String(buildId), error: err.message });
      await markBuildCrashed(buildId, err.message);
    }
  });
}

async function markBuildCrashed(buildId, message) {
  await AgentBuild.updateOne(
    { _id: buildId, status: { $in: ['queued', 'running'] } },
    {
      $set: {
        status: 'failed',
        error: `The architect could not be started: ${String(message).slice(0, 300)}`,
        finishedAt: new Date(),
      },
    }
  ).catch(() => {});
}

/**
 * Builds left in `running` after a worker crash or deploy never finish on their
 * own — executeBuild refuses anything that isn't queued. Fail them after 15
 * minutes so the user can start again.
 */
export async function sweepStaleBuilds() {
  const cutoff = new Date(Date.now() - 15 * 60_000);
  const result = await AgentBuild.updateMany(
    {
      status: { $in: ['running', 'queued'] },
      $or: [
        { startedAt: { $lt: cutoff } },
        { startedAt: null, updatedAt: { $lt: cutoff } },
        { createdAt: { $lt: cutoff }, status: 'queued' },
      ],
    },
    {
      $set: {
        status: 'failed',
        error: 'The architect session timed out. Ask it to continue or rebuild.',
        finishedAt: new Date(),
      },
    }
  );
  if (result.modifiedCount) {
    log.warn('Marked stale architect builds as failed', { count: result.modifiedCount });
  }
  return result.modifiedCount;
}

// ─── Scheduler ──────────────────────────────────────────────

/**
 * When a schedule should next fire.
 *
 * Everything is computed in UTC, deliberately and without exception. The
 * setter pairs (`setHours` vs `setUTCHours`) are easy to mix, and mixing them
 * is invisible on a machine running at UTC — which every CI box and most dev
 * laptops in Europe are, and no Railway container has to be. On a host at
 * +05:30, a local `setHours(h + 1, 0, 0, 0)` lands on :30 past the hour, so an
 * hourly schedule quietly runs at the wrong time in production and nowhere
 * else. `atHour` is documented to the user as UTC for the same reason.
 */
export function computeNextRun(schedule, from = new Date()) {
  const next = new Date(from.getTime());
  const atHour = Math.min(23, Math.max(0, Number(schedule?.atHour) || 0));

  switch (schedule?.every) {
    case '15 minutes': {
      // Snap to the next quarter-hour boundary, so a fleet of schedules fires
      // on predictable marks rather than wherever each was last saved.
      const quarter = Math.floor(next.getUTCMinutes() / 15) + 1;
      next.setUTCMinutes(quarter * 15, 0, 0);
      return next;
    }
    case 'hour':
      next.setUTCHours(next.getUTCHours() + 1, 0, 0, 0);
      return next;
    case '6 hours':
      next.setUTCHours(next.getUTCHours() + 6, 0, 0, 0);
      return next;
    case 'week':
      next.setUTCDate(next.getUTCDate() + 7);
      next.setUTCHours(atHour, 0, 0, 0);
      return next;
    case 'day':
    default:
      next.setUTCDate(next.getUTCDate() + 1);
      next.setUTCHours(atHour, 0, 0, 0);
      return next;
  }
}

/**
 * Fire every workflow whose schedule is due, and re-arm it.
 *
 * The re-arm happens *before* the run is queued, and conditionally on the
 * document still holding the `nextRunAt` we read. That makes the sweep safe to
 * run concurrently on several instances: only one of them wins the update, and
 * only that one queues the run. Queue-then-update would double-fire under
 * exactly the conditions you'd never see in testing.
 */
export async function sweepSchedules() {
  await sweepStaleBuilds().catch(err =>
    log.warn('Stale build sweep failed', { error: err.message })
  );

  const now = new Date();

  const due = await AgentWorkflow.find({
    'schedule.enabled': true,
    'schedule.nextRunAt': { $lte: now },
    status: 'active',
    archivedAt: null,
  }).limit(100);

  let fired = 0;

  for (const workflow of due) {
    const previous = workflow.schedule.nextRunAt;
    const next = computeNextRun(workflow.schedule, now);

    const claimed = await AgentWorkflow.updateOne(
      { _id: workflow._id, 'schedule.nextRunAt': previous },
      { $set: { 'schedule.nextRunAt': next } }
    );
    if (!claimed.modifiedCount) continue;

    const user = await User.findById(workflow.user);
    if (!user) continue;

    // Re-check entitlement at fire time, not just at save time. A schedule set
    // up on Pro must stop firing when the account drops to Hobby — otherwise a
    // downgrade leaves paid capability running indefinitely, which is a revenue
    // leak with a cron attached to it.
    if (!planAllows(user.subscription?.plan, 'agentTriggers') && user.role !== 'admin') {
      await AgentWorkflow.updateOne(
        { _id: workflow._id },
        { $set: { 'schedule.enabled': false, status: 'paused' } }
      );
      log.info('Paused a schedule the plan no longer allows', {
        workflow: String(workflow._id),
        plan: user.subscription?.plan,
      });
      continue;
    }

    const run = await AgentRun.create({
      workflow: workflow._id,
      user: workflow.user,
      workflowVersion: workflow.version,
      workflowName: workflow.name,
      trigger: { type: 'schedule', payload: { firedAt: now.toISOString() } },
    });

    await enqueueRun({ runId: run._id, userId: workflow.user });
    fired += 1;
  }

  if (fired) log.info('Scheduled agentic runs fired', { fired });
  return { checked: due.length, fired };
}

// ─── Lifecycle ──────────────────────────────────────────────

export function startAgentWorkers() {
  if (!config.agentic.enabled) {
    log.info('Agentic runs disabled — no workers started');
    return;
  }

  if (!isQueueConfigured()) {
    // Same advisory-lock pattern the reminder job uses, so several replicas
    // without Redis still produce one sweep rather than one each.
    sweepTimer = setInterval(() => {
      tryAcquireLock('agentic:sweep', 55_000)
        .then(acquired => (acquired ? sweepSchedules() : null))
        .catch(err => log.warn('Schedule sweep failed', { error: err.message }));
    }, 60_000);
    sweepTimer.unref?.();
    log.info('Agentic runs executing in-process (no REDIS_URL)');
    return;
  }

  runWorker = new Worker(
    RUN_QUEUE,
    async job => {
      const user = await User.findById(job.data.userId);
      if (!user) throw new Error('The run’s owner no longer exists.');
      await executeRun({ runId: job.data.runId, user });
    },
    {
      connection: connection(),
      concurrency: Number(process.env.AGENT_WORKER_CONCURRENCY) || 4,
      // A run legitimately takes minutes. The default 30s lock would have
      // BullMQ declare it stalled and hand it to a second worker, which then
      // runs the same side effects again.
      lockDuration: config.agentic.maxRunMs + 60_000,
    }
  );

  runWorker.on('failed', (job, err) => {
    log.warn('Agentic run job failed', { runId: job?.data?.runId, error: err.message });
    if (job?.data?.runId) markRunCrashed(job.data.runId, err.message);
  });

  buildWorker = new Worker(
    BUILD_QUEUE,
    async job => {
      const user = await User.findById(job.data.userId);
      if (!user) throw new Error('The build’s owner no longer exists.');
      await executeBuild({ buildId: job.data.buildId, user });
    },
    {
      connection: connection(),
      // Lower than runs. A build is almost entirely waiting on model calls and
      // page fetches, so it is cheap in CPU and expensive in tokens — the
      // limiting resource is the provider's rate limit, not this box.
      concurrency: Number(process.env.AGENT_BUILD_CONCURRENCY) || 3,
      lockDuration: 10 * 60_000,
    }
  );

  buildWorker.on('failed', (job, err) => {
    log.warn('Architect build job failed', { buildId: job?.data?.buildId, error: err.message });
    if (job?.data?.buildId) markBuildCrashed(job.data.buildId, err.message);
  });

  sweepWorker = new Worker(SWEEP_QUEUE, async () => sweepSchedules(), {
    connection: connection(),
  });
  sweepWorker.on('failed', (_job, err) =>
    log.warn('Schedule sweep job failed', { error: err.message })
  );

  sweepQueue = new Queue(SWEEP_QUEUE, { connection: connection() });
  sweepQueue
    .add('sweep', {}, { repeat: { every: 60_000 }, removeOnComplete: 10, jobId: 'agentic-sweep' })
    .catch(err => log.warn('Could not schedule the sweep', { error: err.message }));

  runQueue = runQueue || new Queue(RUN_QUEUE, { connection: connection() });
  buildQueue = buildQueue || new Queue(BUILD_QUEUE, { connection: connection() });

  log.info('Agentic workers started', {
    runConcurrency: Number(process.env.AGENT_WORKER_CONCURRENCY) || 4,
    buildConcurrency: Number(process.env.AGENT_BUILD_CONCURRENCY) || 3,
  });
}

export async function stopAgentWorkers() {
  if (sweepTimer) clearInterval(sweepTimer);
  await Promise.allSettled([
    runWorker?.close(),
    buildWorker?.close(),
    sweepWorker?.close(),
    runQueue?.close(),
    buildQueue?.close(),
    sweepQueue?.close(),
  ]);
}

export default {
  enqueueRun,
  enqueueBuild,
  sweepSchedules,
  sweepStaleBuilds,
  computeNextRun,
  startAgentWorkers,
  stopAgentWorkers,
  isQueueConfigured,
};
