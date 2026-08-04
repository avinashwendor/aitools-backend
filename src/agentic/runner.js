/**
 * The run loop.
 *
 * Walks a graph in dependency order, executing each node, publishing every
 * status change, and settling the bill at the end. Everything stateful about an
 * execution lives here so that executors can stay pure functions of their
 * inputs.
 *
 * Three things this does that neither reference implementation does, each for a
 * reason worth stating:
 *
 * 1. **Branches actually branch.** Both references topologically sort and then
 *    run every node. That is correct only for straight lines: the moment a
 *    graph has an If, both arms execute and the "false" arm's side effects
 *    happen anyway. Here each node carries an active/inactive state derived
 *    from its incoming edges, and a node whose every inbound path is dead is
 *    marked `skipped` rather than run. Skipped nodes cost nothing.
 *
 * 2. **The bill is assembled from what happened**, not from what was planned.
 *    Nodes are charged as they complete, browser time is charged on the
 *    session's real wall-clock, and the whole thing settles once — after the
 *    run — through the same `spend()` the chat pipeline uses. A run that fails
 *    on step two pays for step one and the base fee, and nothing else.
 *
 * 3. **Failure is a first-class outcome.** The run document is written
 *    throughout, so a process that dies mid-run leaves a readable partial
 *    record instead of nothing at all.
 */

import { AgentRun, AgentWorkflow } from '../models/index.js';
import { topoSort } from './graph.js';
import { getNodeDef, nodeCredits } from './registry.js';
import { getExecutor } from './executors.js';
import { resolveValues } from './interpolate.js';
import { capOutput, safeMessage } from './safety.js';
import { openSession, isBrowserConfigured } from './browser/session.js';
import { publish } from './events.js';
import { withMetering, summarize, recordBrowserUsage } from '../billing/meterContext.js';
import { spend, recordFailure } from '../billing/credits.js';
import { BROWSER_MINUTE_COST, creditCost } from '../billing/plans.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('agentic:runner');

const MAX_BROWSER_SCREENSHOTS = 5;

/** Runs currently executing in this process, so a cancel can reach them. */
const inFlight = new Map();

export function activeRunCount(userId) {
  let count = 0;
  for (const entry of inFlight.values()) {
    if (String(entry.userId) === String(userId)) count += 1;
  }
  return count;
}

export function cancelRun(runId) {
  const entry = inFlight.get(String(runId));
  if (!entry) return false;
  entry.controller.abort();
  return true;
}

/**
 * Execute a run that has already been created in `queued` state.
 *
 * Creating the document first, elsewhere, is what lets the API respond with a
 * run id immediately: the client can open its SSE stream and see step one start
 * rather than waiting for the whole run to answer the HTTP request.
 *
 * @param {object} opts
 * @param {string} opts.runId
 * @param {object} opts.user   the owning user document, needed to charge
 */
export async function executeRun({ runId, user }) {
  const run = await AgentRun.findById(runId);
  if (!run) throw new Error(`Run ${runId} not found`);
  if (run.status !== 'queued') {
    log.warn('Refusing to execute a run that is not queued', { runId, status: run.status });
    return run;
  }

  const workflow = await AgentWorkflow.findById(run.workflow);
  if (!workflow) {
    run.status = 'failed';
    run.error = 'The workflow was deleted before this run started.';
    run.finishedAt = new Date();
    await run.save();
    return run;
  }

  const controller = new AbortController();
  inFlight.set(String(run._id), { userId: user._id, controller });

  // The whole run is wrapped in one metering scope, so every LLM call any node
  // makes — including the ones inside browser primitives — is attributed to
  // this run without a single executor knowing billing exists.
  try {
    return await withMetering(usage => runInner({ run, workflow, user, controller, usage }));
  } finally {
    inFlight.delete(String(run._id));
  }
}

async function runInner({ run, workflow, user, controller, usage }) {
  const startedAt = Date.now();
  const { signal } = controller;

  run.status = 'running';
  run.startedAt = new Date();

  const nodes = workflow.graph.nodes.map(n => n.toObject?.() ?? n);
  const edges = workflow.graph.edges.map(e => e.toObject?.() ?? e);

  let ordered;
  try {
    ordered = topoSort(nodes, edges);
  } catch (err) {
    return finish({ run, user, usage, startedAt, error: err.message, session: null });
  }

  // Seed every step as pending and publish before anything executes, so the
  // console renders the whole run as a list of spinners rather than growing a
  // row at a time — the difference between "this is running" and "this is
  // stuck".
  run.steps = ordered.map(node => ({
    nodeId: node.id,
    type: node.type,
    title: node.data?.title || getNodeDef(node.type)?.label || node.type,
    status: 'pending',
  }));
  await run.save();

  emit(run, 'run.started', { steps: run.steps, status: 'running' });

  /** Node outputs so far, plus the trigger payload, addressable as `{{ id.path }}`. */
  const scope = { trigger: run.trigger?.payload || {} };

  /**
   * Which nodes are still live.
   *
   * A node is live if it has no inbound edges (a trigger), or if at least one
   * inbound edge comes from a live node through a handle that node kept open.
   * Computed as the walk proceeds rather than up front, because an If's choice
   * isn't known until it runs.
   */
  const live = new Set();
  /** `nodeId → handle the node left open`, for branching nodes. */
  const openHandle = new Map();

  const isLive = node => {
    const inbound = edges.filter(e => e.target === node.id);
    if (!inbound.length) return true;
    return inbound.some(e => {
      if (!live.has(e.source)) return false;
      const chosen = openHandle.get(e.source);
      // A node that didn't branch keeps every handle open.
      return chosen === undefined || chosen === (e.sourceHandle || 'main');
    });
  };

  // ─── Browser session, opened lazily ──────────────────────
  let session = null;
  const getBrowser = async () => {
    if (session) return session;
    if (!isBrowserConfigured()) {
      throw new Error(
        'This step needs a browser, but no browser service is configured. Set BROWSERBASE_API_KEY (hosted) or AGENT_BROWSER_WS (self-hosted).'
      );
    }
    addLog(run, { level: 'info', message: 'Opening browser session…' });
    session = await openSession({ onLog: entry => addLog(run, entry) });
    run.browser.used = true;
    run.browser.provider = session.provider;
    run.browser.sessionId = session.sessionId;
    run.browser.liveViewUrl = session.liveViewUrl;
    // Published the moment it exists rather than at the end: the live view is
    // only useful *during* the run, and a URL that arrives with the final
    // result is a URL nobody can act on.
    emit(run, 'run.browser', {
      provider: session.provider,
      sessionId: session.sessionId,
      liveViewUrl: session.liveViewUrl,
    });
    return session;
  };

  let creditsForNodes = 0;
  let failure = null;

  const deadline = startedAt + config.agentic.maxRunMs;

  for (let i = 0; i < ordered.length; i++) {
    const node = ordered[i];
    const step = run.steps[i];

    if (signal.aborted) {
      failure = { message: 'Run canceled.', nodeId: node.id, canceled: true };
      break;
    }
    if (Date.now() > deadline) {
      failure = {
        message: `Run exceeded its ${Math.round(config.agentic.maxRunMs / 1000)}s ceiling.`,
        nodeId: node.id,
      };
      break;
    }

    if (!isLive(node)) {
      step.status = 'skipped';
      await persistStep(run, i);
      emit(run, 'step.update', { index: i, step: plainStep(step) });
      continue;
    }
    live.add(node.id);

    const def = getNodeDef(node.type);
    if (!def) {
      failure = { message: `Unknown node type "${node.type}".`, nodeId: node.id };
      break;
    }

    step.status = 'running';
    step.startedAt = new Date();
    await persistStep(run, i);
    emit(run, 'step.update', { index: i, step: plainStep(step) });

    const stepStartedAt = Date.now();
    const costBefore = usage.llmPaise + usage.searchPaise;

    try {
      const values = resolveValues(node.data?.values || {}, def.fields, scope);
      const executor = getExecutor(node.type);

      const output = await executor({
        values,
        nodeId: node.id,
        userId: user._id,
        user,
        trigger: run.trigger,
        scope,
        signal,
        getBrowser,
        onLog: entry => {
          addLog(run, { ...entry, nodeId: node.id });
          emit(run, 'run.log', { nodeId: node.id, ...entry });
        },
        onScreenshot: dataUrl => {
          run.browser.screenshots.push(dataUrl);
          if (run.browser.screenshots.length > MAX_BROWSER_SCREENSHOTS) {
            run.browser.screenshots = run.browser.screenshots.slice(-MAX_BROWSER_SCREENSHOTS);
          }
          emit(run, 'run.screenshot', { nodeId: node.id, dataUrl });
        },
      });

      // A branching node tells the runner which arm survives by returning
      // `branch`. Nodes that don't branch simply don't set it.
      if (output && typeof output === 'object' && output.branch) {
        openHandle.set(node.id, output.branch);
      }

      scope[node.id] = output;

      step.status = 'done';
      step.durationMs = Date.now() - stepStartedAt;
      step.output = capOutput(output);
      step.credits = nodeCredits(node.type, output);
      step.costPaise = usage.llmPaise + usage.searchPaise - costBefore;
      creditsForNodes += step.credits;
    } catch (err) {
      step.status = 'failed';
      step.durationMs = Date.now() - stepStartedAt;
      step.error = safeMessage(err.message, 400);
      step.costPaise = usage.llmPaise + usage.searchPaise - costBefore;

      failure = {
        message: step.error,
        nodeId: node.id,
        canceled: err.message === 'Run canceled',
      };

      await persistStep(run, i);
      emit(run, 'step.update', { index: i, step: plainStep(step) });
      break;
    }

    await persistStep(run, i);
    emit(run, 'step.update', { index: i, step: plainStep(step) });
  }

  return finish({
    run,
    user,
    usage,
    startedAt,
    session,
    creditsForNodes,
    error: failure?.message || null,
    failedNodeId: failure?.nodeId || null,
    canceled: Boolean(failure?.canceled),
    // The last live node's output is the natural "result" of a run, and it is
    // what a webhook caller gets back. The whole scope is too much to hand out
    // — it includes every intermediate an author never meant to publish.
    output: lastOutput(run, scope),
  });
}

/** Close the session, settle the bill, write the terminal state, publish it. */
async function finish({
  run,
  user,
  usage,
  startedAt,
  session,
  creditsForNodes = 0,
  error = null,
  failedNodeId = null,
  canceled = false,
  output = null,
}) {
  let browserSeconds = 0;
  if (session) {
    browserSeconds = session.elapsedSeconds();
    await session.close();
    // Recorded after close so the number covers the full held duration, and
    // recorded even on failure — a run that died with a browser open still cost
    // us the browser.
    recordBrowserUsage({ seconds: browserSeconds });
  }

  const browserMinutes = Math.ceil(browserSeconds / 60);
  const base = creditCost('agent.run');
  const browserCredits = browserMinutes * BROWSER_MINUTE_COST;

  run.credits = {
    base,
    nodes: creditsForNodes,
    browser: browserCredits,
    total: base + creditsForNodes + browserCredits,
  };

  const summary = summarize(usage);
  run.cost = {
    llmPaise: summary.cost.llmPaise,
    searchPaise: summary.cost.searchPaise,
    browserPaise: summary.cost.browserPaise,
    totalPaise: summary.cost.totalPaise,
  };
  run.tokens = summary.tokens;
  run.browser.seconds = browserSeconds;

  run.status = canceled ? 'canceled' : error ? 'failed' : 'succeeded';
  run.error = error;
  run.failedNodeId = failedNodeId;
  run.output = capOutput(output);
  run.finishedAt = new Date();

  // Settle once, after the work, exactly like the chat pipeline: the price of a
  // run genuinely isn't knowable until it has run. Overdraft is allowed because
  // refusing to bill for work already done (in tokens we already paid for)
  // loses us the money either way — better to let the balance dip by one run
  // and refuse the next.
  try {
    const charge = await spend({
      user,
      action: 'agent.run',
      cost: run.credits.total,
      usage,
      allowOverdraft: true,
      meta: {
        runId: String(run._id),
        workflowId: String(run.workflow),
        workflowName: run.workflowName,
        surface: run.surface,
        nodes: run.steps.filter(s => s.status === 'done').length,
        browserMinutes,
        outcome: run.status,
      },
    });
    run.ledgerId = charge.ledgerId || null;
  } catch (err) {
    log.error('Failed to charge an agentic run', { runId: String(run._id), error: err.message });
  }

  if (error) {
    // A zero-credit row alongside the charge above, so a failing workflow's
    // real provider cost stays visible in the admin spend view even though the
    // user was only charged the base fee's worth of value.
    await recordFailure({
      user,
      action: 'agent.run',
      usage,
      reason: safeMessage(error, 200),
      meta: { runId: String(run._id), failedNodeId },
    }).catch(() => {});
  }

  /*
   * Written with `updateOne`, not `run.save()`, and that is not a style choice.
   *
   * Mongoose tracks *operations* on document arrays, so `logs.push(entry)`
   * becomes an atomic `$push` at save time. But `persistStep` has already
   * written those same arrays wholesale with `$set` on every status change. Use
   * both and the final save re-pushes everything added since the last save on
   * top of what `$set` already stored — every screenshot lands twice, and a
   * chatty agent's log doubles. `$set`-ing the terminal state sidesteps the
   * change tracking entirely, so the document ends up as exactly what is in
   * memory.
   */
  await AgentRun.updateOne(
    { _id: run._id },
    {
      $set: {
        status: run.status,
        error: run.error,
        failedNodeId: run.failedNodeId,
        output: run.output,
        credits: run.credits,
        cost: run.cost,
        tokens: run.tokens,
        steps: run.steps,
        logs: run.logs,
        browser: {
          used: run.browser.used,
          provider: run.browser.provider,
          sessionId: run.browser.sessionId,
          liveViewUrl: run.browser.liveViewUrl,
          seconds: run.browser.seconds,
          screenshots: run.browser.screenshots,
        },
        ledgerId: run.ledgerId,
        finishedAt: run.finishedAt,
      },
    }
  );

  await AgentWorkflow.updateOne(
    { _id: run.workflow },
    {
      $inc: {
        'stats.runs': 1,
        'stats.failures': run.status === 'failed' ? 1 : 0,
        'stats.creditsSpent': run.credits.total,
      },
      $set: { 'stats.lastRunAt': new Date(), 'stats.lastStatus': run.status },
    }
  ).catch(err => log.warn('Workflow stat update failed', { error: err.message }));

  emit(run, 'run.finished', {
    status: run.status,
    error: run.error,
    failedNodeId: run.failedNodeId,
    credits: run.credits,
    output: run.output,
    durationMs: Date.now() - startedAt,
    browser: {
      used: run.browser.used,
      provider: run.browser.provider,
      sessionId: run.browser.sessionId,
      liveViewUrl: run.browser.liveViewUrl,
      seconds: run.browser.seconds,
    },
  });

  log.info('Agentic run finished', {
    runId: String(run._id),
    status: run.status,
    steps: run.steps.length,
    credits: run.credits.total,
    costPaise: run.cost.totalPaise,
    browserSeconds,
  });

  return run;
}

// ─── small helpers ──────────────────────────────────────────

function plainStep(step) {
  return {
    nodeId: step.nodeId,
    type: step.type,
    title: step.title,
    status: step.status,
    durationMs: step.durationMs,
    output: step.output,
    error: step.error,
    credits: step.credits,
  };
}

function emit(run, type, payload) {
  publish(run._id, { type, ...payload });
}

function addLog(run, { level = 'info', message, nodeId = null }) {
  run.logs.push({ level, message: safeMessage(message, 2000), nodeId, at: new Date() });
  // Logs are a ring buffer. An agent node in a loop can emit hundreds of lines,
  // and the run document has a hard size limit that a failure needs room in.
  if (run.logs.length > 400) run.logs.splice(0, run.logs.length - 400);
}

/**
 * Persist one step's state.
 *
 * A targeted `$set` on the single changed step rather than `run.save()`: the
 * run document carries every step's output, and re-sending all of it on each of
 * forty status changes is forty full-document writes of data that hasn't
 * changed. Logs and screenshots go along for the ride because they're the other
 * things that grow mid-run.
 */
async function persistStep(run, index) {
  try {
    await AgentRun.updateOne(
      { _id: run._id },
      {
        $set: {
          [`steps.${index}`]: run.steps[index],
          logs: run.logs,
          'browser.screenshots': run.browser.screenshots,
          'browser.used': run.browser.used,
          'browser.sessionId': run.browser.sessionId,
          status: run.status,
          startedAt: run.startedAt,
        },
      }
    );
  } catch (err) {
    log.warn('Step persist failed — run continues', { error: err.message });
  }
}

/** The output of the last node that actually did work. */
function lastOutput(run, scope) {
  for (let i = run.steps.length - 1; i >= 0; i--) {
    const step = run.steps[i];
    if (step.status === 'done' && scope[step.nodeId] !== undefined) {
      return scope[step.nodeId];
    }
  }
  return null;
}

export default { executeRun, cancelRun, activeRunCount };
