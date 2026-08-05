/**
 * Agentic workflow API.
 *
 *   GET    /api/agents/registry              node manifest (drives the whole editor)
 *   GET    /api/agents                       list
 *   POST   /api/agents                       create (optionally starts a build)
 *   GET    /api/agents/:id                   load into the editor
 *   PATCH  /api/agents/:id                   save graph / rename / schedule
 *   DELETE /api/agents/:id                   archive
 *   POST   /api/agents/:id/build             ask the architect to build or edit
 *   GET    /api/agents/:id/builds            build history
 *   POST   /api/agents/:id/repair            ask the architect to fix a failed run
 *   PUT    /api/agents/:id/requirements/:key attach a credential to a requirement
 *   POST   /api/agents/:id/run               queue a run
 *   GET    /api/agents/:id/runs              run history
 *   GET    /api/agents/builds/:buildId       one build
 *   GET    /api/agents/builds/:buildId/stream  live SSE
 *   POST   /api/agents/builds/:buildId/cancel
 *   GET    /api/agents/runs/:runId           one run
 *   GET    /api/agents/runs/:runId/stream    live SSE
 *   POST   /api/agents/runs/:runId/cancel
 *   ALL    /api/agents/:id/webhook/:token    inbound trigger (unauthenticated)
 *   …plus credential CRUD.
 *
 * Entitlement lives in the routes, not here — see `agentRoutes.js`. The one
 * exception is the webhook, which is deliberately unauthenticated (that is the
 * point of a webhook) and therefore has to do its own plan and ownership checks
 * against the workflow's owner rather than a request user.
 */

import mongoose from 'mongoose';
import config from '../config/index.js';
import { AgentWorkflow, AgentRun, AgentBuild, AgentCredential, User } from '../models/index.js';
import { publicRegistry, getNodeDef } from '../agentic/registry.js';
import { validateGraph, suggestNodeId } from '../agentic/graph.js';
import { enqueueRun, enqueueBuild, computeNextRun } from '../agentic/queue.js';
import { syncWorkflowSchedule } from '../agentic/scheduleSync.js';
import { cancelRun, activeRunCount } from '../agentic/runner.js';
import { cancelBuild, activeBuildCount } from '../agentic/architect/index.js';
import { subscribe } from '../agentic/events.js';
import { isWebSearchConfigured } from '../ai/tools/webSearch.js';
import { isLLMAvailable } from '../ai/llm.js';
import { planAllows, planLimit, creditCost } from '../billing/plans.js';
import { checkLimit, isUnmetered } from '../billing/credits.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('agents');

/** Load a workflow the caller owns, or send the 404 and return null. */
async function ownedWorkflow(req, res) {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(404).json({ success: false, message: 'Workflow not found.' });
    return null;
  }
  const workflow = await AgentWorkflow.findOne({
    _id: req.params.id,
    user: req.user._id,
    archivedAt: null,
  });
  if (!workflow) {
    res.status(404).json({ success: false, message: 'Workflow not found.' });
    return null;
  }
  return workflow;
}

/** Re-run the validator against the current graph *and* requirements. */
function revalidate(workflow) {
  const nodes = workflow.graph.nodes.map(n => n.toObject?.() ?? n);
  const edges = workflow.graph.edges.map(e => e.toObject?.() ?? e);
  return validateGraph({ nodes, edges }, { requirements: workflow.requirements || [] });
}

// ─── Registry ───────────────────────────────────────────────

export const getRegistry = asyncHandler(async (req, res) => {
  const plan = req.user?.subscription?.plan;
  res.json({
    success: true,
    data: {
      ...publicRegistry(),
      /**
       * Capability report alongside the manifest, so the editor can explain
       * itself with a real reason rather than letting the user build something
       * that fails on its first run. The distinction between "your plan doesn't
       * include this" and "this deployment isn't configured for it" matters:
       * they need completely different actions from the user, and collapsing
       * them sends people to the pricing page to fix a server setting.
       */
      capabilities: {
        agentic: config.agentic.enabled,
        llm: isLLMAvailable(),
        webSearch: isWebSearchConfigured(),
        plan: {
          agenticWorkflows: planAllows(plan, 'agenticWorkflows'),
          agentTriggers: planAllows(plan, 'agentTriggers'),
          maxWorkflows: planLimit(plan, 'agentWorkflows'),
        },
      },
      pricing: {
        runBase: creditCost('agent.run'),
        buildStep: creditCost('agent.build'),
      },
    },
  });
});

// ─── CRUD ───────────────────────────────────────────────────

export const listWorkflows = asyncHandler(async (req, res) => {
  const workflows = await AgentWorkflow.find({ user: req.user._id, archivedAt: null })
    .sort({ updatedAt: -1 })
    .limit(200);

  const used = workflows.length;
  const limit = checkLimit(req.user, 'agentWorkflows', used);

  res.json({
    success: true,
    data: {
      workflows: workflows.map(w => w.toListJSON()),
      quota: { used, max: limit.limit, unlimited: limit.unlimited },
    },
  });
});

/**
 * Create a workflow, and optionally set the architect going on it immediately.
 *
 * The `prompt` path is the primary one: someone types what they want and gets a
 * workflow being built in front of them. Creating an empty canvas and asking
 * them to find the palette is the fallback for people who already know what
 * they're doing, not the front door.
 */
export const createWorkflow = asyncHandler(async (req, res) => {
  const prompt = String(req.body.prompt || '').trim();

  // A workflow with nothing on the canvas is a dead end. Seeding the trigger
  // means the first thing anyone sees is a graph they can extend.
  const triggerType = 'trigger.manual';
  const triggerId = suggestNodeId(triggerType, []);

  const workflow = await AgentWorkflow.create({
    user: req.user._id,
    name: String(req.body.name || (prompt ? 'Untitled workflow' : 'New workflow')).slice(0, 120),
    description: String(req.body.description || '').slice(0, 600),
    graph: {
      nodes: [
        {
          id: triggerId,
          type: triggerType,
          position: { x: 300, y: 90 },
          data: { title: getNodeDef(triggerType).label, values: {}, note: '' },
        },
      ],
      edges: [],
    },
    composedFrom: prompt.slice(0, 2000),
  });

  log.info('Agentic workflow created', {
    user: String(req.user._id),
    workflow: String(workflow._id),
    withPrompt: Boolean(prompt),
  });

  let buildId = null;
  if (prompt) {
    const build = await startBuildFor({ workflow, user: req.user, message: prompt, intent: 'build' });
    buildId = String(build._id);
  }

  res.status(201).json({ success: true, data: { ...workflow.toEditorJSON(), buildId } });
});

export const getWorkflow = asyncHandler(async (req, res) => {
  const workflow = await ownedWorkflow(req, res);
  if (!workflow) return;
  res.json({ success: true, data: workflow.toEditorJSON() });
});

export const updateWorkflow = asyncHandler(async (req, res) => {
  const workflow = await ownedWorkflow(req, res);
  if (!workflow) return;

  if (req.body.name !== undefined) workflow.name = String(req.body.name).slice(0, 120);
  if (req.body.description !== undefined) {
    workflow.description = String(req.body.description).slice(0, 600);
  }
  if (req.body.status && ['draft', 'active', 'paused'].includes(req.body.status)) {
    workflow.status = req.body.status;
  }

  if (req.body.graph) {
    const { nodes = [], edges = [] } = req.body.graph;

    if (nodes.length > config.agentic.maxNodes) {
      return res.status(400).json({
        success: false,
        message: `A workflow can have at most ${config.agentic.maxNodes} nodes.`,
      });
    }

    workflow.graph = { nodes, edges };
    workflow.version += 1;
    workflow.validation = { ...revalidate(workflow), checkedAt: new Date() };
    syncWorkflowSchedule(workflow);
  }

  if (req.body.schedule) {
    if (
      req.body.schedule.enabled &&
      !planAllows(req.user.subscription?.plan, 'agentTriggers') &&
      !isUnmetered(req.user)
    ) {
      return res.status(403).json({
        success: false,
        code: 'FEATURE_NOT_IN_PLAN',
        message: 'Scheduled triggers aren’t included in your plan.',
      });
    }

    workflow.schedule.enabled = Boolean(req.body.schedule.enabled);
    if (req.body.schedule.atHour !== undefined) {
      workflow.schedule.atHour = Math.min(23, Math.max(0, Number(req.body.schedule.atHour) || 0));
    }
    workflow.schedule.every = 'day';

    const trigger = workflow.graph?.nodes?.find(node => node.type === 'trigger.schedule');
    if (trigger) {
      trigger.data = trigger.data || {};
      trigger.data.values = trigger.data.values || {};
      trigger.data.values.atHour = String(workflow.schedule.atHour);
      if (req.body.schedule.weekdaysOnly !== undefined) {
        trigger.data.values.weekdaysOnly = Boolean(req.body.schedule.weekdaysOnly);
      }
    }

    workflow.schedule.nextRunAt = workflow.schedule.enabled
      ? computeNextRun(workflow.schedule)
      : null;
  }

  await workflow.save();
  res.json({ success: true, data: workflow.toEditorJSON() });
});

export const deleteWorkflow = asyncHandler(async (req, res) => {
  const workflow = await ownedWorkflow(req, res);
  if (!workflow) return;

  // Archive rather than delete. Runs reference the workflow, and a hard delete
  // turns a month of run history into rows pointing at nothing — which is
  // exactly the history someone wants when asking "what was this charge?".
  workflow.archivedAt = new Date();
  workflow.schedule.enabled = false;
  workflow.schedule.nextRunAt = null;
  workflow.status = 'paused';
  await workflow.save();

  res.json({ success: true, message: 'Workflow archived.' });
});

// ─── Requirements ───────────────────────────────────────────

/**
 * Attach a credential the user just created to the requirement it satisfies.
 *
 * Separate from credential creation on purpose. A credential is an account-wide
 * secret that several workflows may use; a requirement is one workflow saying
 * it needs one. Merging them would either re-prompt for the same Notion token
 * on every workflow, or silently bind a secret to a workflow the user never
 * meant to give it to.
 */
export const setRequirementCredential = asyncHandler(async (req, res) => {
  const workflow = await ownedWorkflow(req, res);
  if (!workflow) return;

  const requirement = (workflow.requirements || []).find(r => r.key === req.params.key);
  if (!requirement) {
    return res.status(404).json({ success: false, message: 'No such requirement.' });
  }

  const credentialId = req.body.credentialId || null;

  if (credentialId) {
    const credential = await AgentCredential.findOne({ _id: credentialId, user: req.user._id });
    if (!credential) {
      return res.status(404).json({ success: false, message: 'Credential not found.' });
    }
    requirement.credentialId = credential._id;

    // Push it onto the nodes that declared they need it, so the user doesn't
    // have to open each one and pick the same credential again. That double
    // entry is the single most confusing part of every automation tool that
    // has both a checklist and a per-node picker.
    for (const node of workflow.graph.nodes) {
      if (!requirement.usedBy.includes(node.id)) continue;
      const def = getNodeDef(node.type);
      const field = def?.fields.find(f => f.type === 'credential');
      if (field) node.data.values = { ...node.data.values, [field.key]: String(credential._id) };
    }
    workflow.markModified('graph.nodes');
  } else {
    requirement.credentialId = null;
  }

  workflow.validation = { ...revalidate(workflow), checkedAt: new Date() };
  await workflow.save();

  res.json({ success: true, data: workflow.toEditorJSON() });
});

// ─── Architect ──────────────────────────────────────────────

/**
 * Messages from earlier architect sessions on this workflow.
 *
 * Each build is its own document, but follow-ups ("build it", "also send to
 * Slack") should not start from zero — the prior goal, summary and turns are
 * folded in so the model keeps what was already researched and decided.
 */
async function loadPriorMessages(workflowId, { excludeBuildId } = {}) {
  const query = {
    workflow: workflowId,
    status: { $in: ['succeeded', 'failed', 'canceled'] },
  };
  if (excludeBuildId) query._id = { $ne: excludeBuildId };

  const priorBuilds = await AgentBuild.find(query)
    .sort({ createdAt: -1 })
    .limit(4)
    .select('messages goal summary');

  const merged = [];
  for (const prior of priorBuilds.reverse()) {
    if (prior.messages?.length) {
      for (const message of prior.messages) merged.push(message);
      continue;
    }
    if (prior.goal) merged.push({ role: 'user', content: prior.goal });
    if (prior.summary) merged.push({ role: 'assistant', content: prior.summary });
  }

  return merged.slice(-20);
}

/** Create the build document and hand it to a worker. Shared by three routes. */
async function startBuildFor({ workflow, user, message, intent }) {
  const priorMessages = await loadPriorMessages(workflow._id);
  const messages = [
    ...priorMessages,
    { role: 'user', content: message.slice(0, 8000) },
  ];

  const build = await AgentBuild.create({
    workflow: workflow._id,
    user: user._id,
    intent,
    goal: message.slice(0, 4000),
    messages,
  });

  await enqueueBuild({ buildId: build._id, userId: user._id });
  return build;
}

export const startBuild = asyncHandler(async (req, res) => {
  const workflow = await ownedWorkflow(req, res);
  if (!workflow) return;

  if (!isLLMAvailable()) {
    return res.status(503).json({
      success: false,
      code: 'AI_DISABLED',
      message: 'The architect needs an AI provider, and none is configured on this server.',
    });
  }

  const concurrency = config.agentic.architectConcurrency;
  if (activeBuildCount(req.user._id) >= concurrency) {
    return res.status(429).json({
      success: false,
      code: 'TOO_MANY_BUILDS',
      message: `You already have ${concurrency} architect session${concurrency === 1 ? '' : 's'} running.`,
    });
  }

  const message = String(req.body.message || '').trim();
  if (!message) {
    return res.status(400).json({ success: false, message: 'Tell the architect what to build.' });
  }

  // An existing graph with more than its seed trigger means this is an edit,
  // and the architect opens with different instructions for one.
  const intent = workflow.graph.nodes.length > 1 ? 'edit' : 'build';
  const build = await startBuildFor({ workflow, user: req.user, message, intent });

  res.status(202).json({
    success: true,
    data: { buildId: String(build._id), status: 'queued', intent },
  });
});

/**
 * Ask the architect to fix a run that failed.
 *
 * The failing step's configuration and the exact error are handed over as the
 * opening message rather than left for the architect to go and find, because
 * the whole value of this button is that the user did not have to read a stack
 * trace to press it.
 */
export const repairWorkflow = asyncHandler(async (req, res) => {
  const workflow = await ownedWorkflow(req, res);
  if (!workflow) return;

  if (!isLLMAvailable()) {
    return res.status(503).json({
      success: false,
      code: 'AI_DISABLED',
      message: 'The architect needs an AI provider, and none is configured on this server.',
    });
  }

  const run = await AgentRun.findOne({
    _id: mongoose.isValidObjectId(req.body.runId) ? req.body.runId : new mongoose.Types.ObjectId(),
    workflow: workflow._id,
    user: req.user._id,
  });

  if (!run) return res.status(404).json({ success: false, message: 'Run not found.' });
  if (run.status !== 'failed') {
    return res.status(400).json({ success: false, message: 'That run didn’t fail — there’s nothing to repair.' });
  }

  const failedStep = run.steps.find(step => step.status === 'failed');
  const node = workflow.graph.nodes.find(n => n.id === run.failedNodeId);
  const def = node ? getNodeDef(node.type) : null;

  const message =
    `A run of this workflow failed.\n\n` +
    `FAILING STEP: ${run.failedNodeId || 'unknown'}` +
    (def ? ` (${def.type} — ${def.label})` : '') +
    `\nERROR: ${run.error}\n\n` +
    (node
      ? `ITS CONFIGURATION:\n${JSON.stringify(node.data?.values ?? {}, null, 2)}\n\n`
      : '') +
    (failedStep?.output ? `WHAT IT RETURNED:\n${JSON.stringify(failedStep.output).slice(0, 2000)}\n\n` : '') +
    `STEPS THAT SUCCEEDED BEFORE IT:\n` +
    (run.steps
      .filter(step => step.status === 'done')
      .map(step => `  ${step.nodeId}: ${JSON.stringify(step.output).slice(0, 400)}`)
      .join('\n') || '  (none)') +
    `\n\nFind the real cause and fix it.`;

  const build = await startBuildFor({ workflow, user: req.user, message, intent: 'repair' });

  res.status(202).json({ success: true, data: { buildId: String(build._id), status: 'queued' } });
});

export const listBuilds = asyncHandler(async (req, res) => {
  const workflow = await ownedWorkflow(req, res);
  if (!workflow) return;

  const builds = await AgentBuild.find({ workflow: workflow._id })
    .sort({ createdAt: -1 })
    .limit(Math.min(Number(req.query.limit) || 20, 50))
    // The timeline is the bulk of a build document and nothing in a list
    // renders it.
    .select('-timeline');

  res.json({
    success: true,
    data: builds.map(build => ({
      id: String(build._id),
      status: build.status,
      intent: build.intent,
      goal: build.goal,
      summary: build.summary,
      error: build.error,
      steps: build.steps,
      credits: build.credits,
      createdAt: build.createdAt,
      finishedAt: build.finishedAt,
    })),
  });
});

export const getBuild = asyncHandler(async (req, res) => {
  const build = await AgentBuild.findOne({ _id: req.params.buildId, user: req.user._id });
  if (!build) return res.status(404).json({ success: false, message: 'Build not found.' });
  res.json({ success: true, data: build.toJSONSafe() });
});

/**
 * Resume a finished architect session in place.
 *
 * Follow-ups belong on the same timeline — opening a fresh build for "build it"
 * after a planning pass throws away the plan the user was just watching and
 * makes the session list look like amnesia.
 */
export const continueBuild = asyncHandler(async (req, res) => {
  const build = await AgentBuild.findOne({ _id: req.params.buildId, user: req.user._id });
  if (!build) return res.status(404).json({ success: false, message: 'Build not found.' });

  if (!['succeeded', 'failed', 'canceled'].includes(build.status)) {
    return res.status(400).json({ success: false, message: 'That session is still running.' });
  }

  if (!isLLMAvailable()) {
    return res.status(503).json({
      success: false,
      code: 'AI_DISABLED',
      message: 'The architect needs an AI provider, and none is configured on this server.',
    });
  }

  const concurrency = config.agentic.architectConcurrency;
  if (activeBuildCount(req.user._id) >= concurrency) {
    return res.status(429).json({
      success: false,
      code: 'TOO_MANY_BUILDS',
      message: `You already have ${concurrency} architect session${concurrency === 1 ? '' : 's'} running.`,
    });
  }

  const message = String(req.body.message || '').trim();
  if (!message) {
    return res.status(400).json({ success: false, message: 'Tell the architect what to do next.' });
  }

  const workflow = await AgentWorkflow.findOne({ _id: build.workflow, user: req.user._id });
  if (!workflow) return res.status(404).json({ success: false, message: 'Workflow not found.' });

  build.messages.push({ role: 'user', content: message.slice(0, 8000), at: new Date() });
  build.status = 'queued';
  build.error = null;
  build.finishedAt = null;
  if (workflow.graph.nodes.length > 1) build.intent = 'edit';
  await build.save();

  await enqueueBuild({ buildId: build._id, userId: req.user._id });

  res.status(202).json({
    success: true,
    data: { buildId: String(build._id), status: 'queued', continued: true },
  });
});

export const cancelBuildHandler = asyncHandler(async (req, res) => {
  const build = await AgentBuild.findOne({ _id: req.params.buildId, user: req.user._id });
  if (!build) return res.status(404).json({ success: false, message: 'Build not found.' });

  const stopped = cancelBuild(build._id);

  if (!stopped && build.status === 'queued') {
    build.status = 'canceled';
    build.finishedAt = new Date();
    await build.save();
  }

  res.json({ success: true, data: { canceled: true, wasRunning: stopped } });
});

/**
 * Live architect feed.
 *
 * Sends the current state first, then streams changes — every client connects
 * late by definition, because the build is queued before the stream opens, and
 * one that only received subsequent events would render a build that appears to
 * start halfway through its own reasoning.
 */
export const streamBuild = asyncHandler(async (req, res) => {
  const build = await AgentBuild.findOne({ _id: req.params.buildId, user: req.user._id });
  if (!build) return res.status(404).json({ success: false, message: 'Build not found.' });

  openStream(res);
  const send = sender(res);

  send('build.snapshot', build.toJSONSafe());

  if (['succeeded', 'failed', 'canceled'].includes(build.status)) {
    const workflow = await AgentWorkflow.findById(build.workflow);
    send('build.finished', {
      status: build.status,
      summary: build.summary,
      error: build.error,
      credits: build.credits,
      workflow: workflow ? workflow.toEditorJSON() : null,
    });
    return res.end();
  }

  keepAlive({ req, res, id: build._id, send, endOn: 'build.finished' });
});

// ─── Runs ───────────────────────────────────────────────────

/** Everything both the manual and webhook paths need to check before running. */
async function guardRun({ workflow, user }) {
  if (!config.agentic.enabled) {
    return { ok: false, status: 503, message: 'Agentic runs are disabled on this server.' };
  }

  if (!planAllows(user.subscription?.plan, 'agenticWorkflows') && !isUnmetered(user)) {
    return {
      ok: false,
      status: 403,
      code: 'FEATURE_NOT_IN_PLAN',
      message: 'Agentic workflows aren’t included in your plan.',
    };
  }

  const validation = revalidate(workflow);
  if (validation.errors.length) {
    return {
      ok: false,
      status: 400,
      code: 'GRAPH_INVALID',
      message: validation.errors[0],
      data: { errors: validation.errors },
    };
  }

  // Concurrency is counted in-process, which under BullMQ across several
  // workers is a floor rather than a ceiling. It is enough to stop the case
  // that actually happens — one person hammering Run — and the real spend
  // ceiling is the credit balance, which is atomic.
  const concurrency = checkLimit(user, 'agentConcurrency', activeRunCount(user._id));
  if (!concurrency.allowed) {
    return {
      ok: false,
      status: 429,
      code: 'TOO_MANY_RUNS',
      message: `Your plan allows ${concurrency.limit} run${concurrency.limit === 1 ? '' : 's'} at a time.`,
    };
  }

  const periodStart = user.subscription?.periodStart || new Date(0);
  const runsThisPeriod = await AgentRun.countDocuments({
    user: user._id,
    createdAt: { $gte: periodStart },
  });
  const runQuota = checkLimit(user, 'agentRunsPerMonth', runsThisPeriod);
  if (!runQuota.allowed) {
    return {
      ok: false,
      status: 403,
      code: 'PLAN_LIMIT_REACHED',
      message: `You've used all ${runQuota.limit} agentic runs on your plan this period.`,
    };
  }

  return { ok: true };
}

export const runWorkflow = asyncHandler(async (req, res) => {
  const workflow = await ownedWorkflow(req, res);
  if (!workflow) return;

  const guard = await guardRun({ workflow, user: req.user });
  if (!guard.ok) {
    return res.status(guard.status).json({
      success: false,
      code: guard.code,
      message: guard.message,
      data: guard.data,
    });
  }

  const run = await AgentRun.create({
    workflow: workflow._id,
    user: req.user._id,
    workflowVersion: workflow.version,
    workflowName: workflow.name,
    trigger: { type: 'manual', payload: req.body.input || {} },
  });

  await enqueueRun({ runId: run._id, userId: req.user._id });

  // 202: the run exists and is addressable, but nothing has happened yet. The
  // client opens the stream against this id and watches it start.
  res.status(202).json({ success: true, data: { runId: String(run._id), status: 'queued' } });
});

export const listRuns = asyncHandler(async (req, res) => {
  const workflow = await ownedWorkflow(req, res);
  if (!workflow) return;

  const runs = await AgentRun.find({ workflow: workflow._id })
    .sort({ createdAt: -1 })
    .limit(Math.min(Number(req.query.limit) || 25, 100))
    // Steps and logs are the bulk of a run document and nothing in a list view
    // renders them.
    .select('-steps -logs -output');

  res.json({
    success: true,
    data: runs.map(r => ({
      id: String(r._id),
      status: r.status,
      trigger: r.trigger?.type,
      credits: r.credits?.total || 0,
      error: r.error,
      failedNodeId: r.failedNodeId,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      createdAt: r.createdAt,
    })),
  });
});

export const getRun = asyncHandler(async (req, res) => {
  const run = await AgentRun.findOne({ _id: req.params.runId, user: req.user._id });
  if (!run) return res.status(404).json({ success: false, message: 'Run not found.' });
  res.json({ success: true, data: run.toJSONSafe() });
});

export const cancelRunHandler = asyncHandler(async (req, res) => {
  const run = await AgentRun.findOne({ _id: req.params.runId, user: req.user._id });
  if (!run) return res.status(404).json({ success: false, message: 'Run not found.' });

  const stopped = cancelRun(run._id);

  // A run this instance isn't executing still gets marked canceled, so a queued
  // job that hasn't started anywhere yet stops mattering. The runner refuses to
  // execute anything that isn't `queued`, which closes the race.
  if (!stopped && run.status === 'queued') {
    run.status = 'canceled';
    run.finishedAt = new Date();
    await run.save();
  }

  res.json({ success: true, data: { canceled: true, wasRunning: stopped } });
});

export const streamRun = asyncHandler(async (req, res) => {
  const run = await AgentRun.findOne({ _id: req.params.runId, user: req.user._id });
  if (!run) return res.status(404).json({ success: false, message: 'Run not found.' });

  openStream(res);
  const send = sender(res);

  send('run.snapshot', run.toJSONSafe());

  if (['succeeded', 'failed', 'canceled'].includes(run.status)) {
    send('run.finished', { status: run.status, error: run.error, credits: run.credits });
    return res.end();
  }

  keepAlive({ req, res, id: run._id, send, endOn: 'run.finished' });
});

// ─── SSE plumbing ───────────────────────────────────────────
// Shared by runs and builds. Both are "watch a long thing happen", and having
// written it twice with a subtle difference in the cleanup path once already,
// once is enough.

function openStream(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
}

function sender(res) {
  return (event, data) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
}

function keepAlive({ req, res, id, send, endOn }) {
  const unsubscribe = subscribe(id, event => {
    send(event.type, event);
    if (event.type === endOn) {
      cleanup();
      res.end();
    }
  });

  // Proxies close an idle connection well before a long build finishes.
  const ping = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, 20_000);

  const cleanup = () => {
    unsubscribe();
    clearInterval(ping);
  };

  req.on('close', cleanup);
}

// ─── Webhook trigger ────────────────────────────────────────

/**
 * Unauthenticated inbound trigger.
 *
 * The token in the path is the whole authentication story, which is what a
 * webhook is. Everything that would normally come from `req.user` is derived
 * from the workflow's owner instead, and every check the manual path makes is
 * repeated here — a webhook that skipped the plan check would be a way to run
 * paid features from a free account by pasting a URL.
 */
export const webhookTrigger = asyncHandler(async (req, res) => {
  const workflow = await AgentWorkflow.findOne({
    _id: mongoose.isValidObjectId(req.params.id) ? req.params.id : new mongoose.Types.ObjectId(),
    webhookToken: req.params.token,
    archivedAt: null,
  });

  // One message for "wrong id" and "wrong token" alike: distinguishing them
  // turns this endpoint into an oracle for which workflow ids exist.
  if (!workflow) {
    return res.status(404).json({ success: false, message: 'Unknown webhook.' });
  }

  const hasWebhookTrigger = workflow.graph.nodes.some(n => n.type === 'trigger.webhook');
  if (!hasWebhookTrigger) {
    return res.status(400).json({
      success: false,
      message: 'This workflow has no webhook trigger.',
    });
  }

  if (workflow.status !== 'active') {
    return res.status(409).json({
      success: false,
      message: 'This workflow isn’t active. Activate it to accept webhook calls.',
    });
  }

  const owner = await User.findById(workflow.user);
  if (!owner) return res.status(404).json({ success: false, message: 'Unknown webhook.' });

  if (!planAllows(owner.subscription?.plan, 'agentTriggers') && !isUnmetered(owner)) {
    return res.status(403).json({
      success: false,
      message: 'The owning account’s plan doesn’t include webhook triggers.',
    });
  }

  const guard = await guardRun({ workflow, user: owner });
  if (!guard.ok) {
    return res.status(guard.status).json({ success: false, message: guard.message });
  }

  const run = await AgentRun.create({
    workflow: workflow._id,
    user: workflow.user,
    workflowVersion: workflow.version,
    workflowName: workflow.name,
    trigger: {
      type: 'webhook',
      payload: {
        body: req.body || {},
        query: req.query || {},
        // Only the headers a workflow plausibly branches on. Forwarding all of
        // them would put the caller's own Authorization header into a document
        // the owner can read in the run console.
        headers: {
          'content-type': req.get('content-type') || '',
          'user-agent': req.get('user-agent') || '',
        },
      },
    },
  });

  await enqueueRun({ runId: run._id, userId: workflow.user });

  res.status(202).json({ success: true, data: { runId: String(run._id) } });
});

// ─── Credentials ────────────────────────────────────────────

export const listCredentials = asyncHandler(async (req, res) => {
  const credentials = await AgentCredential.find({ user: req.user._id }).sort({ createdAt: -1 });
  res.json({ success: true, data: credentials.map(c => c.toJSONSafe()) });
});

export const createCredential = asyncHandler(async (req, res) => {
  const existing = await AgentCredential.findOne({ user: req.user._id, name: req.body.name });
  if (existing) {
    return res.status(409).json({
      success: false,
      message: 'You already have a credential with that name.',
    });
  }

  const credential = new AgentCredential({
    user: req.user._id,
    name: String(req.body.name).slice(0, 80),
    provider: req.body.provider || 'generic',
    scheme: req.body.scheme || 'bearer',
    paramName: String(req.body.paramName || 'Authorization').slice(0, 80),
  });
  credential.plaintext = req.body.value;
  await credential.save();

  res.status(201).json({ success: true, data: credential.toJSONSafe() });
});

export const deleteCredential = asyncHandler(async (req, res) => {
  const deleted = await AgentCredential.findOneAndDelete({
    _id: req.params.credentialId,
    user: req.user._id,
  });
  if (!deleted) return res.status(404).json({ success: false, message: 'Credential not found.' });

  // Any requirement pointing at it is now unsatisfied, and the workflows that
  // depend on it need to say so rather than failing on their next run with a
  // credential-missing error three steps in.
  await AgentWorkflow.updateMany(
    { user: req.user._id, 'requirements.credentialId': deleted._id },
    { $set: { 'requirements.$[entry].credentialId': null } },
    { arrayFilters: [{ 'entry.credentialId': deleted._id }] }
  ).catch(err => log.warn('Could not detach a deleted credential', { error: err.message }));

  res.json({ success: true, message: 'Credential deleted.' });
});

export default {
  getRegistry,
  listWorkflows,
  createWorkflow,
  getWorkflow,
  updateWorkflow,
  deleteWorkflow,
  setRequirementCredential,
  startBuild,
  continueBuild,
  repairWorkflow,
  listBuilds,
  getBuild,
  streamBuild,
  cancelBuildHandler,
  runWorkflow,
  listRuns,
  getRun,
  streamRun,
  cancelRunHandler,
  webhookTrigger,
  listCredentials,
  createCredential,
  deleteCredential,
};
