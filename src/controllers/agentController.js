/**
 * Agentic workflow API.
 *
 *   GET    /api/agents/registry          node manifest (drives the whole editor)
 *   GET    /api/agents                   list
 *   POST   /api/agents                   create
 *   GET    /api/agents/:id               load into the editor
 *   PATCH  /api/agents/:id               save graph / rename / schedule
 *   DELETE /api/agents/:id               archive
 *   POST   /api/agents/:id/compose       build or edit by chat
 *   POST   /api/agents/:id/run           queue a run
 *   GET    /api/agents/:id/runs          run history
 *   GET    /api/agents/runs/:runId       one run
 *   GET    /api/agents/runs/:runId/stream  live SSE
 *   POST   /api/agents/runs/:runId/cancel
 *   ALL    /api/agents/:id/webhook/:token inbound trigger (unauthenticated)
 *   …plus credential CRUD.
 *
 * Entitlement lives in the routes, not here — see `agentRoutes.js`. The one
 * exception is the webhook, which is deliberately unauthenticated (that is the
 * point of a webhook) and therefore has to do its own plan and ownership checks
 * against the workflow's owner rather than a request user.
 */

import mongoose from 'mongoose';
import config from '../config/index.js';
import { AgentWorkflow, AgentRun, AgentCredential, User } from '../models/index.js';
import { publicRegistry, getNodeDef, needsBrowser } from '../agentic/registry.js';
import { validateGraph, suggestNodeId } from '../agentic/graph.js';
import { compose } from '../agentic/composer.js';
import { enqueueRun, computeNextRun } from '../agentic/queue.js';
import { cancelRun, activeRunCount } from '../agentic/runner.js';
import {
  isBrowserConfigured,
  browserCapabilities,
  getReplayPlaylist,
} from '../agentic/browser/session.js';
import { subscribe } from '../agentic/events.js';
import { planAllows, planLimit, BROWSER_MINUTE_COST, creditCost } from '../billing/plans.js';
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

// ─── Registry ───────────────────────────────────────────────

export const getRegistry = asyncHandler(async (req, res) => {
  const plan = req.user?.subscription?.plan;
  const browser = browserCapabilities();
  res.json({
    success: true,
    data: {
      ...publicRegistry(),
      /**
       * Capability report alongside the manifest, so the editor can grey out a
       * browser node with a real reason ("no browser service on this
       * deployment") instead of letting the user build a workflow that fails on
       * its first run.
       */
      capabilities: {
        browser: browser.configured,
        browserProvider: browser.provider,
        browserLiveView: browser.liveView,
        browserReplay: browser.replay,
        agentic: config.agentic.enabled,
        plan: {
          agenticWorkflows: planAllows(plan, 'agenticWorkflows'),
          browserAgents: planAllows(plan, 'browserAgents'),
          agentTriggers: planAllows(plan, 'agentTriggers'),
          maxWorkflows: planLimit(plan, 'agentWorkflows'),
        },
      },
      pricing: {
        runBase: creditCost('agent.run'),
        browserMinute: BROWSER_MINUTE_COST,
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

export const createWorkflow = asyncHandler(async (req, res) => {
  const surface = req.body.surface === 'browser' ? 'browser' : 'flow';

  // A workflow with nothing on the canvas is a dead end — the user has to
  // discover the palette before anything can happen. Seeding the trigger means
  // the first thing they see is a graph they can extend.
  const triggerType = 'trigger.manual';
  const triggerId = suggestNodeId(triggerType, []);

  const workflow = await AgentWorkflow.create({
    user: req.user._id,
    name: String(req.body.name || 'Untitled workflow').slice(0, 120),
    description: String(req.body.description || '').slice(0, 600),
    surface,
    graph: {
      nodes: [
        {
          id: triggerId,
          type: triggerType,
          position: { x: 260, y: 80 },
          data: { title: getNodeDef(triggerType).label, values: {}, note: '' },
        },
      ],
      edges: [],
    },
    composedFrom: String(req.body.prompt || '').slice(0, 2000),
  });

  log.info('Agentic workflow created', {
    user: String(req.user._id),
    workflow: String(workflow._id),
    surface,
  });

  res.status(201).json({ success: true, data: workflow.toEditorJSON() });
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

    // Browser nodes are gated on the plan at *save* time as well as run time.
    // Blocking only at run time lets someone build the whole thing and then be
    // told no, which is a worse experience than being told before they start.
    if (
      needsBrowser(nodes) &&
      !planAllows(req.user.subscription?.plan, 'browserAgents') &&
      !isUnmetered(req.user)
    ) {
      return res.status(403).json({
        success: false,
        code: 'FEATURE_NOT_IN_PLAN',
        message: 'Browser agents aren’t included in your plan.',
      });
    }

    workflow.graph = { nodes, edges };
    workflow.version += 1;

    const validation = validateGraph({ nodes, edges }, { surface: workflow.surface });
    workflow.validation = { ...validation, checkedAt: new Date() };
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
    if (req.body.schedule.every) workflow.schedule.every = String(req.body.schedule.every);
    if (req.body.schedule.atHour !== undefined) {
      workflow.schedule.atHour = Math.min(23, Math.max(0, Number(req.body.schedule.atHour) || 0));
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

// ─── Composer ───────────────────────────────────────────────

export const composeWorkflow = asyncHandler(async (req, res) => {
  const workflow = await ownedWorkflow(req, res);
  if (!workflow) return;

  const message = String(req.body.message || '').trim();
  if (!message) {
    return res.status(400).json({ success: false, message: 'Tell me what to build.' });
  }

  const result = await compose({
    graph: {
      nodes: workflow.graph.nodes.map(n => n.toObject()),
      edges: workflow.graph.edges.map(e => e.toObject()),
    },
    message,
    surface: workflow.surface,
    history: Array.isArray(req.body.history) ? req.body.history : [],
    name: workflow.name,
  });

  if (
    needsBrowser(result.graph.nodes) &&
    !planAllows(req.user.subscription?.plan, 'browserAgents') &&
    !isUnmetered(req.user)
  ) {
    return res.status(403).json({
      success: false,
      code: 'FEATURE_NOT_IN_PLAN',
      message: 'That would need browser agents, which aren’t in your plan.',
    });
  }

  // Persisted immediately rather than handed back for the client to save. The
  // canvas and the chat would otherwise disagree the moment a request fails
  // in between, and "my agent asked me to save something I can't see" is a
  // worse bug than a redundant write.
  workflow.graph = result.graph;
  workflow.version += 1;
  if (result.name) workflow.name = result.name;
  if (!workflow.composedFrom) workflow.composedFrom = message.slice(0, 2000);
  workflow.validation = { ...result.validation, checkedAt: new Date() };
  await workflow.save();

  res.json({
    success: true,
    data: {
      reply: result.reply,
      operations: result.operations,
      rejected: result.rejected,
      workflow: workflow.toEditorJSON(),
    },
  });
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

  const nodes = workflow.graph.nodes.map(n => n.toObject?.() ?? n);
  const edges = workflow.graph.edges.map(e => e.toObject?.() ?? e);

  const validation = validateGraph({ nodes, edges }, { surface: workflow.surface });
  if (validation.errors.length) {
    return {
      ok: false,
      status: 400,
      code: 'GRAPH_INVALID',
      message: validation.errors[0],
      data: { errors: validation.errors },
    };
  }

  if (needsBrowser(nodes) && !isBrowserConfigured()) {
    return {
      ok: false,
      status: 503,
      code: 'BROWSER_NOT_CONFIGURED',
      message: 'This workflow needs a browser, and no browser service is configured.',
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
    surface: workflow.surface,
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
    .select('-steps -logs -output -browser.screenshots');

  res.json({
    success: true,
    data: runs.map(r => ({
      id: String(r._id),
      status: r.status,
      trigger: r.trigger?.type,
      credits: r.credits?.total || 0,
      error: r.error,
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

/**
 * Proxy a Browserbase session replay as HLS.
 *
 * The playlist needs the secret API key, so it is fetched server-side. Returns
 * 202 while Browserbase is still processing the recording after session close.
 */
export const getSessionReplay = asyncHandler(async (req, res) => {
  const sessionId = String(req.params.sessionId || '').trim();
  if (!sessionId || sessionId.length > 120) {
    return res.status(400).json({ success: false, message: 'Invalid session id.' });
  }

  const plan = req.user?.subscription?.plan;
  if (!planAllows(plan, 'browserAgents') && !isUnmetered(req.user)) {
    return res.status(403).json({
      success: false,
      code: 'FEATURE_NOT_IN_PLAN',
      message: 'Session replay isn’t included in your plan.',
    });
  }

  const caps = browserCapabilities();
  if (!caps.replay) {
    return res.status(503).json({
      success: false,
      code: 'BROWSER_NOT_CONFIGURED',
      message: 'Session replay requires Browserbase (BROWSERBASE_API_KEY).',
    });
  }

  const playlist = await getReplayPlaylist(sessionId);
  if (!playlist) {
    return res.status(202).end();
  }

  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Cache-Control', 'no-store');
  res.send(playlist);
});

/**
 * Live run feed.
 *
 * Sends the current state first, then streams changes. A client that connects
 * three seconds late — which is every client, because the run is queued before
 * the stream opens — would otherwise miss the first steps entirely and render a
 * run that appears to begin at step four.
 */
export const streamRun = asyncHandler(async (req, res) => {
  const run = await AgentRun.findOne({ _id: req.params.runId, user: req.user._id });
  if (!run) return res.status(404).json({ success: false, message: 'Run not found.' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const send = (event, data) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send('run.snapshot', run.toJSONSafe());

  if (['succeeded', 'failed', 'canceled'].includes(run.status)) {
    send('run.finished', { status: run.status, error: run.error, credits: run.credits });
    return res.end();
  }

  const unsubscribe = subscribe(run._id, event => {
    send(event.type, event);
    if (event.type === 'run.finished') {
      unsubscribe();
      clearInterval(ping);
      res.end();
    }
  });

  // Proxies close an idle connection well before a browser run finishes.
  const ping = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, 20_000);

  req.on('close', () => {
    unsubscribe();
    clearInterval(ping);
  });
});

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
    surface: workflow.surface,
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
  res.json({ success: true, message: 'Credential deleted.' });
});

export default {
  getRegistry,
  listWorkflows,
  createWorkflow,
  getWorkflow,
  updateWorkflow,
  deleteWorkflow,
  composeWorkflow,
  runWorkflow,
  listRuns,
  getRun,
  streamRun,
  cancelRunHandler,
  getSessionReplay,
  webhookTrigger,
  listCredentials,
  createCredential,
  deleteCredential,
};
