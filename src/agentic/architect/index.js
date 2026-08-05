/**
 * The workflow architect.
 *
 * A tool-calling agent whose job is to produce a workflow that runs. It plans,
 * reads the actual API documentation, declares the credentials it will need,
 * writes the graph as operations, and — the part that matters — executes
 * individual steps to check they work before it says it is finished.
 *
 * This replaces a single-shot composer that emitted a graph from memory in one
 * model call. That design has one failure mode and it happens constantly: asked
 * for "upload my video to YouTube every Friday", a model will happily produce a
 * beautifully laid-out graph pointing at `https://api.youtube.com/v3/upload`,
 * an endpoint that does not exist. Nothing in a one-shot design can catch that,
 * because nothing in it ever touches the network. The user gets a picture of a
 * workflow, presses Run, and watches it fail.
 *
 * Three things here are what turn that around:
 *
 * • **Research is a step, not a suggestion.** `read_url` fetches the real docs
 *   page. The endpoint, the auth header and the parameter names come from that
 *   page rather than from the model's recollection of it.
 *
 * • **Edits are validated synchronously.** `edit_graph` returns the validator's
 *   errors in the same tool result, so a missing required field is something
 *   the model fixes on its next turn rather than something the user discovers.
 *
 * • **Steps are actually executed.** `test_step` runs one node for real and
 *   hands back the response. That is how a `{{ }}` reference gets written
 *   against the field names the API really returns instead of the ones the
 *   model assumed.
 *
 * Everything the architect does is streamed as it happens, and persisted to the
 * build document as it streams — a user watching a ninety-second build needs to
 * see it thinking, and a user who reconnects needs to see what they missed.
 */

import config from '../../config/index.js';
import { AgentBuild, AgentWorkflow } from '../../models/index.js';
import { runAgentLoop, defineTool } from '../../ai/agentLoop.js';
import { webSearch, searchDocs, isWebSearchConfigured } from '../../ai/tools/webSearch.js';
import { fetchPage } from '../../ai/tools/fetchPage.js';
import { search as searchCatalog } from '../../ai/retriever.js';
import { getNodeDef, isTestable, NODE_LIST } from '../registry.js';
import { validateGraph, findOrphans } from '../graph.js';
import { applyOperations, describeGraph } from '../operations.js';
import { getExecutor } from '../executors.js';
import { resolveValues } from '../interpolate.js';
import { capOutput, safeMessage } from '../safety.js';
import { publish } from '../events.js';
import { syncWorkflowSchedule } from '../scheduleSync.js';
import { withMetering, summarize } from '../../billing/meterContext.js';
import { spend, recordFailure } from '../../billing/credits.js';
import { meteredCost } from '../../billing/plans.js';
import { architectSystemPrompt } from './prompt.js';
import { reviewBuild } from './review.js';
import { goalNeedsClarification, normalizeClarifyingQuestions } from './clarify.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('agentic:architect');

/**
 * Which steps `test_step` will execute is not decided here.
 *
 * It used to be, as a list in this file, which meant the answer to "does
 * running this change the world?" lived in two places — here and in whoever
 * remembered when adding an integration. The registry owns it now
 * (`sideEffects` / `testable`), so a new delivering node is excluded from
 * test-running the moment it is declared, rather than the first time a build
 * posts to a live channel while checking its work.
 */

/** Builds currently running in this process, so a cancel can reach them. */
const inFlight = new Map();

export function cancelBuild(buildId) {
  const entry = inFlight.get(String(buildId));
  if (!entry) return false;
  entry.controller.abort();
  return true;
}

export function activeBuildCount(userId) {
  let count = 0;
  for (const entry of inFlight.values()) {
    if (String(entry.userId) === String(userId)) count += 1;
  }
  return count;
}

/**
 * When a build is resumed, the in-memory session flags must match what already
 * happened on the timeline — otherwise a continued session replans from scratch
 * or hits the research cap again despite having already read the docs.
 */
function restoreSessionState(state, timeline) {
  if (!timeline?.length) return;

  for (const event of timeline) {
    if (event.type === 'plan') {
      state.planRecorded = true;
      if (event.meta?.plan?.length) state.plan = event.meta.plan;
    }
    if (event.type === 'graph') state.graphEdited = true;
    if (event.type === 'test' && event.ok !== false && event.meta?.nodeId) {
      if (!state.tested.includes(event.meta.nodeId)) state.tested.push(event.meta.nodeId);
    }
  }

  if (!state.graphEdited) {
    let research = 0;
    for (const event of timeline) {
      if (['search', 'read', 'catalog'].includes(event.type)) research += 1;
      if (event.type === 'graph') break;
    }
    state.researchBeforeBuild = research;
  }
}

/**
 * Run one architect session against a workflow.
 *
 * The build document is created by the caller in `queued` state, exactly like a
 * run, so the API can hand back an id immediately and the client can open its
 * stream before the first model call returns.
 *
 * @param {object} opts
 * @param {string} opts.buildId
 * @param {object} opts.user
 */
export async function executeBuild({ buildId, user }) {
  const build = await AgentBuild.findById(buildId);
  if (!build) throw new Error(`Build ${buildId} not found`);

  // Recover builds that were left `running` after a worker crash — otherwise
  // they can never be re-queued and the workflow is stuck forever.
  const STALE_MS = 15 * 60_000;
  if (
    build.status === 'running' &&
    build.startedAt &&
    Date.now() - new Date(build.startedAt).getTime() > STALE_MS
  ) {
    build.status = 'queued';
    build.error = null;
    await build.save();
    log.warn('Re-queued a stale running build', { buildId });
  }

  if (build.status !== 'queued') {
    log.warn('Refusing to execute a build that is not queued', { buildId, status: build.status });
    return build;
  }

  const workflow = await AgentWorkflow.findById(build.workflow);
  if (!workflow) {
    build.status = 'failed';
    build.error = 'The workflow was deleted before this build started.';
    build.finishedAt = new Date();
    await build.save();
    return build;
  }

  const controller = new AbortController();
  inFlight.set(String(build._id), { userId: user._id, controller });

  try {
    return await withMetering(usage => buildInner({ build, workflow, user, controller, usage }));
  } finally {
    inFlight.delete(String(build._id));
  }
}

async function buildInner({ build, workflow, user, controller, usage }) {
  const startedAt = Date.now();
  const { signal } = controller;

  build.status = 'running';
  build.startedAt = new Date();
  await build.save();

  /**
   * Snapshot at session start. If the build fails or is canceled without a
   * successful `finish`, we restore this graph so a half-built mess of duplicate
   * triggers and orphans never becomes the lasting canvas.
   */
  const sessionStartGraph = {
    nodes: workflow.graph.nodes.map(n => {
      const plain = n.toObject?.() ?? n;
      return {
        ...plain,
        data: { ...plain.data, values: { ...(plain.data?.values || {}) } },
      };
    }),
    edges: workflow.graph.edges.map(e => (e.toObject?.() ?? e)),
  };
  const sessionStartName = workflow.name;
  const sessionStartRequirements = (workflow.requirements || []).map(r => r.toObject?.() ?? r);

  /**
   * Everything the architect is allowed to change, held in memory and flushed
   * to Mongo after each mutation. Kept as one object so a tool handler never
   * has to know whether it is looking at the saved copy or the working copy.
   */
  const state = {
    graph: {
      nodes: sessionStartGraph.nodes.map(n => ({
        ...n,
        data: { ...n.data, values: { ...n.data?.values } },
      })),
      edges: [...sessionStartGraph.edges],
    },
    name: sessionStartName,
    plan: [],
    sources: [],
    requirements: sessionStartRequirements.map(r => ({ ...r })),
    /** Outputs of steps `test_step` has run, so a later test can reference them. */
    testScope: { trigger: {} },
    /** Node ids that were executed and worked — the build's evidence. */
    tested: [],
    /** Set after the first successful plan call — further plan calls are refused. */
    planRecorded: false,
    /** Set after the first successful edit_graph application. */
    graphEdited: false,
    /** find_api_docs + search_web + read_url calls before the first edit_graph. */
    researchBeforeBuild: 0,
    /**
     * How many times `finish` has been refused.
     *
     * A gate that can refuse indefinitely is not a gate, it is a way to lose a
     * build: the user has already paid for the work whether or not it is handed
     * over, so a second opinion that cannot be satisfied ends with them holding
     * nothing. Structural errors are refused every time — those are objectively
     * broken. Judgement calls get one refusal, then say their piece in the
     * summary and let the build through.
     */
    refusals: 0,
    /** Set true only when finish() succeeds — controls whether we keep the graph. */
    handedOver: false,
    /** Set when ask_clarifying succeeds — ends the session for user answers. */
    awaitingClarification: false,
    clarifyingQuestions: [],
  };

  restoreSessionState(state, build.timeline);

  const needsClarification =
    build.intent === 'build' &&
    !build.clarificationSatisfied &&
    goalNeedsClarification(build.goal);
  const clarificationSatisfied = Boolean(build.clarificationSatisfied);

  const emit = async event => {
    const entry = {
      at: new Date(),
      type: event.type,
      title: safeMessage(event.title, 300),
      detail: safeMessage(event.detail, 4000),
      url: safeMessage(event.url, 1000),
      ok: event.ok !== false,
      meta: event.meta ?? null,
    };

    build.timeline.push(entry);
    // Bounded, for the same reason run logs are: a fifteen-step build with
    // chatty tool results should not be able to push the document past Mongo's
    // limit, because the thing that would fail to write is the summary.
    if (build.timeline.length > 300) build.timeline.splice(0, build.timeline.length - 300);

    publish(build._id, { type: 'build.event', event: { ...entry, at: entry.at.toISOString() } });

    await AgentBuild.updateOne(
      { _id: build._id },
      { $set: { timeline: build.timeline, status: build.status } }
    ).catch(() => {
      // A dropped timeline write is cosmetic — the event already went out live
      // and the graph itself is persisted separately.
    });
  };

  /** Persist the graph as it stands, so a build that dies leaves its work. */
  const flushGraph = async () => {
    workflow.graph = state.graph;
    workflow.name = state.name;
    workflow.version += 1;
    workflow.requirements = state.requirements;
    workflow.validation = {
      ...validateGraph(state.graph, {
        requirements: state.requirements,
        mode: 'architect',
      }),
      checkedAt: new Date(),
    };
    syncWorkflowSchedule(workflow, { enableWhenPresent: true });
    await workflow.save();
    publish(build._id, { type: 'build.graph', workflow: workflow.toEditorJSON() });
  };

  const restoreSessionStart = async () => {
    state.graph = {
      nodes: sessionStartGraph.nodes.map(n => ({
        ...n,
        data: { ...n.data, values: { ...n.data?.values } },
      })),
      edges: [...sessionStartGraph.edges],
    };
    state.name = sessionStartName;
    state.requirements = sessionStartRequirements.map(r => ({ ...r }));
    await flushGraph();
  };

  const searchable = isWebSearchConfigured();
  const tools = buildTools({
    state,
    emit,
    flushGraph,
    user,
    signal,
    searchable,
    goal: build.goal,
    needsClarification,
    clarificationSatisfied,
  });

  let outcome = null;
  let error = null;

  try {
    outcome = await runAgentLoop({
      system: architectSystemPrompt({
        intent: build.intent,
        webSearchAvailable: searchable,
        needsClarification,
        clarificationSatisfied,
      }),
      messages: build.messages.map(message => ({
        role: message.role,
        content: message.content,
      })),
      tools,
      maxSteps: needsClarification ? Math.min(6, config.agentic.architectMaxSteps) : config.agentic.architectMaxSteps,
      role: 'reasoning',
      task: 'agentic:architect',
      temperature: 0.2,
      maxResultChars: 24_000,
      signal,
      preferredTerminal: needsClarification ? 'ask_clarifying' : 'finish',
      onEvent: async event => {
        if (event.type === 'thinking' && event.text?.trim()) {
          await emit({ type: 'thought', detail: event.text });
        }
      },
      budgetNudge: ({ remaining }) => {
        if (needsClarification && !state.awaitingClarification) {
          return (
            `(Architect runtime — not a user message.) ${remaining} call` +
            `${remaining === 1 ? '' : 's'} left. Call ask_clarifying with 3–5 questions ` +
            `(delivery, source, topic, schedule, paid vs free). Do not plan or edit_graph yet.`
          );
        }
        const actions = state.graph.nodes.filter(node => !String(node.type).startsWith('trigger.'));
        if (actions.length === 0) {
          return (
            `(Architect runtime — not a user message.) ${remaining} call` +
            `${remaining === 1 ? '' : 's'} left. The graph has no action nodes yet. ` +
            `Call edit_graph now (schedule → fetch → summarise → email). Skip more research.`
          );
        }
        const check = validateGraph(state.graph, { mode: 'architect', requirements: [] });
        if (check.errors.length) {
          return (
            `(Architect runtime — not a user message.) ${remaining} call` +
            `${remaining === 1 ? '' : 's'} left. Graph invalid: ${check.errors[0]}. ` +
            `Fix with edit_graph, then finish.`
          );
        }
        return null;
      },
    });
  } catch (err) {
    error = err.message;
    log.error('Architect failed', { buildId: String(build._id), error: err.message });
  }

  const canceled = signal.aborted;
  const awaitingClarification = Boolean(
    state.awaitingClarification || outcome?.result?.awaitingClarification
  );
  // Only a successful `finish` (or ask_clarifying) hands work over. A prose-only
  // exit (`finishReason: 'answered'`) used to count as succeeded and leave a
  // half-built invalid graph marked done.
  const succeeded = Boolean(
    state.handedOver && outcome?.finished && !error && !canceled && !awaitingClarification
  );
  const endCheck = validateGraph(state.graph, {
    mode: 'architect',
    requirements: [],
  });
  // Keep any graph that gained action nodes — continue can fix validation.
  // Rolling back on step-budget / prose-exit was wiping real progress (HN fetch
  // chains) and stranding the user on a blank manual trigger.
  const keepGraph =
    !awaitingClarification &&
    (succeeded ||
      state.handedOver ||
      (state.graphEdited && actionNodeCount(state.graph) > 0));

  if (keepGraph) {
    workflow.blueprint = {
      goal: build.goal.slice(0, 4000),
      summary: safeMessage(outcome?.result?.summary || '', 4000),
      plan: state.plan,
      sources: state.sources,
      builtAt: new Date(),
    };
    if (!workflow.composedFrom) workflow.composedFrom = build.goal.slice(0, 2000);
    await flushGraph().catch(err => log.warn('Final graph flush failed', { error: err.message }));
  } else if (state.graphEdited && !awaitingClarification) {
    // Only roll back structural disasters with zero usable actions.
    await restoreSessionStart().catch(err =>
      log.warn('Could not restore pre-build graph', { error: err.message })
    );
  }

  await finishBuild({
    build,
    user,
    usage,
    startedAt,
    workflow,
    steps: outcome?.steps || 0,
    summary:
      outcome?.result?.summary ||
      outcome?.text ||
      (awaitingClarification ? 'Need a few details before building.' : ''),
    error:
      error ||
      (awaitingClarification
        ? null
        : !outcome?.finished
          ? 'The architect ran out of steps before it finished. Ask it to continue.'
          : !state.handedOver
            ? 'The architect stopped without handing over a finished workflow. Ask it to continue.'
            : null),
    canceled,
    awaitingClarification,
    clarifyingQuestions: state.clarifyingQuestions,
  });

  return build;
}

/** Settle the bill, write the terminal state, publish it. */
async function finishBuild({
  build,
  user,
  usage,
  startedAt,
  workflow,
  steps,
  summary,
  error,
  canceled,
  awaitingClarification = false,
  clarifyingQuestions = [],
}) {
  build.status = canceled
    ? 'canceled'
    : error
      ? 'failed'
      : awaitingClarification
        ? 'awaiting_clarification'
        : 'succeeded';
  build.summary = safeMessage(summary, 4000);
  build.error = error ? safeMessage(error, 1000) : null;
  build.steps = steps;
  build.finishedAt = new Date();
  build.clarifyingQuestions = awaitingClarification ? clarifyingQuestions : [];
  if (awaitingClarification) build.clarificationSatisfied = false;

  if (build.summary) {
    build.messages.push({ role: 'assistant', content: build.summary, at: new Date() });
  }

  const usageSummary = summarize(usage);
  build.cost = {
    llmPaise: usageSummary.cost.llmPaise,
    searchPaise: usageSummary.cost.searchPaise,
    totalPaise: usageSummary.cost.totalPaise,
  };
  build.tokens = usageSummary.tokens;

  /*
   * Base fee plus what the tokens actually cost.
   *
   * Intake-only rounds still meter tokens (the model wrote the questions) but
   * skip the flat agent.build base — the user has not received a workflow yet.
   */
  build.credits = awaitingClarification
    ? Math.max(1, Math.round(meteredCost('agent.build', usageSummary.cost.totalPaise) * 0.25))
    : meteredCost('agent.build', usageSummary.cost.totalPaise);

  try {
    const charge = await spend({
      user,
      action: 'agent.build',
      cost: build.credits,
      usage,
      allowOverdraft: true,
      meta: {
        buildId: String(build._id),
        workflowId: String(build.workflow),
        intent: build.intent,
        steps,
        outcome: build.status,
        clarifying: awaitingClarification,
      },
    });
    build.ledgerId = charge.ledgerId || null;
  } catch (err) {
    log.error('Failed to charge an architect build', { buildId: String(build._id), error: err.message });
  }

  if (error) {
    await recordFailure({
      user,
      action: 'agent.build',
      usage,
      reason: safeMessage(error, 200),
      meta: { buildId: String(build._id) },
    }).catch(() => {});
  }

  await AgentBuild.updateOne(
    { _id: build._id },
    {
      $set: {
        status: build.status,
        summary: build.summary,
        error: build.error,
        steps: build.steps,
        messages: build.messages,
        timeline: build.timeline,
        clarifyingQuestions: build.clarifyingQuestions,
        clarificationSatisfied: build.clarificationSatisfied,
        credits: build.credits,
        cost: build.cost,
        tokens: build.tokens,
        ledgerId: build.ledgerId,
        finishedAt: build.finishedAt,
      },
    }
  );

  publish(build._id, {
    type: 'build.finished',
    status: build.status,
    summary: build.summary,
    error: build.error,
    credits: build.credits,
    steps: build.steps,
    clarifyingQuestions: build.clarifyingQuestions,
    durationMs: Date.now() - startedAt,
    workflow: workflow.toEditorJSON(),
  });

  log.info('Architect build finished', {
    buildId: String(build._id),
    status: build.status,
    steps,
    credits: build.credits,
    costPaise: build.cost.totalPaise,
    clarifying: awaitingClarification,
  });
}

// ─── Tools ──────────────────────────────────────────────────

/**
 * Steps that were never proven to work.
 *
 * Restricted to the two where being wrong is both likely and invisible.
 *
 * A GET request, because the architect wrote it from a documentation page it
 * may have misread, and every downstream `{{ }}` reference was then guessed
 * against a response shape nobody has seen. Running it is free of side effects
 * and settles both questions at once.
 *
 * A loop opener, because `{{ fetch.data.items }}` passes reference validation —
 * `data` is a declared output — and then turns out to be an object, or a
 * string, or a list nested one level deeper than assumed. A loop over a
 * non-list fails the run; a loop over an empty one succeeds and does nothing,
 * which is worse. Running the opener resolves and counts the list without
 * running the body.
 *
 * Everything else is excluded on purpose. A node with side effects cannot be
 * tested at all, and demanding evidence for a template or a code node produces
 * a refusal the model satisfies by running something pointless.
 */
function untestedRequests(state) {
  return state.graph.nodes
    .filter(node => {
      if (node.type === 'core.forEach') return true;
      if (node.type !== 'core.http') return false;
      return String(node.data?.values?.method || 'GET').toUpperCase() === 'GET';
    })
    .filter(node => !state.tested.includes(node.id))
    .map(node => node.id);
}

function actionNodeCount(graph) {
  return (graph?.nodes || []).filter(node => !String(node.type).startsWith('trigger.')).length;
}

/** Refuse open-ended research once the architect should be building instead. */
function assertMayResearch(state, { needsClarification } = {}) {
  if (needsClarification) {
    throw new Error(
      'Do not research yet. Call ask_clarifying with 3–5 structured questions about ' +
        'delivery, source, topic, schedule, and paid vs free APIs, then stop.'
    );
  }
  if (state.graphEdited) return;
  if (state.researchBeforeBuild >= 3) {
    throw new Error(
      'You have already researched enough for one session. Call edit_graph now — add the ' +
        'trigger and the first real steps. You can test_step after the graph exists.'
    );
  }
  state.researchBeforeBuild += 1;
}

function assertMayBuild(_state, { needsClarification } = {}) {
  if (needsClarification) {
    throw new Error(
      'The goal is underspecified. Call ask_clarifying first (delivery destination, news ' +
        'source, topic/filter, schedule hour, paid vs free APIs). Do not edit the graph yet.'
    );
  }
}

function buildTools({
  state,
  emit,
  flushGraph,
  user,
  signal,
  searchable,
  goal,
  needsClarification = false,
}) {
  const tools = {};

  tools.ask_clarifying = defineTool({
    description:
      'Pause the build and ask the user 3–5 structured intake questions. Use this when ' +
      'delivery, source, topic, schedule, or paid-API choices are missing. After this call ' +
      'the session ends; the user answers in the UI and a follow-up session builds.',
    properties: {
      summary: {
        type: 'string',
        description: 'Short markdown explaining why you need these details before building.',
      },
      questions: {
        type: 'array',
        description:
          '3–5 questions. Prefer choice with concrete options as plain strings ' +
          '(e.g. ["Hacker News","Reddit","Custom RSS URL"]), never objects. Use text for emails/URLs.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Stable id: delivery, source, topic, schedule, budget…' },
            question: { type: 'string' },
            type: { type: 'string', enum: ['choice', 'text'] },
            options: {
              type: 'array',
              items: { type: 'string' },
              description: 'Plain string labels only — not {label,value} objects.',
            },
          },
          required: ['id', 'question'],
        },
      },
    },
    required: ['summary', 'questions'],
    terminal: true,
    run: async ({ summary, questions }) => {
      const normalized = normalizeClarifyingQuestions(questions);
      if (normalized.length < 2) {
        throw new Error('ask_clarifying needs at least 2 questions (aim for 3–5).');
      }

      state.awaitingClarification = true;
      state.clarifyingQuestions = normalized;

      await emit({
        type: 'clarify',
        title: 'Need a few details',
        detail: safeMessage(summary, 800),
        meta: { questions: normalized },
      });

      return {
        awaitingClarification: true,
        questions: normalized,
        summary: safeMessage(summary, 2000),
      };
    },
  });

  tools.plan = defineTool({
    description:
      'Record the stages you intend to build, in order. Call this once, early, before you ' +
      'start editing the graph. Each stage must name the concrete node types you will add ' +
      '(e.g. trigger.schedule → core.http → core.llm → core.email). The user watches this.',
    properties: {
      steps: {
        type: 'array',
        description: '3–7 stages.',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Short stage name.' },
            detail: { type: 'string', description: 'One line on what happens here.' },
          },
          required: ['title'],
        },
      },
    },
    required: ['steps'],
    run: async ({ steps }) => {
      assertMayBuild(state, { needsClarification });
      if (state.planRecorded) {
        throw new Error(
          'The plan is already recorded. Do not call plan again — call edit_graph to add nodes ' +
          'and connect them, then test_step and finish.'
        );
      }
      state.planRecorded = true;
      state.plan = (steps || []).slice(0, 12).map(step => ({
        title: safeMessage(step.title, 200),
        detail: safeMessage(step.detail, 1000),
      }));
      await emit({
        type: 'plan',
        title: `Planned ${state.plan.length} stages`,
        meta: { plan: state.plan },
      });
      return { ok: true, stages: state.plan.length };
    },
  });

  if (searchable) {
    /**
     * The one to reach for when the question is "how do I call this service".
     *
     * It exists next to `search_web` rather than instead of it because the two
     * failures it removes are both real. Left to a bare search, a model reads
     * the snippets and picks the marketing page over the reference — the
     * snippets are written to sell, and the reference ranks lower. And when it
     * does pick the reference, that page is usually a JavaScript application
     * whose HTML contains an empty div, so it reads nothing and quietly
     * proceeds on memory. This searches with documentation-shaped intent,
     * re-ranks toward references, and renders what it picks.
     */
    tools.find_api_docs = defineTool({
      description:
        "Find and read a service's official API documentation in one step. Prefer this " +
        'over search_web + read_url whenever you need to know how to call an API. ' +
        'Returns the ranked search results and the full text of the most reference-like pages.',
      properties: {
        service: {
          type: 'string',
          description: 'The service and the operation, e.g. "Notion create a page" or "Resend send email".',
        },
      },
      required: ['service'],
      run: async ({ service }) => {
        assertMayResearch(state, { needsClarification });
        const found = await searchDocs(String(service), { maxPages: 2 });
        if (!found) {
          throw new Error('Documentation search is unavailable right now — try search_web and read_url.');
        }

        for (const page of found.pages) {
          const hit = found.results.find(r => r.url === page.url);
          if (!state.sources.some(source => source.url === page.url)) {
            state.sources.push({ title: hit?.title || page.url, url: page.url, note: `Docs for ${service}` });
          }
        }

        await emit({
          type: 'read',
          title: `Docs: ${String(service).slice(0, 120)}`,
          url: found.pages[0]?.url,
          detail: found.pages.map(p => p.url).join(' · ') || 'no page could be read',
          meta: { results: found.results.slice(0, 5) },
        });

        return {
          results: found.results.slice(0, 5),
          pages: found.pages.map(page => ({ url: page.url, text: page.text.slice(0, 14_000) })),
        };
      },
    });

    tools.search_web = defineTool({
      description:
        'Search the live web. Use it for anything that is not an API reference — comparing ' +
        'services, checking whether something is still free, finding a status page. ' +
        'Returns titles, URLs and snippets.',
      properties: {
        query: { type: 'string', description: 'The search query.' },
      },
      required: ['query'],
      run: async ({ query }) => {
        assertMayResearch(state, { needsClarification });
        const results = await webSearch(String(query), { maxResults: 6 });
        if (!results) throw new Error('Web search is unavailable right now — build from what you know and say so.');
        await emit({
          type: 'search',
          title: String(query).slice(0, 200),
          detail: results.map(r => r.title).join(' · '),
          meta: { results },
        });
        return results;
      },
    });
  }

  tools.read_url = defineTool({
    description:
      'Fetch a page and return its readable text. This is how you learn an API: read the ' +
      'reference page and take the exact base URL, path, method, auth scheme, parameters and ' +
      'response shape from it. Also works on JSON endpoints and OpenAPI documents.',
    properties: {
      url: { type: 'string', description: 'An http(s) URL.' },
      why: { type: 'string', description: 'One short line on what you are looking for here.' },
    },
    required: ['url'],
    run: async ({ url, why }) => {
      assertMayResearch(state, { needsClarification });
      // `allowRender` on: a build reads a given page once, so a rendered retry
      // costs one credit to turn an empty app shell into the reference the
      // whole step was for. Workflow nodes, which fetch on every run, don't
      // get it.
      const page = await fetchPage(String(url), { maxChars: 12000, signal, allowRender: true });

      // Recorded as a source only when it worked, so the provenance list on the
      // workflow is pages that were actually read rather than every URL tried.
      if (!state.sources.some(source => source.url === page.url)) {
        state.sources.push({
          title: page.title || page.url,
          url: page.url,
          note: safeMessage(why, 600),
        });
      }

      await emit({
        type: 'read',
        title: page.title || page.url,
        url: page.url,
        detail: safeMessage(why, 600),
      });

      return { title: page.title, url: page.url, text: page.text };
    },
  });

  tools.search_tool_catalog = defineTool({
    description:
      'Search our own catalog of AI tools. Use this when the user needs a product ' +
      'recommendation ("which tool should I use to edit the video?"), not when you need an API.',
    properties: {
      query: { type: 'string', description: 'What kind of tool they need.' },
    },
    required: ['query'],
    run: async ({ query }) => {
      const results = await searchCatalog(String(query), { limit: 6 });
      await emit({
        type: 'catalog',
        title: String(query).slice(0, 200),
        detail: (results || []).map(tool => tool.name).join(' · '),
      });
      return (results || []).map(tool => ({
        name: tool.name,
        category: tool.category,
        pricing: tool.pricing,
        tagline: tool.tagline,
        url: tool.websiteUrl,
      }));
    },
  });

  tools.describe_node = defineTool({
    description:
      'Get the full field list, defaults and output paths for one node type. Use it when you ' +
      'are unsure what a field expects.',
    properties: {
      type: { type: 'string', description: 'A node type, e.g. "core.http".' },
    },
    required: ['type'],
    run: async ({ type }) => {
      const def = getNodeDef(String(type));
      if (!def) {
        throw new Error(`No node type "${type}". Available: ${NODE_LIST.map(n => n.type).join(', ')}.`);
      }
      return {
        type: def.type,
        label: def.label,
        description: def.description,
        credits: def.credits,
        fields: def.fields,
        outputs: def.outputs,
        handles: def.handles,
      };
    },
  });

  tools.require_credential = defineTool({
    description:
      'Declare an API key, token or secret the user must provide before this workflow can run. ' +
      'Write instructions they can actually follow. Never put the secret itself anywhere.',
    properties: {
      key: { type: 'string', description: 'Short stable id, e.g. "notion_token".' },
      label: { type: 'string', description: 'What to call it in the UI, e.g. "Notion integration token".' },
      provider: {
        type: 'string',
        description: 'One of: http, openai, anthropic, slack, discord, telegram, notion, generic.',
      },
      instructions: { type: 'string', description: 'Step-by-step, in plain language, on how to obtain it.' },
      docsUrl: { type: 'string', description: 'Link to the page where they get it.' },
      usedBy: {
        type: 'array',
        description: 'Node ids that will use it.',
        items: { type: 'string' },
      },
    },
    required: ['key', 'label', 'instructions'],
    run: async ({ key, label, provider, instructions, docsUrl, usedBy }) => {
      const requirement = {
        key: safeMessage(key, 60),
        label: safeMessage(label, 120),
        provider: safeMessage(provider || 'generic', 40),
        instructions: safeMessage(instructions, 2000),
        docsUrl: safeMessage(docsUrl, 1000),
        usedBy: (usedBy || []).map(id => safeMessage(id, 60)).slice(0, 20),
        credentialId: null,
      };

      // Re-declaring is an update, not a duplicate: the architect routinely
      // names a requirement before it knows which node will consume it, then
      // says so again once the node exists.
      const existing = state.requirements.findIndex(r => r.key === requirement.key);
      if (existing >= 0) {
        state.requirements[existing] = { ...state.requirements[existing], ...requirement,
          credentialId: state.requirements[existing].credentialId };
      } else {
        state.requirements.push(requirement);
      }

      await emit({
        type: 'requirement',
        title: requirement.label,
        detail: requirement.instructions,
        url: requirement.docsUrl,
        meta: { key: requirement.key, provider: requirement.provider },
      });
      await flushGraph();

      return { ok: true, message: 'Recorded. Leave the credential field on the node empty.' };
    },
  });

  tools.inspect_graph = defineTool({
    description: 'Read the workflow as it currently stands, with any validation errors.',
    properties: {},
    run: async () => {
      const validation = validateGraph(state.graph, { requirements: state.requirements });
      return {
        name: state.name,
        graph: describeGraph(state.graph),
        errors: validation.errors,
        warnings: validation.warnings,
      };
    },
  });

  tools.edit_graph = defineTool({
    description:
      'Apply operations to the workflow. Operations: addNode {id, type, title, values}, ' +
      'updateNode {id, values, title}, deleteNode {id}, connect {from, to, handle}, ' +
      'disconnect {from, to}, rename {name}. Returns what applied, what was rejected, and the ' +
      'current validation errors — read them and fix them.',
    properties: {
      operations: {
        type: 'array',
        description: 'The operations to apply, in order.',
        items: {
          type: 'object',
          properties: {
            op: {
              type: 'string',
              enum: ['addNode', 'updateNode', 'deleteNode', 'connect', 'disconnect', 'rename'],
            },
            id: { type: 'string' },
            type: { type: 'string' },
            title: { type: 'string' },
            note: { type: 'string' },
            values: { type: 'object', additionalProperties: true },
            from: { type: 'string' },
            to: { type: 'string' },
            handle: { type: 'string' },
            name: { type: 'string' },
          },
          required: ['op'],
        },
      },
    },
    required: ['operations'],
    run: async ({ operations }) => {
      assertMayBuild(state, { needsClarification });
      const beforeOrphans = findOrphans(state.graph.nodes, state.graph.edges).length;
      const beforeTriggers = state.graph.nodes.filter(
        n => getNodeDef(n.type)?.kind === 'trigger'
      ).length;

      const result = applyOperations(state.graph, operations || []);
      if (result.applied.length) state.graphEdited = true;
      state.graph = result.graph;
      if (result.name) state.name = result.name;

      const validation = validateGraph(state.graph, {
        requirements: state.requirements,
        mode: 'architect',
      });

      const afterOrphans = findOrphans(state.graph.nodes, state.graph.edges).length;
      const afterTriggers = state.graph.nodes.filter(
        n => getNodeDef(n.type)?.kind === 'trigger'
      ).length;

      await emit({
        type: 'graph',
        title:
          result.applied.length === 0
            ? 'No changes applied'
            : `${result.applied.length} change${result.applied.length === 1 ? '' : 's'} applied`,
        detail: result.applied
          .map(op => (op.id ? `${op.op} ${op.id}` : `${op.op} ${op.from ?? ''}→${op.to ?? ''}`))
          .join(', '),
        ok: result.rejected.length === 0 && validation.errors.length === 0,
        meta: { applied: result.applied, rejected: result.rejected, errors: validation.errors },
      });

      // Flush live so the canvas updates; terminal failure may roll back later.
      if (result.applied.length) await flushGraph();

      let hint = null;
      if (afterTriggers > 1 || (afterTriggers > beforeTriggers && beforeTriggers >= 1)) {
        hint =
          'You added a second trigger. Delete every extra trigger with deleteNode — exactly one allowed.';
      } else if (afterOrphans > beforeOrphans) {
        hint =
          `Orphan count rose from ${beforeOrphans} to ${afterOrphans}. ` +
          'Connect new nodes to the existing chain or deleteNode them before adding more.';
      } else if (validation.errors.some(error => error.includes('Only one trigger'))) {
        hint = 'Delete every extra trigger with deleteNode before adding another. One trigger only.';
      } else if (validation.errors.some(e => e.includes("won't run") || e.includes('won’t run'))) {
        hint = 'Disconnected nodes remain — connect them or deleteNode the orphans before adding more.';
      }

      return {
        applied: result.applied,
        rejected: result.rejected,
        errors: validation.errors,
        warnings: validation.warnings,
        graph: describeGraph(state.graph),
        hint,
      };
    },
  });

  tools.test_step = defineTool({
    description:
      'Actually execute one step and return its real output. Use it on every GET request, on ' +
      'every For Each opener — it resolves the list and counts it without running the body — ' +
      'and on any step whose output shape you are guessing at. Correct downstream {{ }} ' +
      'references to match what really came back. Steps that send things (email, Slack, ' +
      'Discord, Telegram, Notion) cannot be tested, and neither can non-GET requests, because ' +
      'running them twice would be a real side effect.',
    properties: {
      nodeId: { type: 'string', description: 'The id of the node to run.' },
      triggerInput: {
        type: 'object',
        description: 'Optional sample payload to expose as {{ trigger.* }}.',
        additionalProperties: true,
      },
    },
    required: ['nodeId'],
    run: async ({ nodeId, triggerInput }) => {
      const node = state.graph.nodes.find(n => n.id === nodeId);
      if (!node) {
        throw new Error(`No node "${nodeId}". The graph has: ${state.graph.nodes.map(n => n.id).join(', ') || 'nothing'}.`);
      }

      const def = getNodeDef(node.type);
      if (!def) throw new Error(`"${node.type}" is not a known node type.`);

      if (!isTestable(node.type)) {
        throw new Error(
          `${def.label} has side effects, so it can't be test-run. Check its configuration by reading the docs instead.`
        );
      }

      const method = String(node.data?.values?.method || 'GET').toUpperCase();
      if (node.type === 'core.http' && method !== 'GET') {
        throw new Error(
          `This is a ${method} request, so running it would change something on the other end. ` +
          `Verify it against the documentation instead.`
        );
      }

      const missing = def.fields
        .filter(field => field.required)
        .filter(field => {
          const value = node.data?.values?.[field.key];
          return value === undefined || value === null || String(value).trim() === '';
        })
        .map(field => field.label);

      if (missing.length) {
        throw new Error(`"${nodeId}" is missing ${missing.join(', ')}. Fill it in first.`);
      }

      if (triggerInput && typeof triggerInput === 'object') {
        state.testScope.trigger = triggerInput;
      }

      const startedAt = Date.now();
      const values = resolveValues(node.data?.values || {}, def.fields, state.testScope);

      try {
        const output = await getExecutor(node.type)({
          values,
          nodeId: node.id,
          userId: user._id,
          user,
          /*
           * Deliberately null, and it must stay null.
           *
           * A step that remembers what it has seen — `core.dedupe` — keys that
           * memory on the workflow. Test-running one during a build with a real
           * workflow id would mark the entire existing backlog as already seen,
           * so the first genuine run finds nothing new and the user's first
           * experience of the workflow is it doing nothing. Nodes read this and
           * pass everything through untracked when it is absent.
           */
          workflowId: null,
          trigger: { payload: state.testScope.trigger },
          scope: state.testScope,
          edges: state.graph.edges,
          signal,
          onLog: () => {},
        });

        state.testScope[node.id] = output;
        if (!state.tested.includes(node.id)) state.tested.push(node.id);
        const capped = capOutput(output, 4000);

        await emit({
          type: 'test',
          title: `Ran ${node.data?.title || def.label}`,
          detail: JSON.stringify(capped).slice(0, 1200),
          ok: true,
          meta: { nodeId, ms: Date.now() - startedAt },
        });

        return {
          ok: true,
          ms: Date.now() - startedAt,
          output: capped,
          hint: 'Reference these exact field names downstream.',
        };
      } catch (err) {
        await emit({
          type: 'test',
          title: `${node.data?.title || def.label} failed`,
          detail: err.message,
          ok: false,
          meta: { nodeId },
        });
        // Rethrown so the loop reports it to the model as a tool failure, which
        // is what prompts it to go back to the docs rather than carry on.
        throw new Error(`Running "${nodeId}" failed: ${err.message}`);
      }
    },
  });

  tools.finish = defineTool({
    description:
      'End the session. Call this once the workflow is built, valid and — where possible — ' +
      'tested. The summary is shown to the user as your reply. If the graph still has ' +
      'validation errors this call is refused and you must fix them first.',
    properties: {
      name: { type: 'string', description: 'A short, specific name for the workflow.' },
      summary: {
        type: 'string',
        description:
          'Markdown for the user. Required sections: ## What it does, ## Workflow ' +
          '(with a ```mermaid flowchart TD``` block showing the real nodes), ' +
          '## Requirements (bullets), ## Not verified (bullets or "None").',
      },
    },
    required: ['summary'],
    terminal: true,
    run: async ({ name, summary }) => {
      assertMayBuild(state, { needsClarification });
      if (actionNodeCount(state.graph) === 0) {
        throw new Error(
          'The graph has no action steps yet — only a trigger (or nothing) is not a workflow. ' +
          'Call edit_graph to add fetch, summarise, and deliver steps, then call finish again.'
        );
      }

      /*
       * The gate. `finish` is the only way out of the loop, so checking here is
       * the one place a broken graph cannot get past.
       *
       * A model that has been working for twelve steps is strongly inclined to
       * declare victory, and the previous behaviour took it at its word — which
       * is how a workflow with an empty required field arrived at the user
       * looking finished and failed on its first run. Refusing the call turns
       * that into another round with a specific list of what is wrong, which is
       * exactly the input the model needs and cannot produce for itself.
       *
       * Three checks now, in ascending order of how arguable they are, and the
       * order is the point: the objective one refuses every time, the others
       * refuse once. Missing credentials are still not a defect — the user
       * supplies those after the build, by design.
       */

      // 1. Structural. Architect mode: orphans and multi-triggers block handover;
      //    credentials and userSupplied fields (email To) are warnings only.
      const check = validateGraph(state.graph, {
        requirements: state.requirements,
        mode: 'architect',
      });
      if (check.errors.length) {
        await emit({
          type: 'test',
          title: 'Not finished yet',
          detail: check.errors.slice(0, 6).join(' · '),
          ok: false,
        });

        throw new Error(
          `The workflow is not valid yet, so it cannot be handed over:\n` +
          `${check.errors.map(problem => `- ${problem}`).join('\n')}\n\n` +
          `Fix every one of these with edit_graph (deleteNode orphans and extra triggers), then call finish again.`
        );
      }

      // 2. Evidence. A workflow nobody ran is a workflow nobody has any reason
      //    to believe in — and running the request is also how the field names
      //    every downstream reference depends on stop being a guess.
      const untested = untestedRequests(state);
      if (untested.length && state.refusals === 0) {
        state.refusals += 1;
        await emit({
          type: 'test',
          title: 'Untested steps',
          detail: untested.join(', '),
          ok: false,
        });

        throw new Error(
          `These steps have never actually been run: ${untested.join(', ')}.\n\n` +
          `Call test_step on each one. A GET proves the endpoint and auth and shows the real ` +
          `field names. A For Each opener resolves and counts the list without running the body — ` +
          `the difference between a loop that does nothing and one that fails halfway through. If ` +
          `one genuinely cannot be tested — it needs a credential the user has not supplied — call ` +
          `finish again and say so in the summary.`
        );
      }

      // 3. Acceptance. Structurally valid and provably running is still not the
      //    same as "what they asked for" — a second model reads the goal and
      //    the graph cold. Advice, not law: one refusal, then it is the user's
      //    call, which is why the objections go into the summary.
      if (state.refusals < 2) {
        const verdict = await reviewBuild({
          goal,
          graph: state.graph,
          tested: state.tested,
          signal,
        });

        if (!verdict.ok) {
          state.refusals = 2;
          await emit({
            type: 'test',
            title: 'Review found gaps',
            detail: verdict.issues.join(' · '),
            ok: false,
          });

          throw new Error(
            `A review of the finished workflow against the original request found:\n` +
            `${verdict.issues.map(issue => `- ${issue}`).join('\n')}\n\n` +
            `Fix what is genuinely missing and call finish again. If you disagree with a point — ` +
            `you built it a different way on purpose — call finish again and explain that in the ` +
            `summary. This will not be raised a second time.`
          );
        }
      }

      if (name) {
        state.name = safeMessage(name, 120);
        await flushGraph();
      }
      state.handedOver = true;
      return {
        name: state.name,
        summary: safeMessage(summary, 4000),
        tested: state.tested,
        warnings: check.warnings,
      };
    },
  });

  return tools;
}

export default { executeBuild, cancelBuild, activeBuildCount };
