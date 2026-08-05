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
 *    Nodes are charged as they complete — an AI Agent node by the number of
 *    steps it actually took — and the whole thing settles once, after the run,
 *    through the same `spend()` the chat pipeline uses. A run that fails on
 *    step two pays for step one and the base fee, and nothing else.
 *
 * 3. **Failure is a first-class outcome.** The run document is written
 *    throughout, so a process that dies mid-run leaves a readable partial
 *    record instead of nothing at all.
 *
 * 4. **A transient failure is not a failed run.** A workflow is a program made
 *    of calls to other people's servers, and those rate-limit and restart. A
 *    step that fails in a way that left the far end unchanged is retried with
 *    backoff, and only nodes the registry says have no side effects are retried
 *    once the request may have landed — a retried email is a second email.
 *
 * 5. **A step can succeed and still be wrong.** A `{{ }}` reference that
 *    resolves to nothing renders as an empty string, so a workflow whose
 *    references are stale runs green and delivers blanks. Misses are recorded
 *    on the step, which is the only signal anyone gets that a clean run did
 *    nothing.
 */

import { AgentRun, AgentWorkflow } from '../models/index.js';
import config from '../config/index.js';
import { topoSort } from './graph.js';
import { findRegions } from './regions.js';
import { getNodeDef, nodeCredits, hasSideEffects, nodeTimeoutMs } from './registry.js';
import { getExecutor } from './executors.js';
import { resolveValues } from './interpolate.js';
import { withRetry, withTimeout } from './retry.js';
import { capOutput, safeMessage } from './safety.js';
import { publish } from './events.js';
import { withMetering, summarize } from '../billing/meterContext.js';
import { spend, recordFailure } from '../billing/credits.js';
import { creditCost, creditsForCost } from '../billing/plans.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('agentic:runner');

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
  // makes — including the ones inside an AI Agent's own loop — is attributed
  // to this run without a single executor knowing billing exists.
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
    return finish({ run, user, usage, startedAt, error: err.message });
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

  let creditsForNodes = 0;
  let failure = null;

  const deadline = startedAt + config.agentic.maxRunMs;
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  const stepIndexById = new Map(ordered.map((node, index) => [node.id, index]));

  /*
   * Loop regions, worked out before anything runs.
   *
   * A region's body is executed by the `core.forEach` that opens it rather than
   * by this walk, so those nodes are claimed up front and skipped when the walk
   * reaches them. Structural problems are fatal here rather than reported per
   * node: a loop with no end is not a graph we can partially run, and finding
   * that out at step nine — after nine steps' worth of credits — is exactly the
   * failure the validator exists to prevent.
   */
  const { regions, errors: regionErrors } = findRegions({ nodes, edges });
  if (regionErrors.length) {
    return finish({ run, user, usage, startedAt, error: regionErrors[0] });
  }
  const regionByForEach = new Map(regions.map(region => [region.forEachId, region]));
  /** `nodeId → the region that drives it`, for every body node and its collect. */
  const claimedByRegion = new Map(
    regions.flatMap(region => [...region.body, region.collectId].map(id => [id, region]))
  );

  /** Everything a node needs to execute, independent of which walk is driving it. */
  const context = { run, user, usage, edges, signal, workflowId: run.workflow };

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

    /*
     * Driven by its region's opener, which has already run by the time the walk
     * reaches here — so there is nothing to do but move on.
     *
     * Unless the opener never became live, because the loop sits on a branch
     * that wasn't taken. Nothing else would ever touch these rows in that case,
     * and a finished run showing three steps still spinning reads as a run that
     * hung. The walk marks them the same way it marks any other dead branch.
     */
    const claimed = claimedByRegion.get(node.id);
    if (claimed) {
      if (!live.has(claimed.forEachId) && step.status === 'pending') {
        step.status = 'skipped';
        await persistStep(run, i);
        emit(run, 'step.update', { index: i, step: plainStep(step) });
      }
      continue;
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

    const outcome = await executeStep({ node, step, index: i, scope, context });
    creditsForNodes += outcome.credits;

    if (!outcome.ok) {
      failure = { message: step.error, nodeId: node.id, canceled: outcome.canceled };
      break;
    }

    // A branching node tells the runner which arm survives by returning
    // `branch`. Nodes that don't branch simply don't set it.
    if (outcome.output?.branch) openHandle.set(node.id, outcome.output.branch);
    scope[node.id] = outcome.output;

    /*
     * Early exit. A Code step that returns `{ skip: true }` (weekend gate,
     * empty feed, etc.) must stop the rest of the chain — otherwise a
     * "weekdays only" schedule still emails on Saturday.
     */
    if (outcome.output?.skip === true) {
      for (let j = i + 1; j < ordered.length; j++) {
        if (run.steps[j].status === 'pending') {
          run.steps[j].status = 'skipped';
          await persistStep(run, j);
          emit(run, 'step.update', { index: j, step: plainStep(run.steps[j]) });
        }
      }
      break;
    }

    const region = regionByForEach.get(node.id);
    if (region) {
      const looped = await runRegion({
        region,
        items: outcome.output?.items || [],
        node,
        nodeById,
        stepIndexById,
        scope,
        context,
        deadline,
      });

      creditsForNodes += looped.credits;
      live.add(region.collectId);
      region.body.forEach(id => live.add(id));

      if (looped.error) {
        failure = { message: looped.error, nodeId: looped.failedNodeId || region.forEachId };
        break;
      }
    }
  }

  return finish({
    run,
    user,
    usage,
    startedAt,
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

/**
 * Execute one node against one scope.
 *
 * Pulled out of the walk because a node in a loop body runs against a different
 * scope on every pass and needs all of the same machinery — substitution, miss
 * reporting, retry, deadline, cost attribution. Left inline, the region driver
 * would have been a second, quietly divergent copy of the most important
 * fifty lines in the file.
 *
 * `accumulate` is what makes a body node's step readable: it is one row in the
 * console standing for twenty executions, so counts and credits add up across
 * passes instead of the last one overwriting the rest.
 *
 * @returns {{ok, output, credits, canceled}}
 */
async function executeStep({ node, step, index, scope, context, accumulate = false, persist = true }) {
  const { run, user, usage, edges, signal, workflowId } = context;
  const def = getNodeDef(node.type);

  if (!accumulate) {
    step.status = 'running';
    step.startedAt = new Date();
    if (persist) {
      await persistStep(run, index);
      emit(run, 'step.update', { index, step: plainStep(step) });
    }
  }

  const stepStartedAt = Date.now();
  const costBefore = usage.llmPaise + usage.searchPaise;

  try {
    /*
     * A reference that resolves to nothing is not an error — killing a run nine
     * steps in over one blank field would be worse than continuing — but it is
     * very often *the* reason a run that reports success delivered an empty
     * email. Recording it is what turns "it ran but nothing happened" into a
     * line naming the field and the path that came back empty.
     *
     * De-duplicated per step: one bad reference used four times in a body is
     * one mistake, and four identical warnings bury the second one. In a loop
     * the same de-duplication spans every pass, so a broken reference is one
     * warning rather than twenty-five.
     */
    const misses = new Map();
    const values = resolveValues(node.data?.values || {}, def.fields, scope, {
      onMiss: ({ path, field }) => misses.set(`${field}:${path}`, { path, field }),
    });

    if (misses.size) {
      const existing = new Set(step.warnings || []);
      for (const miss of misses.values()) {
        const warning = `${miss.field} references {{ ${miss.path} }}, which was empty at run time.`;
        if (existing.has(warning)) continue;
        existing.add(warning);
        addLog(run, { level: 'warn', message: warning, nodeId: node.id });
        emit(run, 'run.log', { nodeId: node.id, level: 'warn', message: warning });
      }
      step.warnings = [...existing];
    }

    const executor = getExecutor(node.type);
    // Retryable only where repeating the work cannot repeat a side effect.
    // `retry.js` additionally allows a repeat of a side-effecting node when the
    // failure proves the request never reached the far end.
    const idempotent = !hasSideEffects(node.type);

    const output = await withRetry(
      attempt => {
        step.attempts = Math.max(step.attempts || 1, attempt);
        return withTimeout(
          nodeSignal =>
            executor({
              values,
              nodeId: node.id,
              userId: user._id,
              user,
              workflowId,
              trigger: run.trigger,
              scope,
              // The Code node needs to know which node fed it, and it is the
              // only one that reads the topology from inside an executor.
              edges,
              signal: nodeSignal,
              onLog: entry => {
                addLog(run, { ...entry, nodeId: node.id });
                emit(run, 'run.log', { nodeId: node.id, ...entry });
              },
            }),
          // Per node type: the default is patient for an HTTP call and would
          // strangle a five-minute Wait or a forty-step agent.
          { ms: nodeTimeoutMs(node.type, config.agentic.nodeTimeoutMs), signal, what: def.label }
        );
      },
      {
        attempts: config.agentic.nodeAttempts,
        idempotent,
        signal,
        onRetry: ({ attempt, delayMs, reason, error }) => {
          const message =
            `${def.label} failed (${reason}: ${error.message}) — ` +
            `retrying in ${Math.round(delayMs / 1000) || 1}s, attempt ${attempt + 1} of ${config.agentic.nodeAttempts}.`;
          addLog(run, { level: 'warn', message, nodeId: node.id });
          emit(run, 'run.log', { nodeId: node.id, level: 'warn', message });
        },
      }
    );

    const credits = nodeCredits(node.type, output);

    step.status = 'done';
    step.durationMs = (accumulate ? step.durationMs || 0 : 0) + (Date.now() - stepStartedAt);
    step.output = capOutput(output);
    step.credits = (accumulate ? step.credits || 0 : 0) + credits;
    step.costPaise =
      (accumulate ? step.costPaise || 0 : 0) + (usage.llmPaise + usage.searchPaise - costBefore);
    if (accumulate) step.iterations = (step.iterations || 0) + 1;

    if (persist) {
      await persistStep(run, index);
      emit(run, 'step.update', { index, step: plainStep(step) });
    }

    return { ok: true, output, credits, canceled: false };
  } catch (err) {
    step.status = 'failed';
    step.durationMs = (accumulate ? step.durationMs || 0 : 0) + (Date.now() - stepStartedAt);
    // The first error, not the last: in a loop the first failure is the one
    // that explains the rest, and the twenty-fifth is usually a consequence.
    step.error = step.error || safeMessage(err.message, 400);
    step.costPaise =
      (accumulate ? step.costPaise || 0 : 0) + (usage.llmPaise + usage.searchPaise - costBefore);

    if (persist) {
      await persistStep(run, index);
      emit(run, 'step.update', { index, step: plainStep(step) });
    }

    return { ok: false, output: null, credits: 0, canceled: err.message === 'Run canceled', error: err };
  }
}

/**
 * Run a loop body once per item.
 *
 * Three decisions here decide whether this is usable on real data.
 *
 * **A failed iteration does not fail the run.** Real lists have a seventh item
 * with a null field, and a loop that abandons twenty-four successful passes
 * because of it is a loop nobody can use. Failures are counted, reported on
 * `collect.failed`, and the run continues.
 *
 * **Unless they all fail.** Tolerating partial failure quietly turns a
 * systematically broken body — wrong endpoint, bad credential — into an empty
 * list and a green run, which is the silent-success failure this whole pass
 * exists to remove. Every iteration failing is a broken workflow, not bad data,
 * and it is reported as one.
 *
 * **Iterations are sequential by default.** A loop is precisely where a rate
 * limit gets hit, and twenty-five parallel requests to an API that allows five
 * a second turns a working workflow into a 429 storm. The author can raise it
 * for endpoints they know tolerate it.
 */
async function runRegion({ region, items, node, nodeById, stepIndexById, scope, context, deadline }) {
  const { run, signal } = context;
  const values = node.data?.values || {};
  const concurrency = Math.min(Math.max(Number(values.concurrency) || 1, 1), 5);

  const collectNode = nodeById.get(region.collectId);
  const collectStep = run.steps[stepIndexById.get(region.collectId)];
  const collectValues = collectNode?.data?.values || {};
  const skipEmpty = collectValues.skipEmpty !== false;

  // What one pass contributes, when the author didn't say. The step feeding
  // Collect is the natural answer and the one they almost always mean.
  const feeders = context.edges.filter(e => e.target === region.collectId).map(e => e.source);

  const bodySteps = region.order.map(id => ({
    node: nodeById.get(id),
    step: run.steps[stepIndexById.get(id)],
    index: stepIndexById.get(id),
  }));

  // A body node starts as skipped and becomes done the first time any iteration
  // runs it — a node behind an If that never matched genuinely never ran.
  for (const entry of bodySteps) {
    entry.step.status = 'skipped';
    entry.step.iterations = 0;
  }

  const gathered = [];
  let failed = 0;
  let credits = 0;
  let firstError = null;
  let failedNodeId = null;
  let stopped = null;

  const runOne = async (item, index) => {
    /*
     * A fresh scope per pass, layered over the run's.
     *
     * Copied rather than shared: two iterations running concurrently would
     * otherwise overwrite each other's node outputs under the same keys, and
     * the bug that produces — iteration 3 emailing iteration 5's summary — is
     * both intermittent and invisible in the run log.
     */
    const iterScope = { ...scope, each: { item, index, total: items.length, number: index + 1 } };
    const live = new Set([region.forEachId]);
    const openHandle = new Map();

    for (const entry of bodySteps) {
      if (signal.aborted || stopped) return;

      const inbound = context.edges.filter(e => e.target === entry.node.id);
      const isLive = inbound.some(e => {
        if (!live.has(e.source)) return false;
        const chosen = openHandle.get(e.source);
        return chosen === undefined || chosen === (e.sourceHandle || 'main');
      });
      if (!isLive) continue;
      live.add(entry.node.id);

      const outcome = await executeStep({
        node: entry.node,
        step: entry.step,
        index: entry.index,
        scope: iterScope,
        context,
        accumulate: true,
        // Persisting on every node of every pass is 25 × body writes to Mongo
        // for a run whose console only shows one row per node anyway. The
        // region publishes progress once per iteration instead.
        persist: false,
      });

      credits += outcome.credits;

      if (!outcome.ok) {
        failed += 1;
        if (!firstError) {
          firstError = outcome.error?.message || 'Iteration failed.';
          failedNodeId = entry.node.id;
        }
        if (outcome.canceled) stopped = 'Run canceled.';
        return;
      }

      if (outcome.output?.branch) openHandle.set(entry.node.id, outcome.output.branch);
      iterScope[entry.node.id] = outcome.output;
    }

    const value = collectValues.value
      ? resolveValues({ value: collectValues.value }, [{ key: 'value', label: 'Keep', type: 'text' }], iterScope).value
      : iterScope[feeders[feeders.length - 1]] ?? null;

    if (skipEmpty && (value === null || value === undefined || value === '')) return;
    gathered.push(value);
  };

  for (let start = 0; start < items.length; start += concurrency) {
    if (signal.aborted) { stopped = 'Run canceled.'; break; }
    if (Date.now() > deadline) {
      stopped = `Run exceeded its ${Math.round(config.agentic.maxRunMs / 1000)}s ceiling inside the loop.`;
      break;
    }

    const batch = items.slice(start, start + concurrency);
    await Promise.all(batch.map((item, offset) => runOne(item, start + offset)));

    for (const entry of bodySteps) {
      await persistStep(run, entry.index);
      emit(run, 'step.update', { index: entry.index, step: plainStep(entry.step) });
    }
    emit(run, 'run.log', {
      nodeId: region.forEachId,
      level: 'info',
      message: `Processed ${Math.min(start + concurrency, items.length)} of ${items.length}.`,
    });
    if (stopped) break;
  }

  const output = { items: gathered, count: gathered.length, failed };
  scope[region.collectId] = output;

  collectStep.status = 'done';
  collectStep.output = capOutput(output);
  collectStep.iterations = items.length;
  if (failed) {
    collectStep.warnings = [
      `${failed} of ${items.length} item${items.length === 1 ? '' : 's'} failed and ${
        failed === 1 ? 'was' : 'were'
      } left out. First failure: ${safeMessage(firstError, 200)}`,
    ];
  }
  await persistStep(run, stepIndexById.get(region.collectId));
  emit(run, 'step.update', { index: stepIndexById.get(region.collectId), step: plainStep(collectStep) });

  // Every item failing is a broken workflow rather than awkward data, and
  // reporting it as a successful run that gathered nothing is the exact silent
  // success this pass exists to remove.
  const allFailed = items.length > 0 && failed === items.length;

  return {
    credits,
    error: stopped || (allFailed ? `Every item failed. First failure: ${firstError}` : null),
    failedNodeId,
  };
}

/** Settle the bill, write the terminal state, publish it. */
async function finish({
  run,
  user,
  usage,
  startedAt,
  creditsForNodes = 0,
  error = null,
  failedNodeId = null,
  canceled = false,
  output = null,
}) {
  const summary = summarize(usage);
  run.cost = {
    llmPaise: summary.cost.llmPaise,
    searchPaise: summary.cost.searchPaise,
    totalPaise: summary.cost.totalPaise,
  };
  run.tokens = summary.tokens;

  /*
   * Three parts, and each one prices something the others can't see.
   *
   *   base     the queue slot and the orchestration, paid by every run
   *            including one that fails before its first node.
   *   nodes    the registry's own price per node — what it costs us to *have*
   *            an integration, independent of how much text moved through it.
   *   tokens   the model calls the run actually made. This is the term that
   *            distinguishes an agent node that answered in one turn from one
   *            that spent twelve turns reading a page, which no per-node price
   *            can, because the node is the same node.
   */
  const base = creditCost('agent.run');
  const tokens = creditsForCost(summary.cost.totalPaise);

  run.credits = {
    base,
    nodes: creditsForNodes,
    tokens,
    total: base + creditsForNodes + tokens,
  };

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
        nodes: run.steps.filter(s => s.status === 'done').length,
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
  });

  log.info('Agentic run finished', {
    runId: String(run._id),
    status: run.status,
    steps: run.steps.length,
    credits: run.credits.total,
    costPaise: run.cost.totalPaise,
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
    warnings: step.warnings || [],
    attempts: step.attempts || 1,
    // Absent for a normal step, a count for one inside a loop — the console
    // shows one row per node whether it ran once or twenty-five times.
    iterations: step.iterations || 0,
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
