/**
 * Workflow engine — the orchestration layer.
 *
 *   route → retrieve → plan → validate/repair → playbooks (parallel) → assemble
 *
 * Each phase is small, typed and independently verifiable. The controller only
 * consumes `handleMessage`, and can subscribe to `onProgress` to stream the
 * real pipeline state to the UI instead of a fake spinner.
 */

import crypto from 'crypto';
import config from '../config/index.js';
import { complete, completeJson, isLLMAvailable, LLMError } from './llm.js';
import { retrieve } from './retriever.js';
import { getCatalog, toCandidateCard } from './catalog.js';
import { checkInput, checkOutput, fence, GuardrailError } from './guardrails.js';
import {
  buildContextMessages,
  loadProfile,
  updateProfileFacts,
  incrementClarifyingQuestionsAsked,
  recallRelatedSessions,
  saveClarificationState,
  clearClarificationState,
} from './memory.js';
import cache from './cache.js';
import * as prompts from './prompts.js';
import { patchWorkflow } from './workflowDiff.js';
import { webSearch, isWebSearchConfigured, wantsFreshInfo } from './tools/webSearch.js';
import { discoverAndQueueTools } from './tools/toolDiscovery.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('ai:engine');

const noop = () => {};

/**
 * Cap a string without slicing mid-word. Prefers to end on the last complete
 * sentence, falls back to the last word boundary, and only then adds an
 * ellipsis — a hard `.slice()` is what produces text that stops mid-thought.
 */
function truncate(text, max) {
  const clean = String(text ?? '').trim();
  if (clean.length <= max) return clean;

  const window = clean.slice(0, max);

  // Prefer a sentence end that keeps at least 60% of the budget.
  const lastSentence = Math.max(
    window.lastIndexOf('. '),
    window.lastIndexOf('! '),
    window.lastIndexOf('? ')
  );
  if (lastSentence > max * 0.6) return window.slice(0, lastSentence + 1).trim();

  const lastSpace = window.lastIndexOf(' ');
  const cut = lastSpace > max * 0.6 ? window.slice(0, lastSpace) : window;
  return `${cut.replace(/[,;:.\-\s]+$/, '')}…`;
}

// ─────────────────────────────────────────────────────────────
// Phase 1 — routing
// ─────────────────────────────────────────────────────────────

const VALID_INTENTS = ['workflow', 'refine', 'discover', 'question', 'smalltalk'];

/** Caps how many times we'll ever interrupt a returning user with clarifying questions. */
const MAX_CLARIFYING_ASKS = 3;

const APPROVAL_RE = /\b(yes|create the workflow|generate the workflow|build it|go ahead|approve|looks good|let'?s do it|start planning|make the workflow|design the workflow)\b/i;

function sanitizeClarifyingQuestions(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter(q => q && q.question)
    .slice(0, 6)
    .map((q, i) => ({
      id: String(q.id || `q${i}`).slice(0, 40),
      question: String(q.question).slice(0, 160),
      type: q.type === 'text' ? 'text' : 'choice',
      options: Array.isArray(q.options)
        ? q.options.map(o => String(o).slice(0, 60)).slice(0, 6)
        : undefined,
    }));
}

async function route({ message, contextMessages, categories, hasPriorWorkflow, profile }) {
  const { data } = await completeJson({
    task: 'route',
    role: 'fast',
    temperature: 0.1,
    maxTokens: 700,
    messages: [
      { role: 'system', content: prompts.routerSystem(categories, profile) },
      ...contextMessages.slice(-4),
      {
        role: 'user',
        content:
          fence(message) +
          (hasPriorWorkflow
            ? '\n\nNote: a workflow already exists in this conversation, so an adjustment request should be classified as "refine".'
            : ''),
      },
    ],
    validate: v => {
      if (!v || typeof v !== 'object') return 'Response must be a JSON object.';
      if (!VALID_INTENTS.includes(v.intent)) {
        return `"intent" must be one of: ${VALID_INTENTS.join(', ')}.`;
      }
      if (['workflow', 'refine'].includes(v.intent) && !v.goal) {
        return '"goal" is required for workflow and refine intents.';
      }
      return null;
    },
  });

  const validCategories = new Set(categories);
  const askedTooOften = (profile?.clarifyingQuestionsAsked || 0) >= MAX_CLARIFYING_ASKS;

  return {
    intent: data.intent,
    goal: String(data.goal || message).slice(0, 500),
    title: String(data.title || '').slice(0, 80),
    domains: (Array.isArray(data.domains) ? data.domains : []).filter(d => validCategories.has(d)),
    searchQueries: (Array.isArray(data.searchQueries) ? data.searchQueries : [])
      .map(q => String(q).slice(0, 80))
      .filter(Boolean)
      .slice(0, 6),
    pricing: ['free', 'paid', 'any'].includes(data.pricing)
      ? data.pricing
      : (profile?.pricingPreference || 'any'),
    skill: ['beginner', 'intermediate', 'advanced'].includes(data.skill)
      ? data.skill
      : (profile?.skillLevel || 'beginner'),
    // A returning user who's already been asked enough gets our best guess
    // instead of another round of questions.
    clarifyingQuestions: askedTooOften ? [] : sanitizeClarifyingQuestions(data.clarifyingQuestions),
  };
}

/** Deterministic fallback so a router hiccup never breaks the request. */
function heuristicRoute(message, hasPriorWorkflow, profile) {
  const text = message.toLowerCase();
  const buildish = /\b(create|make|build|launch|produce|design|write|generate|start|set up|turn .* into)\b/.test(text);
  const refineish = /\b(cheaper|free only|faster|simpler|instead|swap|replace|add|remove|advanced)\b/.test(text);

  let intent = 'discover';
  if (hasPriorWorkflow && refineish) intent = 'refine';
  else if (buildish) intent = 'workflow';
  else if (/\b(what|which|who|when|why|how much|vs|versus|compare|best|better)\b/.test(text)) intent = 'discover';

  return {
    intent,
    goal: message.slice(0, 500),
    title: '',
    domains: [],
    searchQueries: [message.slice(0, 80)],
    pricing: /\bfree\b/.test(text)
      ? 'free'
      : /\b(paid|premium|professional|pro\b)/.test(text) ? 'paid' : (profile?.pricingPreference || 'any'),
    skill: /\b(advanced|expert|pro)\b/.test(text) ? 'advanced' : (profile?.skillLevel || 'beginner'),
    clarifyingQuestions: [],
  };
}

// ─────────────────────────────────────────────────────────────
// Phase 2 — planning
// ─────────────────────────────────────────────────────────────

async function plan({ goal, cards, pricing, skill, priorWorkflow, adjustment, profile }) {
  const validSlugs = new Set(cards.map(c => c.slug));
  const { minStages, maxStages } = config.ai;

  const { data, model } = await completeJson({
    task: 'plan',
    role: 'planner',
    temperature: 0.4,
    // Headroom for the upper bound of stages, each carrying why/input/output
    // plus the closing tips array — a truncated plan loses whole stages.
    maxTokens: 3600,
    messages: [
      { role: 'system', content: prompts.plannerSystem({ minStages, maxStages, pricing, skill, profile }) },
      { role: 'user', content: prompts.plannerUser({ goal, candidates: cards, priorWorkflow, adjustment }) },
    ],
    validate: v => {
      if (!v || !Array.isArray(v.stages)) return '"stages" must be an array.';
      if (v.stages.length < 2) return `Provide at least ${minStages} stages.`;

      const bad = v.stages
        .map(s => s?.toolSlug)
        .filter(slug => !validSlugs.has(slug));

      if (bad.length) {
        return `These toolSlug values are not in CANDIDATE_TOOLS: ${[...new Set(bad)].join(', ')}. ` +
          `Use only slugs copied exactly from the candidate list.`;
      }

      const missing = v.stages.find(s => !s.title || !s.output);
      if (missing) return 'Every stage needs a non-empty "title" and "output".';

      return null;
    },
  });

  return { raw: data, model };
}

/**
 * Normalise the plan against the catalog: drop unknown slugs, collapse
 * accidental duplicates, clamp the stage count, and backfill anything thin.
 */
function normalizePlan(raw, { bySlug, goal, title }) {
  const seen = new Set();
  const stages = [];

  for (const stage of raw.stages || []) {
    const tool = bySlug.get(stage.toolSlug);
    if (!tool) continue;

    // The planner occasionally reuses a tool for consecutive stages; merging
    // them reads better than showing the same node twice in a row.
    if (seen.has(stage.toolSlug) && stages.at(-1)?.toolSlug === stage.toolSlug) {
      const prev = stages.at(-1);
      prev.title = `${prev.title} & ${stage.title}`;
      prev.output = stage.output || prev.output;
      prev.timeMinutes += Number(stage.timeMinutes) || 15;
      continue;
    }
    seen.add(stage.toolSlug);

    const alternatives = (Array.isArray(stage.alternativeSlugs) ? stage.alternativeSlugs : [])
      .filter(s => s !== stage.toolSlug && bySlug.has(s))
      .slice(0, 2)
      .map(s => {
        const alt = bySlug.get(s);
        return { slug: alt.slug, name: alt.name, pricing: alt.pricing, logo: alt.logo };
      });

    stages.push({
      id: `stage-${stages.length + 1}`,
      index: stages.length,
      title: String(stage.title).slice(0, 80),
      toolSlug: tool.slug,
      tool,
      why: String(stage.why || `${tool.name} handles this stage.`).slice(0, 300),
      input: String(stage.input || '').slice(0, 300),
      output: String(stage.output || '').slice(0, 300),
      timeMinutes: Math.min(240, Math.max(5, Number(stage.timeMinutes) || 20)),
      alternatives,
      // Filled in by the playbook phase.
      steps: [],
      prompt: null,
      settings: null,
      pitfall: '',
      checkpoint: '',
    });

    if (stages.length >= config.ai.maxStages) break;
  }

  // Re-chain inputs so the displayed handover is always consistent, even if
  // the model was sloppy about it.
  stages.forEach((s, i) => {
    s.index = i;
    s.id = `stage-${i + 1}`;
    if (i === 0) {
      s.input = s.input || 'Your idea or brief';
    } else {
      s.input = stages[i - 1].output;
    }
  });

  return {
    title: String(raw.title || title || goal).slice(0, 100),
    summary: String(raw.summary || '').slice(0, 500),
    outcome: String(raw.outcome || stages.at(-1)?.output || '').slice(0, 300),
    difficulty: ['beginner', 'intermediate', 'advanced'].includes(raw.difficulty)
      ? raw.difficulty
      : 'beginner',
    stages,
    tips: (Array.isArray(raw.tips) ? raw.tips : [])
      .map(t => String(t).slice(0, 240))
      .filter(Boolean)
      .slice(0, 4),
  };
}

// ─────────────────────────────────────────────────────────────
// Phase 3 — playbooks, generated in parallel
// ─────────────────────────────────────────────────────────────

/** Deterministic fallback so a stage is never blank if one call fails. */
function fallbackPlaybook(stage) {
  const name = stage.tool.name;
  return {
    steps: [
      { title: `Open ${name} and start a new project`, detail: `Sign in to ${name} and create a new workspace for this stage.` },
      { title: `Bring in what the last stage produced`, detail: `Import or paste in: ${stage.input}.` },
      { title: `Do the core work for this stage`, detail: stage.why },
      { title: `Export the result for the next stage`, detail: `Produce and save: ${stage.output}.` },
    ],
    prompt: null,
    settings: [
      { label: 'Input', value: stage.input || 'Output of the previous stage' },
      { label: 'Deliverable', value: stage.output || 'The artifact this stage produces' },
    ],
    pitfall: 'Check the output format matches what the next tool expects before moving on.',
    checkpoint: `You have ${stage.output}.`,
  };
}

async function writePlaybook({ goal, stage, position, total, previous, next }) {
  const key = cache.makeKey('playbook', [goal, stage.toolSlug, stage.title, stage.output]);
  const cached = await cache.get(key);
  if (cached) return cached;

  try {
    const { data } = await completeJson({
      task: 'playbook',
      role: 'planner',
      temperature: 0.35,
      // A 4-step playbook with details plus a paste-ready prompt runs well past
      // 900 tokens; too tight a cap truncates the JSON mid-object and the
      // repair pass then salvages a partial, field-missing playbook.
      maxTokens: 2200,
      messages: [
        { role: 'system', content: prompts.playbookSystem() },
        {
          role: 'user',
          content: prompts.playbookUser({ goal, tool: stage.tool, stage, position, total, previous, next }),
        },
      ],
      // Strict enough that a truncated completion is rejected and retried
      // rather than silently accepted as a short playbook.
      validate: v => {
        if (!Array.isArray(v?.steps) || v.steps.length !== 4) return 'Provide exactly 4 steps.';
        if (v.steps.some(s => !s?.title || !s?.detail)) return 'Every step needs both "title" and "detail".';
        if (!v.pitfall) return 'Include a "pitfall".';
        if (!v.checkpoint) return 'Include a "checkpoint".';
        // Every stage has to hand the user something actionable — otherwise
        // the panel renders an empty slot and the stage feels half-written.
        const hasPrompt = typeof v.prompt === 'string' && v.prompt.trim().length > 20;
        const hasSettings = Array.isArray(v.settings) && v.settings.some(s => s?.label && s?.value);
        if (!hasPrompt && !hasSettings) {
          return 'Provide either a paste-ready "prompt" (prompt-driven tools) or 2-4 "settings" entries (UI-driven tools).';
        }
        return null;
      },
    });

    const prompt = typeof data.prompt === 'string' && data.prompt.trim().length > 20
      ? truncate(data.prompt.trim(), 1400)
      : null;

    const playbook = {
      steps: data.steps.slice(0, 4).map(s => ({
        title: truncate(String(s.title).replace(/^\d+[.)]\s*/, ''), 90),
        detail: truncate(String(s.detail || ''), 420),
      })),
      prompt,
      // Only carry settings when there is no prompt, so the UI always has
      // exactly one thing to show and the two can't contradict each other.
      settings: prompt
        ? null
        : (Array.isArray(data.settings) ? data.settings : [])
            .filter(s => s?.label && s?.value)
            .slice(0, 4)
            .map(s => ({
              label: truncate(String(s.label), 60),
              value: truncate(String(s.value), 90),
            })),
      pitfall: truncate(String(data.pitfall || ''), 320),
      checkpoint: truncate(String(data.checkpoint || ''), 320),
    };

    await cache.set(key, playbook);
    return playbook;
  } catch (err) {
    log.warn('Playbook generation failed — using deterministic fallback', {
      tool: stage.toolSlug,
      error: err.message,
    });
    return fallbackPlaybook(stage);
  }
}

/**
 * Playbooks are independent, so they want to run in parallel — but firing one
 * request per stage at once is what trips provider rate limits, and a 429
 * degrades that stage to the generic fallback. A small worker pool keeps most
 * of the latency win while staying under per-key concurrency caps.
 */
const PLAYBOOK_CONCURRENCY = 3;

/**
 * On a refine turn, most stages didn't change — only the ones the adjustment
 * actually touched. Reusing the prior stage's playbook verbatim for anything
 * unchanged means "make it cheaper" costs one planner call plus playbooks for
 * only the swapped/added stages, instead of regenerating all of them.
 *
 * A stage is considered unchanged only if its tool, output AND input (i.e. the
 * previous stage's output too) all match the prior plan at the same position —
 * that transitively guarantees the handoff this playbook was written against
 * hasn't shifted, not just the stage's own fields.
 */
function reusePlaybooksFromPrior(stages, priorWorkflow) {
  const priorStages = priorWorkflow?.stages || [];
  let reused = 0;

  stages.forEach((stage, i) => {
    const prior = priorStages[i];
    if (!prior || !prior.steps?.length) return;
    if (prior.toolSlug !== stage.toolSlug) return;
    if (prior.output !== stage.output) return;
    // Stage 0's input is free text the model restates every call ("Idea:
    // coffee tips" vs "Idea or brief about coffee tips") — cosmetic drift,
    // not a handoff change, since there's no upstream stage to shift under
    // it. From stage 1 on, input is code-derived from the previous stage's
    // output, so an exact match there really does mean the handoff held.
    if (i > 0 && prior.input !== stage.input) return;

    stage.steps = prior.steps;
    stage.prompt = prior.prompt;
    stage.settings = prior.settings;
    stage.pitfall = prior.pitfall;
    stage.checkpoint = prior.checkpoint;
    reused++;
  });

  return reused;
}

async function writeAllPlaybooks(goal, stages, onProgress) {
  // Stages already carrying a playbook (reused from the prior workflow on a
  // refine) skip the queue entirely — no cache lookup, no LLM call.
  const pending = [];
  stages.forEach((stage, i) => {
    if (!(stage.steps && stage.steps.length)) pending.push(i);
  });

  let done = stages.length - pending.length;
  if (done > 0 && pending.length > 0) {
    onProgress({
      phase: 'playbook',
      message: `Reusing ${done} unchanged stage${done === 1 ? '' : 's'}`,
      done,
      total: stages.length,
    });
  }

  const results = new Array(stages.length);
  let cursor = 0;

  async function worker() {
    while (cursor < pending.length) {
      const i = pending[cursor++];
      const stage = stages[i];

      const previous = i > 0
        ? { title: stages[i - 1].title, toolName: stages[i - 1].tool.name, output: stages[i - 1].output }
        : null;
      const next = i < stages.length - 1
        ? { title: stages[i + 1].title, toolName: stages[i + 1].tool.name }
        : null;

      results[i] = await writePlaybook({
        goal, stage, position: i + 1, total: stages.length, previous, next,
      });

      done++;
      onProgress({
        phase: 'playbook',
        message: `Writing steps for ${stage.tool.name}`,
        done,
        total: stages.length,
      });
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(PLAYBOOK_CONCURRENCY, pending.length) }, worker)
  );

  results.forEach((pb, i) => { if (pb) Object.assign(stages[i], pb); });
  return stages;
}

// ─────────────────────────────────────────────────────────────
// Phase 4 — assembly
// ─────────────────────────────────────────────────────────────

function formatDuration(minutes) {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function summariseCost(stages) {
  const counts = { free: 0, freemium: 0, paid: 0, contact: 0 };
  for (const s of stages) counts[s.tool.pricing] = (counts[s.tool.pricing] || 0) + 1;

  if (counts.paid === 0 && counts.contact === 0) {
    return counts.freemium > 0
      ? 'Free to start — every tool has a usable free tier'
      : 'Completely free';
  }
  const paidCount = counts.paid + counts.contact;
  return `${stages.length - paidCount} free/freemium · ${paidCount} paid ${paidCount === 1 ? 'tool' : 'tools'}`;
}

/**
 * The chat message is derived from the plan rather than generated separately,
 * so the prose and the canvas can never disagree with each other.
 */
function composeReply(workflow) {
  const lines = [];

  lines.push(`**${workflow.title}**`);
  if (workflow.summary) lines.push('', workflow.summary);

  lines.push('', `Here's the ${workflow.stages.length}-stage build:`, '');

  workflow.stages.forEach((s, i) => {
    const priceTag = s.tool.pricing === 'free'
      ? 'Free'
      : s.tool.pricing === 'freemium'
        ? 'Freemium'
        : s.tool.pricing === 'paid' ? 'Paid' : 'Contact';
    lines.push(
      `${i + 1}. **${s.title}** — [${s.tool.name}](/tool/${s.tool.slug}) · ${priceTag} · ${formatDuration(s.timeMinutes)}`
    );
    lines.push(`   → ${s.output}`);
  });

  lines.push('', `**You end with:** ${workflow.outcome}`);
  lines.push(`**Total:** ${formatDuration(workflow.totalMinutes)} · ${workflow.costSummary}`);

  if (workflow.tips.length) {
    lines.push('', '**Worth knowing**');
    workflow.tips.forEach(t => lines.push(`- ${t}`));
  }

  lines.push('', 'Click any stage on the canvas for the step-by-step playbook and a ready-to-paste prompt.');

  return lines.join('\n');
}

function assemble(plan, meta) {
  const totalMinutes = plan.stages.reduce((sum, s) => sum + s.timeMinutes, 0);

  const workflow = {
    id: `wf_${crypto.randomBytes(8).toString('hex')}`,
    title: plan.title,
    summary: plan.summary,
    outcome: plan.outcome,
    difficulty: plan.difficulty,
    totalMinutes,
    totalDuration: formatDuration(totalMinutes),
    costSummary: summariseCost(plan.stages),
    stages: plan.stages,
    tips: plan.tips,
    createdAt: new Date().toISOString(),
    meta,
  };

  workflow.reply = composeReply(workflow);
  return workflow;
}

// ─────────────────────────────────────────────────────────────
// Non-workflow intents
// ─────────────────────────────────────────────────────────────

async function answerGrounded({ message, routed, contextMessages, allowExternalTools, userId }) {
  const { cards } = await retrieve({
    queries: routed.searchQueries.length ? routed.searchQueries : [message],
    categories: routed.domains,
    pricing: routed.pricing,
    limit: 14,
  });

  // Bounded, single web search: only when the user has opted in, the tool is
  // configured/within budget, and either the catalog came back thin or the
  // message itself asks for something fresh ("latest", "2026", etc).
  let webResults = null;
  const shouldSearch =
    allowExternalTools && isWebSearchConfigured() && (cards.length < 4 || wantsFreshInfo(message));
  if (shouldSearch) {
    webResults = await webSearch(routed.searchQueries[0] || message);
  }

  const { content } = await complete({
    task: 'answer',
    role: 'planner',
    temperature: 0.4,
    maxTokens: 900,
    messages: [
      { role: 'system', content: prompts.answerSystem(cards, webResults) },
      ...contextMessages.slice(-6),
      { role: 'user', content: fence(message) },
    ],
  });

  const finalMessage = checkOutput(content);

  if (webResults?.length) {
    // Fire-and-forget: never delays the response the user is waiting on.
    discoverAndQueueTools({
      webResults,
      assistantReply: finalMessage,
      sourceQuery: routed.searchQueries[0] || message,
      userId,
    }).catch(() => {});
  }

  return {
    message: finalMessage,
    workflow: null,
    intent: routed.intent,
    toolSlugs: cards.map(c => c.slug).filter(slug => content.includes(slug)),
  };
}

// ─────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────

/**
 * @param {object} input
 * @param {string} input.message
 * @param {object} input.conversation   from memory.loadConversation
 * @param {string} [input.userId]       used to load/update long-term memory (profile + semantic recall)
 * @param {boolean} [input.allowExternalTools] user opt-in for web-search-discovered tools beyond the catalog
 * @param {(event:object)=>void} [input.onProgress]
 * @returns {Promise<{message:string, workflow:object|null, intent:string, title?:string, goal?:string}>}
 */
export async function handleMessage({ message, conversation, userId = null, allowExternalTools = false, onProgress = noop }) {
  const startedAt = Date.now();

  if (!isLLMAvailable()) {
    throw new LLMError(
      'The AI assistant is not configured on this server yet. Add an AI_API_KEY to enable it.',
      { code: 'AI_DISABLED', status: 503 }
    );
  }

  // ── Guardrails ───────────────────────────────────────────
  const { sanitized, flags } = checkInput(message);

  const catalog = await getCatalog();
  if (!catalog.tools.length) {
    throw new LLMError('The tool catalog is empty — run the seeder before using the assistant.', {
      code: 'EMPTY_CATALOG',
      status: 503,
    });
  }

  // ── Long-term memory: structured profile + semantic cross-session recall ──
  const [profile, recalled] = userId
    ? await Promise.all([
        loadProfile(userId).catch(() => null),
        recallRelatedSessions({ userId, sessionId: conversation.sessionId, goal: message }).catch(() => []),
      ])
    : [null, []];

  const resolvedExternalTools = typeof allowExternalTools === 'boolean'
    ? allowExternalTools
    : Boolean(profile?.allowExternalTools);

  const contextMessages = buildContextMessages(conversation, { recalled });
  const priorWorkflow = conversation.lastWorkflow || null;
  const clarifyState = conversation.clarificationState;
  const sessionId = conversation.sessionId || 'default';

  // ── Clarification intake (no planner tokens until user approves) ──
  if (clarifyState?.phase === 'asking' && !priorWorkflow) {
    const enrichedGoal = `${clarifyState.baseGoal || sanitized}\n\nUser preferences:\n${sanitized}`;
    if (userId) {
      await saveClarificationState(userId, sessionId, {
        phase: 'awaiting_approval',
        questions: clarifyState.questions || [],
        answersText: sanitized,
        enrichedGoal,
        baseGoal: clarifyState.baseGoal || sanitized,
      });
    }
    return {
      message:
        `Thanks — here's what I'll plan for:\n\n**${clarifyState.baseGoal || 'Your project'}**\n\n` +
        `${sanitized}\n\n` +
        `When you're ready, hit **Generate workflow** and I'll design the full build plan.`,
      workflow: null,
      intent: 'clarify',
      readyToApprove: true,
      clarifyingQuestions: null,
    };
  }

  let forcedGoal = null;
  if (clarifyState?.phase === 'awaiting_approval' && APPROVAL_RE.test(sanitized)) {
    forcedGoal = clarifyState.enrichedGoal || clarifyState.baseGoal || sanitized;
    if (userId) await clearClarificationState(userId, sessionId);
  }

  // ── Phase 1: route ───────────────────────────────────────
  onProgress({ phase: 'understanding', message: 'Understanding your goal' });

  let routed;
  if (forcedGoal) {
    routed = {
      intent: 'workflow',
      goal: forcedGoal.slice(0, 500),
      title: clarifyState?.baseGoal?.slice(0, 80) || '',
      domains: [],
      searchQueries: [forcedGoal.slice(0, 80)],
      pricing: profile?.pricingPreference || 'any',
      skill: profile?.skillLevel || 'beginner',
      clarifyingQuestions: [],
    };
  } else {
    try {
      routed = await route({
        message: sanitized,
        contextMessages,
        categories: catalog.categories,
        hasPriorWorkflow: Boolean(priorWorkflow),
        profile,
      });
    } catch (err) {
      log.warn('Router failed — falling back to heuristics', { error: err.message });
      routed = heuristicRoute(sanitized, Boolean(priorWorkflow), profile);
    }
  }

  if (flags.includes('possible_injection')) {
    // A message that tries to reprogram the assistant is never a build request.
    routed.intent = routed.intent === 'workflow' ? 'discover' : routed.intent;
  }

  log.info('Routed message', {
    intent: routed.intent,
    pricing: routed.pricing,
    domains: routed.domains.join(','),
  });

  // ── Cheap intents ────────────────────────────────────────
  if (routed.intent === 'smalltalk') {
    return { message: prompts.smalltalkReply(), workflow: null, intent: 'smalltalk' };
  }

  if (routed.clarifyingQuestions.length && routed.intent === 'workflow' && !priorWorkflow) {
    if (userId) {
      incrementClarifyingQuestionsAsked(userId).catch(() => {});
      saveClarificationState(userId, sessionId, {
        phase: 'asking',
        questions: routed.clarifyingQuestions,
        answersText: '',
        enrichedGoal: '',
        baseGoal: routed.goal,
      }).catch(() => {});
    }
    return {
      message: 'Before I design your workflow, a few quick questions:',
      workflow: null,
      intent: 'clarify',
      clarifyingQuestions: routed.clarifyingQuestions,
    };
  }

  if (routed.intent === 'discover' || routed.intent === 'question') {
    onProgress({ phase: 'searching', message: `Searching ${catalog.tools.length} tools` });
    return answerGrounded({ message: sanitized, routed, contextMessages, allowExternalTools: resolvedExternalTools, userId });
  }

  // ── Workflow / refine ────────────────────────────────────
  const isRefine = routed.intent === 'refine' && priorWorkflow;

  const cacheKey = cache.makeKey('workflow', [
    routed.goal,
    routed.pricing,
    routed.skill,
    catalog.tools.length,
    isRefine ? priorWorkflow.id : 'fresh',
  ]);

  if (!isRefine) {
    const hit = await cache.get(cacheKey);
    if (hit) {
      log.info('Workflow served from cache', { goal: routed.goal.slice(0, 60) });
      return {
        message: hit.reply,
        workflow: { ...hit, meta: { ...hit.meta, cached: true } },
        intent: routed.intent,
        title: hit.title,
        goal: routed.goal,
      };
    }
  }

  onProgress({
    phase: 'searching',
    message: `Matching ${catalog.tools.length} tools to your goal`,
  });

  const { cards, corpusSize } = await retrieve({
    queries: routed.searchQueries.length ? routed.searchQueries : [routed.goal],
    categories: routed.domains,
    pricing: routed.pricing,
    limit: config.ai.retrievalCandidates,
  });

  if (!cards.length) {
    return {
      message:
        "I couldn't find tools in our catalog that match that goal. Try describing it differently, " +
        'or browse the categories to see what we cover.',
      workflow: null,
      intent: routed.intent,
    };
  }

  onProgress({ phase: 'planning', message: 'Designing the workflow' });

  const { raw, model } = await plan({
    goal: routed.goal,
    cards,
    pricing: routed.pricing,
    skill: routed.skill,
    priorWorkflow: isRefine ? priorWorkflow : null,
    adjustment: isRefine ? sanitized : null,
    profile,
  });

  const bySlug = new Map(cards.map(c => [c.slug, catalog.bySlug.get(c.slug)]).filter(([, t]) => t));
  const normalized = normalizePlan(raw, { bySlug, goal: routed.goal, title: routed.title });

  if (normalized.stages.length < 2) {
    log.warn('Plan collapsed after validation', { stages: normalized.stages.length });
    return answerGrounded({ message: sanitized, routed, contextMessages, allowExternalTools: resolvedExternalTools, userId });
  }

  const reusedCount = isRefine ? reusePlaybooksFromPrior(normalized.stages, priorWorkflow) : 0;

  onProgress({
    phase: 'playbook',
    message: reusedCount ? 'Updating the changed stages' : 'Writing step-by-step playbooks',
    done: reusedCount,
    total: normalized.stages.length,
  });

  await writeAllPlaybooks(routed.goal, normalized.stages, onProgress);

  let workflow = assemble(normalized, {
    model,
    corpusSize,
    candidatesConsidered: cards.length,
    pricing: routed.pricing,
    skill: routed.skill,
    ms: Date.now() - startedAt,
    cached: false,
    reusedStages: reusedCount,
  });

  let workflowDiff = null;
  if (isRefine && priorWorkflow) {
    const patched = patchWorkflow(priorWorkflow, workflow, { adjustment: sanitized });
    workflow = patched.workflow;
    workflowDiff = patched.diff;
    workflow.reply = composeReply(workflow);
  }

  if (!isRefine) await cache.set(cacheKey, workflow);

  onProgress({ phase: 'done', message: 'Workflow ready' });

  log.info('Workflow generated', {
    stages: workflow.stages.length,
    reused: reusedCount,
    minutes: workflow.totalMinutes,
    ms: workflow.meta.ms,
  });

  return {
    message: workflow.reply,
    workflow,
    workflowDiff,
    intent: routed.intent,
    title: workflow.title,
    goal: routed.goal,
    toolSlugs: workflow.stages.map(s => s.toolSlug),
  };
}

/**
 * Regenerate one stage's playbook on demand (the "deep dive" a user gets when
 * they open a stage and want more than the four headline steps).
 */
export async function deepDive({ goal, workflow, stageId }) {
  const stages = workflow?.stages || [];
  const index = stages.findIndex(s => s.id === stageId || s.toolSlug === stageId);
  if (index === -1) throw new GuardrailError('Unknown stage.', { code: 'NOT_FOUND', status: 404 });

  const stage = stages[index];
  const previous = index > 0
    ? { title: stages[index - 1].title, toolName: stages[index - 1].tool.name, output: stages[index - 1].output }
    : null;
  const next = index < stages.length - 1
    ? { title: stages[index + 1].title, toolName: stages[index + 1].tool.name }
    : null;

  return writePlaybook({
    goal: goal || workflow.title,
    stage,
    position: index + 1,
    total: stages.length,
    previous,
    next,
  });
}

/**
 * Best-effort, fire-and-forget growth of long-term memory from a completed
 * turn. Never awaited on the request path — a slow or failed extraction must
 * never delay or break the user's response, so callers should call this
 * without `await` and let it land in the background.
 */
export async function updateProfileFromTurn({ userId, userMessage, assistantMessage, intent }) {
  if (!userId || !isLLMAvailable()) return;
  if (!['workflow', 'refine', 'discover', 'question'].includes(intent)) return;

  try {
    const { data } = await completeJson({
      task: 'profile:extract',
      role: 'fast',
      temperature: 0.1,
      maxTokens: 300,
      messages: [
        { role: 'system', content: prompts.profileExtractionSystem() },
        { role: 'user', content: prompts.profileExtractionUser({ userMessage, assistantMessage }) },
      ],
      validate: v => (!v || typeof v !== 'object' ? 'Response must be a JSON object.' : null),
    });

    const facts = {};
    if (data.skillLevel) facts.skillLevel = data.skillLevel;
    if (data.pricingPreference) facts.pricingPreference = data.pricingPreference;
    if (data.industry) facts.industry = data.industry;
    if (Array.isArray(data.toolsAlreadyUsing) && data.toolsAlreadyUsing.length) {
      facts.toolsAlreadyUsing = data.toolsAlreadyUsing;
    }
    if (data.note) facts.note = data.note;

    if (Object.keys(facts).length) await updateProfileFacts(userId, facts);
  } catch (err) {
    log.debug('Profile extraction skipped', { error: err.message });
  }
}

export default { handleMessage, deepDive, updateProfileFromTurn };
