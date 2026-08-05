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
  recordIntakeAsk,
  recallRelatedSessions,
  saveClarificationState,
  clearClarificationState,
} from './memory.js';
import cache from './cache.js';
import { planAllows } from '../billing/plans.js';
import {
  profileFingerprint,
  retrievalSignals,
  hasExhaustedIntake,
  expandIntakeAnswers,
  factsFromIntakeAnswers,
  GENERAL_DOMAIN,
} from './personalization.js';
import * as prompts from './prompts.js';
import { patchWorkflow, resolveStageMatches } from './workflowDiff.js';
import { webSearch, isWebSearchConfigured, wantsFreshInfo } from './tools/webSearch.js';
import { discoverAndQueueTools } from './tools/toolDiscovery.js';
import { foreignToolNames } from './toolNames.js';
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

/** How many times we'll interrupt a returning user with intake, per domain. */
const MAX_CLARIFYING_ASKS = 3;

/** Intake length, enforced identically by the router prompt and both builders. */
const MAX_INTAKE_QUESTIONS = 5;

const APPROVAL_RE = /\b(yes|create the workflow|generate the workflow|build it|go ahead|approve|looks good|let'?s do it|start planning|make the workflow|design the workflow)\b/i;

function sanitizeClarifyingQuestions(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter(q => q && q.question)
    .slice(0, MAX_INTAKE_QUESTIONS)
    .map((q, i) => ({
      id: String(q.id || `q${i}`).slice(0, 40),
      question: String(q.question).slice(0, 160),
      type: q.type === 'text' ? 'text' : 'choice',
      options: Array.isArray(q.options)
        ? q.options.map(o => String(o).slice(0, 60)).slice(0, 6)
        : undefined,
    }));
}

/** Drop questions whose answers are already on the standing profile. */
function stripKnownProfileQuestions(questions, profile) {
  return (questions || []).filter(q => {
    if (q.id === 'budget' && profile?.pricingPreference) return false;
    if (q.id === 'skill' && profile?.skillLevel) return false;
    return Boolean(q?.id && q?.question);
  });
}

function dedupeQuestions(questions) {
  const seen = new Set();
  return questions.filter(q => {
    if (!q?.id || seen.has(q.id)) return false;
    seen.add(q.id);
    return true;
  }).slice(0, MAX_INTAKE_QUESTIONS);
}

/**
 * Last-resort generic intake when every LLM pass failed.
 * Not goal-aware — prefer `inventIntakeQuestions` whenever possible.
 */
function buildDefaultIntakeQuestions(profile) {
  const questions = [];

  if (!profile?.pricingPreference) {
    questions.push({
      id: 'budget',
      question: 'What is your budget for tools?',
      type: 'choice',
      options: ['Free only', 'Freemium is OK', 'Paid tools are fine'],
    });
  }

  if (!profile?.skillLevel) {
    questions.push({
      id: 'skill',
      question: 'What is your experience level?',
      type: 'choice',
      options: ['Beginner', 'Intermediate', 'Advanced'],
    });
  }

  questions.push({
    id: 'timeline',
    question: 'How quickly do you need this done?',
    type: 'choice',
    options: ['Today', 'This week', 'No rush'],
  });

  questions.push({
    id: 'approach',
    question: 'How hands-on do you want to be?',
    type: 'choice',
    options: ['Mostly AI-automated', 'Mix of AI and manual', 'I want full control'],
  });

  questions.push({
    id: 'priority',
    question: 'What matters most for this build?',
    type: 'choice',
    options: ['Speed', 'Quality', 'Lowest cost', 'Learning as I go'],
  });

  return stripKnownProfileQuestions(questions, profile).slice(0, MAX_INTAKE_QUESTIONS);
}

/** Standing profile facts the planner can treat as known without re-asking. */
function profileKnownLines(profile) {
  if (!profile) return [];
  const lines = [];
  if (profile.skillLevel) lines.push(`Skill level: ${profile.skillLevel}`);
  if (profile.pricingPreference) lines.push(`Budget preference: ${profile.pricingPreference}`);
  if (profile.industry) lines.push(`Industry: ${profile.industry}`);
  if (profile.toolsAlreadyUsing?.length) {
    lines.push(`Already uses: ${profile.toolsAlreadyUsing.slice(0, 6).join(', ')}`);
  }
  return lines.slice(0, 8);
}

function sanitizeBriefingLines(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map(line => String(line || '').trim().slice(0, 160))
    .filter(Boolean)
    .slice(0, 8);
}

/**
 * Ask the model: what do I already know, what do I still need, then invent
 * questions only for the gaps. Not a static questionnaire.
 */
async function inventIntakeQuestions({ goal, message, profile }) {
  const { data } = await completeJson({
    task: 'route:intake',
    role: 'fast',
    temperature: 0.2,
    maxTokens: 2500,
    messages: [
      { role: 'system', content: prompts.intakeQuestionsSystem(profile) },
      {
        role: 'user',
        content:
          `Goal: ${String(goal || message).slice(0, 500)}\n` +
          `User message: ${fence(String(message || '').slice(0, 800))}\n\n` +
          'List alreadyKnow and stillNeed, then invent clarifyingQuestions only for stillNeed. ' +
          'If stillNeed is empty, return clarifyingQuestions: [].',
      },
    ],
    validate: v => {
      if (!v || typeof v !== 'object') return 'Response must be a JSON object.';
      if (!Array.isArray(v.clarifyingQuestions)) {
        return '"clarifyingQuestions" must be an array (empty if nothing left to ask).';
      }
      if (v.clarifyingQuestions.length > 0 && v.clarifyingQuestions.length < 2) {
        return 'Ask at least 2 clarifyingQuestions, or return an empty array.';
      }
      return null;
    },
  });

  return {
    questions: sanitizeClarifyingQuestions(data.clarifyingQuestions),
    alreadyKnow: sanitizeBriefingLines(data.alreadyKnow),
    stillNeed: sanitizeBriefingLines(data.stillNeed),
  };
}

/**
 * Resolve intake for a new workflow.
 *
 * Always runs an invent pass so the model explicitly separates already-known
 * facts from still-needed decisions — even when the router already proposed
 * questions. Returns `{ questions, alreadyKnow, stillNeed }`.
 */
async function resolveIntakeQuestions({ routed, profile, message }) {
  const fromRouter = stripKnownProfileQuestions(
    routed.clarifyingQuestions?.length ? routed.clarifyingQuestions : [],
    profile
  );
  const knownFromProfile = profileKnownLines(profile);

  try {
    const invented = await inventIntakeQuestions({
      goal: routed.goal,
      message,
      profile,
    });
    let questions = stripKnownProfileQuestions(invented.questions, profile);

    // Prefer invent (it reasoned about gaps). Fall back to router questions if
    // invent returned nothing usable but the router had asks.
    if (questions.length < 2 && fromRouter.length >= 2) {
      questions = fromRouter;
    }
    if (!questions.length && !invented.stillNeed.length) {
      // Model says nothing left to ask — that is valid; approval still required.
      return {
        questions: [],
        alreadyKnow: invented.alreadyKnow.length ? invented.alreadyKnow : knownFromProfile,
        stillNeed: [],
      };
    }
    if (questions.length < 2) {
      questions = dedupeQuestions(buildDefaultIntakeQuestions(profile));
    }

    log.info('Intake briefing ready', {
      questions: questions.length,
      alreadyKnow: (invented.alreadyKnow.length ? invented.alreadyKnow : knownFromProfile).length,
      stillNeed: invented.stillNeed.length,
    });

    return {
      questions: dedupeQuestions(questions),
      alreadyKnow: invented.alreadyKnow.length ? invented.alreadyKnow : knownFromProfile,
      stillNeed: invented.stillNeed.length
        ? invented.stillNeed
        : questions.map(q => q.question),
    };
  } catch (err) {
    log.warn('Intake invent pass failed — using router/generic questions', { error: err.message });
    const questions = dedupeQuestions(
      fromRouter.length >= 2 ? fromRouter : buildDefaultIntakeQuestions(profile)
    );
    return {
      questions,
      alreadyKnow: knownFromProfile,
      stillNeed: questions.map(q => q.question),
    };
  }
}

function formatApprovalMessage({ baseGoal, preferencesText, alreadyKnow, stillNeed }) {
  const parts = [
    `Thanks — here's what I'll plan for:\n\n**${baseGoal || 'Your project'}**`,
  ];
  if (alreadyKnow?.length) {
    parts.push(`\n\n**Already know**\n${alreadyKnow.map(l => `- ${l}`).join('\n')}`);
  }
  if (preferencesText) {
    parts.push(`\n\n**Your answers**\n${preferencesText}`);
  }
  if (stillNeed?.length && !preferencesText) {
    parts.push(`\n\n**Still open**\n${stillNeed.map(l => `- ${l}`).join('\n')}`);
  }
  parts.push(
    '\n\nIf you want anything else factored in — constraints, tools you already use, ' +
    'or a detail I missed — add it below, then approve and I\'ll design the full build plan.'
  );
  return parts.join('');
}

const EXTRA_NOTES_RE = /Additional notes from the user:\s*([\s\S]+)/i;

async function route({ message, contextMessages, categories, hasPriorWorkflow, profile, requireQuestions = false }) {
  const { data } = await completeJson({
    task: 'route',
    role: 'fast',
    temperature: 0.1,
    // A full route response — goal, title, domains, search queries, plus up to
    // 5 clarifying questions each carrying options — comfortably exceeds the
    // 700-token budget this used to run on, which meant the JSON silently
    // truncated right where clarifyingQuestions lives (the last field) and
    // every first-time ask fell back to the same five generic questions.
    //
    // Sized again for the `fast` tier being a reasoning model: it spends the
    // allowance on hidden reasoning tokens before writing anything, so the
    // budget has to cover the thinking as well as the answer. `completeJson`
    // recovers when it doesn't, but that recovery costs an entire extra call.
    maxTokens: 3000,
    messages: [
      { role: 'system', content: prompts.routerSystem(categories, profile) },
      ...contextMessages.slice(-4),
      {
        role: 'user',
        content:
          fence(message) +
          (hasPriorWorkflow
            ? '\n\nNote: a workflow already exists in this conversation, so a request to CHANGE the ' +
              'plan (swap a tool, add or drop a stage, make it cheaper) is "refine". A request to ' +
              'UNDERSTAND or CARRY OUT a stage that is already in the plan ("how do I do this step", ' +
              '"what do I click first", "explain stage 3") is "question" — the plan itself is not ' +
              'being changed, and rebuilding it would replace work the user did not ask you to touch.'
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
      // A brand-new workflow ask needs real intake. Profile richness only means
      // budget/skill can be omitted — not that the whole array may be empty.
      // Goal-specific questions (platform, catalog, audience) must still run;
      // otherwise a returning app-builders user never gets asked about a new
      // ecommerce goal. The engine fills a fallback pack if the model still
      // returns [], but forcing one repair pass keeps questions on-goal.
      if (
        requireQuestions &&
        v.intent === 'workflow' &&
        !hasPriorWorkflow &&
        !(Array.isArray(v.clarifyingQuestions) && v.clarifyingQuestions.length >= 2)
      ) {
        return '"clarifyingQuestions" must contain 2-5 questions specific to this goal ' +
          '(budget/skill may be omitted when the profile already has them).';
      }
      return null;
    },
  });

  const validCategories = new Set(categories);

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
    // Whether to actually ask these is decided by the caller, which knows the
    // routed domain and so can throttle per-domain rather than globally.
    clarifyingQuestions: sanitizeClarifyingQuestions(data.clarifyingQuestions),
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

/**
 * A stage's binding, whichever form it took.
 *
 * When the model names an EXTERNAL_CANDIDATES product but drops or invents the
 * URL, fill the verified URL from the offered map — that is the whole point of
 * only allowing names we searched for.
 *
 * @param {object} stage
 * @param {Map<string, {name:string,url:string,pricing?:string,tagline?:string}>|null} [offeredExternal]
 * @returns {{name:string,url:string,pricing?:string,tagline?:string}|null}
 */
function externalBindingOf(stage, offeredExternal = null) {
  const ext = stage?.externalTool;
  if (!ext || typeof ext !== 'object') return null;
  const name = String(ext.name || '').trim();
  if (!name) return null;

  const offered = offeredExternal?.get(name.toLowerCase()) || null;
  const url = String(ext.url || offered?.url || '').trim();
  if (!url) return null;

  return {
    name: offered?.name || name,
    url,
    pricing: ['free', 'freemium', 'paid', 'contact'].includes(ext.pricing)
      ? ext.pricing
      : (offered?.pricing || 'freemium'),
    tagline: String(ext.tagline || offered?.tagline || '').slice(0, 160),
  };
}

async function plan({
  goal,
  cards,
  pricing,
  skill,
  priorWorkflow,
  adjustment,
  profile,
  allowExternalTools = false,
  externalCandidates = null,
  brief = '',
}) {
  const validSlugs = new Set(cards.map(c => c.slug));
  const { minStages, maxStages } = config.ai;

  // Only URLs we actually put in front of the model may come back out of it —
  // otherwise "external tools" becomes a licence to invent a product and a
  // link, which is a worse failure than the catalog gap it was meant to solve.
  const offeredExternal = new Map(
    (externalCandidates || []).map(c => [String(c.name).toLowerCase(), c])
  );

  const catalogNames = cards.map(c => c.name);

  /**
   * The prose/binding check refuses once, then lets the plan through.
   *
   * Structural errors (an unknown slug, a missing output) must refuse every
   * time — a plan that fails them is unusable. A stage whose wording drifted is
   * a judgement call: the graph is sound and only the copy is wrong. Refusing
   * it a second time throws away a plan the user already paid for and returns
   * them an error, which is a worse outcome than a slightly-off sentence that
   * `normalizePlan` then cleans up. Same principle the architect's `finish`
   * gate uses, and for the same reason.
   */
  let proseCheckAttempts = 0;

  const { data, model } = await completeJson({
    task: 'plan',
    // The stage/tool graph has to be right — a wrong tool here isn't a worse
    // sentence, it's the harness fix this file exists for. Same tier as the
    // architect/agent node, and for the same reason: no silent fallback to a
    // weaker model.
    role: 'reasoning',
    temperature: 0.4,
    // Headroom for the upper bound of stages, each carrying why/input/output
    // plus the closing tips array — a truncated plan loses whole stages.
    maxTokens: 3600,
    messages: [
      {
        role: 'system',
        content: prompts.plannerSystem({ minStages, maxStages, pricing, skill, profile, allowExternalTools }),
      },
      {
        role: 'user',
        content: prompts.plannerUser({
          goal, candidates: cards, priorWorkflow, adjustment, externalCandidates, brief,
        }),
      },
    ],
    validate: v => {
      if (!v || !Array.isArray(v.stages)) return '"stages" must be an array.';
      if (v.stages.length < 2) return `Provide at least ${minStages} stages.`;

      const missing = v.stages.find(s => !s.title || !s.output);
      if (missing) return 'Every stage needs a non-empty "title" and "output".';

      // ── Binding: a catalog slug, or an offered external tool ──
      const badSlugs = [];
      const badExternal = [];

      for (const stage of v.stages) {
        const ext = externalBindingOf(stage, offeredExternal);
        if (ext) {
          if (!allowExternalTools) {
            badExternal.push(`${ext.name} (external tools are not enabled for this user)`);
          } else if (!offeredExternal.has(String(ext.name).toLowerCase())) {
            badExternal.push(`${ext.name} (not in EXTERNAL_CANDIDATES)`);
          }
          continue;
        }

        const slug = stage.toolSlug;
        // Null/empty slug is what the prompt asks for on external stages. When
        // the externalTool object is missing or incomplete, say that clearly —
        // otherwise the repair loop sees "CANDIDATE_TOOLS: ." and cannot fix it.
        if (slug == null || slug === '') {
          const attempted = stage.externalTool?.name
            ? `"${stage.externalTool.name}" (copy name+url from EXTERNAL_CANDIDATES into externalTool, and set toolSlug to null)`
            : '(null toolSlug with no externalTool — bind a CANDIDATE_TOOLS slug, or an EXTERNAL_CANDIDATES entry)';
          badSlugs.push(attempted);
          continue;
        }
        if (!validSlugs.has(slug)) badSlugs.push(slug);
      }

      if (badSlugs.length) {
        return `These toolSlug values are not in CANDIDATE_TOOLS: ${[...new Set(badSlugs)].join(', ')}. ` +
          `Use only slugs copied exactly from the candidate list${
            allowExternalTools ? ', or bind the stage to an EXTERNAL_CANDIDATES entry' : ''
          }.`;
      }
      if (badExternal.length) {
        return `These external tools cannot be used: ${[...new Set(badExternal)].join('; ')}. ` +
          `Bind the stage to a CANDIDATE_TOOLS slug instead, and record the shortfall in "gaps".`;
      }

      // ── Prose must agree with the binding ──
      // The failure this catches: the planner wanted a tool it could not bind,
      // the binding was corrected, and every word describing the stage still
      // named the tool that was rejected.
      if (proseCheckAttempts++ >= 1) return null;

      /**
       * Every tool this plan legitimately talks about.
       *
       * Crucially that includes tools bound to *other* stages: the plan is a
       * chain, and "export an app-icon-ready square for the FlutterFlow build"
       * on a Looka stage is the handoff guidance the whole design exists to
       * give. Only a tool bound to no stage at all is a contradiction — which
       * is exactly the Glide case, where the named tool appeared nowhere in
       * the plan except in the words describing a stage bound to something
       * else.
       */
      const declared = [
        ...v.stages.map(s => {
          const ext = externalBindingOf(s, offeredExternal);
          return ext ? ext.name : cards.find(c => c.slug === s.toolSlug)?.name;
        }).filter(Boolean),
        ...(Array.isArray(v.gaps) ? v.gaps.map(g => g?.suggestedTool).filter(Boolean) : []),
      ];

      for (const [i, stage] of v.stages.entries()) {
        const ext = externalBindingOf(stage, offeredExternal);
        const boundName = ext ? ext.name : (cards.find(c => c.slug === stage.toolSlug)?.name || stage.toolSlug);

        const foreign = foreignToolNames(`${stage.title} — ${stage.why || ''}`, boundName, {
          catalogNames,
          allowed: declared,
        });

        if (foreign.length) {
          return `Stage ${i + 1} is bound to "${boundName}" but its title or "why" describes ` +
            `${[...new Set(foreign)].join(', ')}. A stage may only name the tool it uses — ` +
            `either bind the stage to that tool, or rewrite the title and "why" to describe ` +
            `"${boundName}" and move the shortfall into "gaps".`;
        }
      }

      return null;
    },
  });

  return { raw: data, model };
}

/**
 * Normalise the plan against the catalog: drop unknown slugs, collapse
 * accidental duplicates, clamp the stage count, and backfill anything thin.
 */
/**
 * A stage bound to a product that isn't in our catalog.
 *
 * Shaped like a catalog tool so every consumer — the canvas, the playbook
 * writer, the exporters — keeps working without a branch. `external: true` is
 * what stops it being linked as `/tool/<slug>`: there is no tool page to link
 * to, and a dead link on a plan is worse than a plain name.
 */
function hydrateExternalTool(ext) {
  return {
    slug: null,
    external: true,
    name: String(ext.name).slice(0, 60),
    tagline: truncate(String(ext.tagline || ext.why || ''), 140),
    websiteUrl: String(ext.url).slice(0, 300),
    logo: null,
    category: 'other',
    pricing: ['free', 'freemium', 'paid', 'contact'].includes(ext.pricing) ? ext.pricing : 'freemium',
    features: [],
    tags: [],
  };
}

/**
 * Strip a trailing parenthetical that names a tool this stage is not bound to.
 *
 * The last line of defence, for the case the repair round-trip did not fix.
 * "Build the App (Glide — Mobile-First, No-Code)" on a stage bound to Lovable
 * becomes "Build the App": less informative, but true. A title that names the
 * wrong tool sits directly above that tool's real name, logo and link, and a
 * visible contradiction costs more trust than a shorter title costs clarity.
 */
function stripForeignParenthetical(title, boundName, catalogNames) {
  const match = String(title).match(/^(.*?)\s*[([][^)\]]*[)\]]\s*$/);
  if (!match) return title;

  const inside = String(title).slice(match[1].length);
  const foreign = foreignToolNames(inside, boundName, { catalogNames });
  if (!foreign.length) return title;

  const stripped = match[1].trim();
  return stripped.length >= 8 ? stripped : title;
}

function normalizePlan(raw, { bySlug, goal, title, catalogNames = [], externalCandidates = null }) {
  const offeredExternal = new Map(
    (externalCandidates || []).map(c => [String(c.name).toLowerCase(), c])
  );
  const seen = new Set();
  const stages = [];

  for (const stage of raw.stages || []) {
    const ext = externalBindingOf(stage, offeredExternal);
    const tool = ext ? hydrateExternalTool(ext) : bySlug.get(stage.toolSlug);
    if (!tool) continue;

    // Identity for dedupe: a slug for catalog tools, the name for external ones.
    const key = tool.slug || `ext:${tool.name.toLowerCase()}`;

    // The planner occasionally reuses a tool for consecutive stages; merging
    // them reads better than showing the same node twice in a row.
    if (seen.has(key) && (stages.at(-1)?.toolSlug || `ext:${stages.at(-1)?.tool.name.toLowerCase()}`) === key) {
      const prev = stages.at(-1);
      prev.title = `${prev.title} & ${stage.title}`;
      prev.output = stage.output || prev.output;
      prev.timeMinutes += Number(stage.timeMinutes) || 15;
      continue;
    }
    seen.add(key);

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
      title: stripForeignParenthetical(String(stage.title).slice(0, 80), tool.name, catalogNames),
      toolSlug: tool.slug,
      tool,
      // `truncate` rather than `slice`: a hard cut lands mid-word and ships
      // text like "…kept off the stage list since it on" to the user.
      why: truncate(String(stage.why || `${tool.name} handles this stage.`), 300),
      input: truncate(String(stage.input || ''), 300),
      output: truncate(String(stage.output || ''), 300),
      timeMinutes: Math.min(240, Math.max(5, Number(stage.timeMinutes) || 20)),
      alternatives,
      // Filled in by the playbook phase.
      steps: [],
      prompt: null,
      settings: null,
      pitfall: '',
      checkpoint: '',
      degraded: false,
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
    summary: truncate(String(raw.summary || ''), 500),
    outcome: truncate(String(raw.outcome || stages.at(-1)?.output || ''), 300),
    difficulty: ['beginner', 'intermediate', 'advanced'].includes(raw.difficulty)
      ? raw.difficulty
      : 'beginner',
    stages,
    tips: (Array.isArray(raw.tips) ? raw.tips : [])
      .map(t => truncate(String(t), 240))
      .filter(Boolean)
      .slice(0, 4),
    /**
     * What the plan could not properly serve. Kept as structured data rather
     * than a sentence in the summary, so the reply, the canvas and the eval
     * harness all read the same thing — and so "we have no tool for this" is
     * something the product can say out loud instead of a stage quietly
     * overstating what it delivers.
     */
    gaps: (Array.isArray(raw.gaps) ? raw.gaps : [])
      .filter(g => g?.capability)
      .slice(0, 3)
      .map(g => ({
        capability: truncate(String(g.capability), 120),
        reason: truncate(String(g.reason || ''), 200),
        closestSlug: bySlug.has(g.closestSlug) ? g.closestSlug : null,
        suggestedTool: g.suggestedTool ? String(g.suggestedTool).slice(0, 60) : null,
      })),
    followUp: truncate(String(raw.followUp || ''), 220),
  };
}

// ─────────────────────────────────────────────────────────────
// Phase 3 — playbooks, generated in parallel
// ─────────────────────────────────────────────────────────────

/**
 * Deterministic fallback so a stage is never blank if one call fails.
 *
 * Marked `degraded` — that flag is the whole point. Without it this template
 * was indistinguishable from a written playbook: it rendered the same, was
 * charged the same, and `patchWorkflow` preserved it across every later refine
 * because "has steps" was the only test. Two of five stages in one real
 * conversation shipped this, and nothing anywhere said so.
 *
 * It also deliberately does NOT use `stage.why` as step content. `why` is the
 * planner's rationale for choosing the tool, not an instruction, and when the
 * planner wrote something odd there it was this fallback that promoted it into
 * a numbered step the user was told to follow.
 */
function fallbackPlaybook(stage) {
  const name = stage.tool.name;

  // Deliberately not a fake how-to. The previous template read like a real
  // playbook ("Bring in what the last stage produced…") and users followed it
  // thinking the model wrote it — while logs said the provider was out of
  // credit. Keep four slots so the UI layout holds, but make every line say
  // the instructions are missing.
  return {
    degraded: true,
    steps: [
      {
        title: 'Instructions unavailable',
        detail: `We could not generate the step-by-step playbook for ${name} just now (AI provider error). Hit Regenerate on this stage.`,
      },
      {
        title: 'What this stage needs',
        detail: stage.input
          ? `Input for this stage: ${stage.input}`
          : 'Use the output of the previous stage as your starting point.',
      },
      {
        title: 'What to produce',
        detail: stage.output
          ? `Deliverable: ${stage.output}`
          : `Open ${name} and produce the artifact this stage is responsible for.`,
      },
      {
        title: 'Next action',
        detail: `Regenerate this playbook when the AI service is healthy, or work directly in ${name}.`,
      },
    ],
    prompt: null,
    settings: [
      { label: 'Input', value: stage.input || 'Output of the previous stage' },
      { label: 'Deliverable', value: stage.output || 'The artifact this stage produces' },
    ],
    pitfall: 'These are placeholder steps — do not treat them as a full playbook. Regenerate this stage.',
    checkpoint: stage.output ? `You have ${stage.output}.` : `Stage in ${name} is complete.`,
  };
}

async function writePlaybook({ goal, stage, position, total, previous, next, forceRefresh = false }) {
  const key = cache.makeKey('playbook', [goal, stage.toolSlug, stage.title, stage.output]);

  // A deep-dive regeneration is the user explicitly asking for something
  // different from what they already saw — serving the cached entry back
  // made the "Regenerate" button a no-op. Skip the read but still write the
  // fresh result below, so reuse-on-refine and other callers stay current.
  if (!forceRefresh) {
    const cached = await cache.get(key);
    if (cached) return cached;
  }

  try {
    const { data } = await completeJson({
      task: 'playbook',
      role: 'planner',
      /**
       * Longer than the shared chat ceiling. A playbook is four steps of real
       * operating instruction plus a paste-ready prompt, three of them run
       * concurrently, and the general `AI_TIMEOUT_MS` (45s in production) was
       * cutting them off — which did not surface as an error, it surfaced as a
       * stage silently shipping the template. The failure was invisible
       * precisely because the fallback was good enough to render.
       */
      timeoutMs: Math.max(config.ai.timeoutMs, 90_000),
      // A touch more variation on a regeneration — the deterministic best
      // guess is exactly what the user just asked to move away from.
      temperature: forceRefresh ? 0.55 : 0.35,
      // A 4-step playbook with details plus a paste-ready prompt runs well past
      // 900 tokens; too tight a cap truncates the JSON mid-object and the
      // repair pass then salvages a partial, field-missing playbook.
      maxTokens: 2200,
      messages: [
        { role: 'system', content: prompts.playbookSystem() },
        {
          role: 'user',
          content: prompts.playbookUser({
            goal, tool: stage.tool, stage, position, total, previous, next, regenerate: forceRefresh,
          }),
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
      degraded: false,
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
 * previous stage's output too) all match the prior stage it continues — that
 * transitively guarantees the handoff this playbook was written against hasn't
 * shifted, not just the stage's own fields.
 *
 * "The prior stage it continues" comes from `resolveStageMatches`, the same
 * resolution `patchWorkflow` uses to assign stage ids. Deciding it here a
 * second way — by array index, as this used to — meant an insert or a reorder
 * could copy one stage's playbook onto a stage that then inherited a different
 * stage's identity.
 */
function reusePlaybooksFromPrior(stages, priorWorkflow, adjustment = '') {
  const priorStages = priorWorkflow?.stages || [];
  const matches = resolveStageMatches(priorStages, stages, adjustment);
  let reused = 0;

  stages.forEach((stage, i) => {
    const prior = matches[i];
    if (!prior || !prior.steps?.length) return;
    // Never carry a failed generation forward — that is the one case where
    // regenerating is exactly what the user needs.
    if (prior.degraded) return;
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
    stage.degraded = false;
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
        // Carried so the canvas can fill this node in as it lands, rather than
        // waiting for every other stage to finish first.
        stageId: stage.id,
        stage: { ...stage, ...results[i] },
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
    // An external tool has no tool page, so it gets its own site as a plain
    // link and is labelled as unverified — the same rule the grounded-answer
    // prompt already states for web-sourced tools.
    const toolRef = s.tool.external
      ? `[${s.tool.name}](${s.tool.websiteUrl}) *(beyond our catalog)*`
      : `[${s.tool.name}](/tool/${s.tool.slug})`;
    lines.push(
      `${i + 1}. **${s.title}** — ${toolRef} · ${priceTag} · ${formatDuration(s.timeMinutes)}`
    );
    lines.push(`   → ${s.output}`);
  });

  lines.push('', `**You end with:** ${workflow.outcome}`);
  lines.push(`**Total:** ${formatDuration(workflow.totalMinutes)} · ${workflow.costSummary}`);

  // Said plainly and early, because the alternative — which is what used to
  // happen — is a stage that describes a capability it cannot actually deliver.
  if (workflow.gaps?.length) {
    lines.push('', '**What this plan does not cover**');
    workflow.gaps.forEach(g => {
      const closest = g.closestSlug ? ` Closest in our catalog: [${g.closestSlug}](/tool/${g.closestSlug}).` : '';
      const suggestion = g.suggestedTool
        ? ` Outside our catalog, ${g.suggestedTool} is worth a look — we haven't verified it.`
        : '';
      lines.push(`- **${g.capability}** — ${g.reason}${closest}${suggestion}`);
    });
  }

  if (workflow.tips.length) {
    lines.push('', '**Worth knowing**');
    workflow.tips.forEach(t => lines.push(`- ${t}`));
  }

  lines.push('', 'Click any stage on the canvas for the step-by-step playbook and a ready-to-paste prompt.');

  if (workflow.followUp) lines.push('', workflow.followUp);

  return lines.join('\n');
}

function assemble(plan, meta) {
  const totalMinutes = plan.stages.reduce((sum, s) => sum + s.timeMinutes, 0);
  // Counted on the workflow so the admin cost view can see how often we charge
  // a full generation for a plan carrying template steps. A quality regression
  // that only shows up as a support ticket is one nobody measures.
  const degradedStages = plan.stages.filter(s => s.degraded).length;

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
    gaps: plan.gaps || [],
    followUp: plan.followUp || '',
    createdAt: new Date().toISOString(),
    meta: { ...meta, degradedStages },
  };

  workflow.reply = composeReply(workflow);
  return workflow;
}

// ─────────────────────────────────────────────────────────────
// Non-workflow intents
// ─────────────────────────────────────────────────────────────

async function answerGrounded({ message, routed, contextMessages, allowExternalTools, userId, signals }) {
  const { cards } = await retrieve({
    queries: routed.searchQueries.length ? routed.searchQueries : [message],
    categories: routed.domains,
    pricing: routed.pricing,
    limit: 14,
    signals,
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

/**
 * Real products outside the catalog that could serve this goal.
 *
 * Only called when the user has explicitly opted in to tools beyond our
 * catalog. Until this existed, that toggle changed nothing about how a plan was
 * built: the planner was bound to CANDIDATE_TOOLS on every path, so a user who
 * asked for something the catalog cannot do got the closest catalog tool either
 * way — and, in the worst case, a stage that described the tool they should
 * have had while being bound to the one we could offer.
 *
 * The results are what the planner is permitted to bind to. Nothing else: a
 * product the model recalls from training has no verifiable URL, and an
 * unverifiable link on a plan is the failure this is meant to remove.
 *
 * @returns {Promise<Array<{name,url,tagline,source}>|null>}
 */
async function findExternalCandidates({ goal, queries, catalog }) {
  if (!isWebSearchConfigured()) return null;

  // One search, on the capability the goal is actually about. The router's
  // sub-queries name jobs ("build mobile app", "collect fee payments"), which
  // is exactly the phrasing that surfaces products rather than blog posts.
  const query = `best tools for ${queries.slice(0, 3).join(', ') || goal}`.slice(0, 300);
  const results = await webSearch(query, { maxResults: 6 });
  if (!results?.length) return null;

  const known = new Set(catalog.tools.map(t => t.name.toLowerCase()));

  const { data } = await completeJson({
    task: 'plan:external-candidates',
    role: 'fast',
    temperature: 0.1,
    // Room for the `fast` tier's reasoning tokens as well as the answer — see
    // the ceiling-retry note in `completeJson`.
    maxTokens: 2500,
    messages: [
      { role: 'system', content: prompts.externalCandidateSystem() },
      { role: 'user', content: prompts.externalCandidateUser({ goal, webResults: results }) },
    ],
    validate: v => (!v || !Array.isArray(v.tools) ? '"tools" must be an array.' : null),
  }).catch(() => ({ data: { tools: [] } }));

  const byUrl = new Map(results.map(r => [r.url, r]));

  return (data.tools || [])
    .filter(t => t?.name && t?.url)
    // The URL has to be one we were actually shown. Anything else is the model
    // filling in a plausible domain, which is indistinguishable from a real one
    // right up until the user clicks it.
    .filter(t => byUrl.has(t.url) || [...byUrl.keys()].some(u => u.startsWith(t.url) || t.url.startsWith(u)))
    .filter(t => !known.has(String(t.name).toLowerCase()))
    .slice(0, 6)
    .map(t => ({
      name: String(t.name).slice(0, 60),
      url: String(t.url).slice(0, 300),
      tagline: String(t.tagline || '').slice(0, 160),
      pricing: ['free', 'freemium', 'paid', 'contact'].includes(t.pricing) ? t.pricing : 'freemium',
    }));
}

/**
 * Best-effort match when the caller didn't pass an explicit `stageId` (no
 * node was selected on the canvas) — the question likely names the stage's
 * tool or title directly ("how do I open the Figma file", "the Notion step
 * isn't right"). Falls back to null (whole-workflow question) rather than
 * guessing wrong, since a mismatched stage is worse than no stage.
 */
function inferStage(workflow, message) {
  const text = String(message || '').toLowerCase();
  return (
    workflow.stages.find(s => s.tool?.name && text.includes(s.tool.name.toLowerCase())) ||
    workflow.stages.find(s => text.includes(String(s.title || '').toLowerCase())) ||
    null
  );
}

/**
 * A question asked while a workflow is already on the canvas — "how do I
 * open the Figma file", "this step's process is wrong", "explain step 3" —
 * is a different job from general tool discovery: it needs the actual stage
 * content in context, room to write a real explanation (not a 150-word
 * catalog blurb), and it should reach for the web whenever the answer is a
 * genuine how-to rather than only when the catalog came back thin.
 */
async function answerWorkflowStepQuestion({ message, workflow, stageId, contextMessages, allowExternalTools }) {
  const stage = (stageId && workflow.stages.find(s => s.id === stageId)) || inferStage(workflow, message);

  const shouldSearch = allowExternalTools && isWebSearchConfigured();
  const searchQuery = stage ? `${stage.tool?.name || ''} ${message}`.trim() : message;
  const webResults = shouldSearch ? await webSearch(searchQuery) : null;

  const { content } = await complete({
    task: 'answer',
    role: 'planner',
    temperature: 0.4,
    maxTokens: 1100,
    messages: [
      { role: 'system', content: prompts.workflowStepAnswerSystem(workflow, stage, webResults) },
      ...contextMessages.slice(-6),
      { role: 'user', content: fence(message) },
    ],
  });

  const finalMessage = checkOutput(content);

  return {
    message: finalMessage,
    workflow: null,
    intent: 'question',
    stageId: stage?.id || null,
    toolSlugs: [],
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
 * @param {Record<string,string>} [input.intakeAnswers] structured answers to the clarifying questions,
 *   keyed by question id — read directly instead of re-inferred from the prose the user sees
 * @param {(event:object)=>void} [input.onProgress]
 * @returns {Promise<{message:string, workflow:object|null, intent:string, title?:string, goal?:string}>}
 */
export async function handleMessage({
  message,
  conversation,
  userId = null,
  planId = null,
  allowExternalTools = false,
  intakeAnswers = null,
  stageId = null,
  onProgress = noop,
}) {
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

  const canRecall = Boolean(planId && planAllows(planId, 'memoryRecall'));

  // ── Long-term memory: structured profile + semantic cross-session recall ──
  const [profile, recalled] = userId
    ? await Promise.all([
        loadProfile(userId).catch(() => null),
        canRecall
          ? recallRelatedSessions({
              userId,
              sessionId: conversation.sessionId,
              goal: message,
            }).catch(() => [])
          : Promise.resolve([]),
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
    // "All of the above" is a chip label — expand it to the real option list
    // so the planner context and the approval summary show concrete choices.
    const resolvedAnswers = expandIntakeAnswers(
      intakeAnswers,
      clarifyState.questions || []
    );
    const questions = clarifyState.questions || [];
    const preferencesText = questions.some(q => resolvedAnswers[q.id])
      ? questions
          .filter(q => resolvedAnswers[q.id])
          .map(q => `${q.question} ${resolvedAnswers[q.id]}`)
          .join('. ')
      : sanitized;
    const enrichedGoal =
      `${clarifyState.baseGoal || sanitized}\n\nUser preferences:\n${preferencesText}`;

    const { facts, overrides } = factsFromIntakeAnswers(resolvedAnswers);
    if (userId && Object.keys(facts).length) {
      await updateProfileFacts(userId, facts).catch(err =>
        log.warn('Failed to persist intake facts', { error: err.message })
      );
    }

    const alreadyKnow = clarifyState.alreadyKnow || [];
    const stillNeed = clarifyState.stillNeed || [];

    if (userId) {
      await saveClarificationState(userId, sessionId, {
        phase: 'awaiting_approval',
        questions,
        answersText: preferencesText,
        enrichedGoal,
        baseGoal: clarifyState.baseGoal || sanitized,
        intakeOverrides: overrides,
        answers: resolvedAnswers,
        alreadyKnow,
        stillNeed,
      });
    }
    return {
      message: formatApprovalMessage({
        baseGoal: clarifyState.baseGoal || 'Your project',
        preferencesText,
        alreadyKnow,
        stillNeed: [],
      }),
      workflow: null,
      intent: 'clarify',
      readyToApprove: true,
      clarifyingQuestions: null,
      capturedPreferences: Object.keys(resolvedAnswers).length ? resolvedAnswers : null,
      intakeBriefing: { alreadyKnow, stillNeed: [] },
    };
  }

  let forcedGoal = null;
  let forcedOverrides = {};
  if (clarifyState?.phase === 'awaiting_approval' && APPROVAL_RE.test(sanitized)) {
    forcedGoal = clarifyState.enrichedGoal || clarifyState.baseGoal || sanitized;
    const extraMatch = sanitized.match(EXTRA_NOTES_RE);
    const extraNotes = extraMatch?.[1]?.trim();
    if (extraNotes) {
      forcedGoal = `${forcedGoal}\n\nAdditional notes from the user:\n${extraNotes.slice(0, 1500)}`;
    }
    forcedOverrides = clarifyState.intakeOverrides || {};
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
      // The intake answers win over the stored profile: they are what the user
      // said about *this* build, minutes ago.
      pricing: forcedOverrides.pricing || profile?.pricingPreference || 'any',
      skill: forcedOverrides.skill || profile?.skillLevel || 'beginner',
      clarifyingQuestions: [],
    };
  } else {
    // Second, distinct label — the router call that follows can take anywhere
    // from ~10s to the full timeout, and a single frozen "Understanding your
    // goal" for that whole span reads as a hang on the SSE stream.
    onProgress({ phase: 'understanding', message: 'Working out what to ask before planning' });
    try {
      routed = await route({
        message: sanitized,
        contextMessages,
        categories: catalog.categories,
        hasPriorWorkflow: Boolean(priorWorkflow),
        profile,
        // clarifyingQuestions are only ever read downstream when there's a
        // userId to store the intake state against — gate the requirement on
        // the same condition so an anonymous/system caller never forces a
        // repair round-trip over a field it will discard anyway.
        requireQuestions: Boolean(userId),
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

  // Mandatory intake before the first workflow — on every surface, not just
  // Workflow Studio. `/chat` generates real workflows too, and used to plan
  // them from a one-line goal with no questions asked at all.
  //
  // Repetition is throttled per routed domain (and decays), so a user who has
  // been asked about video three times still gets a proper intake the first
  // time they ask for a web app.
  //
  // Requires a userId: the answers are processed by matching them against a
  // persisted `clarificationState`, so asking without somewhere to store that
  // state would loop the same questions forever with no way to move past them.
  if (userId && routed.intent === 'workflow' && !priorWorkflow && !forcedGoal) {
    const intakeDomain = routed.domains[0] || GENERAL_DOMAIN;
    const exhausted = hasExhaustedIntake(profile, intakeDomain, MAX_CLARIFYING_ASKS);

    const {
      questions,
      alreadyKnow,
      stillNeed,
    } = await resolveIntakeQuestions({
      routed,
      profile,
      message: sanitized,
    });

    if (clarifyState?.phase === 'awaiting_approval') {
      // Already waiting on Generate — don't restart intake.
    } else if (!questions.length) {
      // Model decided the message + profile cover the goal. Still require
      // explicit human approval (and an optional "anything else" note).
      const enrichedGoal = routed.goal;
      if (userId) {
        recordIntakeAsk(userId, intakeDomain).catch(() => {});
        await saveClarificationState(userId, sessionId, {
          phase: 'awaiting_approval',
          questions: [],
          answersText: '',
          enrichedGoal,
          baseGoal: routed.goal,
          intakeOverrides: {},
          answers: {},
          alreadyKnow,
          stillNeed: [],
        }).catch(err =>
          log.warn('Failed to persist clarification state', { error: err.message })
        );
      }
      return {
        message: formatApprovalMessage({
          baseGoal: routed.goal,
          preferencesText: '',
          alreadyKnow,
          stillNeed: [],
        }),
        workflow: null,
        intent: 'clarify',
        readyToApprove: true,
        clarifyingQuestions: null,
        capturedPreferences: null,
        intakeBriefing: { alreadyKnow, stillNeed: [] },
      };
    } else {
      if (exhausted) {
        log.info('Domain intake previously exhausted — still asking LLM questions for this goal', {
          domain: intakeDomain,
          count: questions.length,
          ids: questions.map(q => q.id).join(','),
        });
      }
      if (userId) {
        recordIntakeAsk(userId, intakeDomain).catch(() => {});
        await saveClarificationState(userId, sessionId, {
          phase: 'asking',
          questions,
          answersText: '',
          enrichedGoal: '',
          baseGoal: routed.goal,
          intakeOverrides: {},
          alreadyKnow,
          stillNeed,
        }).catch(err =>
          log.warn('Failed to persist clarification state', { error: err.message })
        );
      }

      const knownBlock = alreadyKnow.length
        ? `\n\n**Already know**\n${alreadyKnow.map(l => `- ${l}`).join('\n')}\n\n`
        : '\n\n';

      return {
        message:
          `Before I design your workflow, I'll confirm what I know and ask only what's still open.${knownBlock}` +
          `A few quick questions:`,
        workflow: null,
        intent: 'clarify',
        clarifyingQuestions: questions,
        intakeBriefing: { alreadyKnow, stillNeed },
      };
    }
  }

  const signals = retrievalSignals(profile);

  /**
   * An explicit `stageId` means the user clicked a node and asked about it.
   * That is a question about how to carry out that stage — never a request to
   * rewrite the plan.
   *
   * The router does not reliably see the difference: it is told a workflow
   * already exists and that adjustments are "refine", and "how exactly do I do
   * the build step?" is close enough to an adjustment that it classifies as
   * one. The observed result was a full re-plan on a question — two stages
   * swapped tools, the user was charged a workflow generation, and work they
   * had not asked to change was silently replaced.
   */
  if (stageId && priorWorkflow && routed.intent === 'refine') {
    log.info('Question anchored to a stage — answering instead of re-planning', { stageId });
    routed.intent = 'question';
  }

  if (routed.intent === 'discover' || routed.intent === 'question') {
    // A workflow already on the canvas turns "how do I open the Figma file"
    // from a catalog lookup into a question about a specific stage — answer
    // it with that stage's content in context instead of generic tool copy.
    if (priorWorkflow) {
      onProgress({ phase: 'searching', message: 'Looking into that step' });
      return answerWorkflowStepQuestion({
        message: sanitized, workflow: priorWorkflow, stageId, contextMessages,
        allowExternalTools: resolvedExternalTools,
      });
    }
    onProgress({ phase: 'searching', message: `Searching ${catalog.tools.length} tools` });
    return answerGrounded({
      message: sanitized, routed, contextMessages,
      allowExternalTools: resolvedExternalTools, userId, signals,
    });
  }

  // ── Workflow / refine ────────────────────────────────────
  const isRefine = routed.intent === 'refine' && priorWorkflow;

  // The fingerprint is what stops one user's cached plan being served to
  // another whose profile would have produced a different one. Without it the
  // whole personalization layer is silently discarded on every cache hit.
  const cacheKey = cache.makeKey('workflow', [
    routed.goal,
    routed.pricing,
    routed.skill,
    catalog.tools.length,
    profileFingerprint(profile),
    isRefine ? priorWorkflow.id : 'fresh',
    // Two users with the same goal now get materially different plans
    // depending on this flag — one may be bound to the catalog, the other may
    // reach past it. Serving one's plan to the other is what would make the
    // toggle look broken even once it works.
    resolvedExternalTools ? 'ext' : 'catalog',
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
    signals,
  });

  /**
   * On a refine, retrieval runs on the *adjustment's* queries. A tool from a
   * stage the user never mentioned may not rank at all this time, and since the
   * validator only accepts slugs that are in the slate, its absence does not
   * read as "leave that stage alone" — it reads as "that tool does not exist",
   * and the planner is forced to swap a stage nobody asked about.
   *
   * Adding the prior plan's tools back makes "keep everything that still works"
   * an instruction the planner can actually follow.
   */
  if (isRefine) {
    const present = new Set(cards.map(c => c.slug));
    for (const stage of priorWorkflow.stages || []) {
      if (!stage.toolSlug || present.has(stage.toolSlug)) continue;
      const tool = catalog.bySlug.get(stage.toolSlug);
      if (tool) {
        cards.push(toCandidateCard(tool));
        present.add(stage.toolSlug);
      }
    }
  }

  if (!cards.length) {
    return {
      message:
        "I couldn't find tools in our catalog that match that goal. Try describing it differently, " +
        'or browse the categories to see what we cover.',
      workflow: null,
      intent: routed.intent,
    };
  }

  // Only when the user opted in — this costs a search credit and a fast-model
  // call, and it is the difference between the toggle meaning something and
  // meaning nothing.
  let externalCandidates = null;
  if (resolvedExternalTools) {
    onProgress({ phase: 'searching', message: 'Looking beyond the catalog' });
    externalCandidates = await findExternalCandidates({
      goal: routed.goal,
      queries: routed.searchQueries,
      catalog,
    }).catch(err => {
      log.warn('External candidate search failed — planning from the catalog alone', { error: err.message });
      return null;
    });
    if (externalCandidates?.length) {
      log.info('External candidates offered to the planner', {
        count: externalCandidates.length,
        names: externalCandidates.map(c => c.name).join(', '),
      });
    }
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
    allowExternalTools: resolvedExternalTools,
    externalCandidates,
    // On the approval turn the brief is the enriched goal we are about to
    // persist; on every later turn it is read back from the conversation.
    brief: forcedGoal || conversation.brief || '',
  });

  const bySlug = new Map(cards.map(c => [c.slug, catalog.bySlug.get(c.slug)]).filter(([, t]) => t));
  const normalized = normalizePlan(raw, {
    bySlug,
    goal: routed.goal,
    title: routed.title,
    catalogNames: cards.map(c => c.name),
    externalCandidates,
  });

  if (normalized.stages.length < 2) {
    log.warn('Plan collapsed after validation', { stages: normalized.stages.length });
    return answerGrounded({
      message: sanitized, routed, contextMessages,
      allowExternalTools: resolvedExternalTools, userId, signals,
    });
  }

  const reusedCount = isRefine ? reusePlaybooksFromPrior(normalized.stages, priorWorkflow, sanitized) : 0;

  // The stage list — tools, titles, handovers, timings — is fully decided at
  // this point, but the playbooks below take most of the wall-clock time.
  // Emitting the skeleton now lets the canvas draw the real graph immediately
  // instead of showing a spinner for the whole pipeline.
  onProgress({
    phase: 'plan',
    message: 'Workflow mapped — writing the steps',
    workflow: assemble(normalized, {
      model,
      corpusSize,
      candidatesConsidered: cards.length,
      pricing: routed.pricing,
      skill: routed.skill,
      ms: Date.now() - startedAt,
      cached: false,
      partial: true,
    }),
  });

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

  /**
   * A tool good enough to build a stage on is a tool the catalog should have.
   * Queueing it for admin review is what turns a gap the user hit today into a
   * catalog entry the next user does not hit — the alternative is running the
   * same web search forever for the same missing capability.
   *
   * Fire-and-forget: never delays the response, writes only to `SuggestedTool`
   * (status: pending), never to the live catalog.
   */
  const externalUsed = workflow.stages.filter(s => s.tool?.external);
  if (externalUsed.length) {
    discoverAndQueueTools({
      webResults: externalUsed.map(s => ({
        title: s.tool.name,
        url: s.tool.websiteUrl,
        snippet: s.tool.tagline || s.why,
      })),
      assistantReply: workflow.reply,
      sourceQuery: routed.goal,
      userId,
    }).catch(() => {});
  }

  onProgress({ phase: 'done', message: 'Workflow ready' });

  log.info('Workflow generated', {
    stages: workflow.stages.length,
    reused: reusedCount,
    external: externalUsed.length,
    gaps: workflow.gaps?.length || 0,
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
    // Persisted once, on the turn the user approved their intake answers.
    brief: forcedGoal || undefined,
    // External stages have no slug — filtered out rather than recorded as
    // nulls, which would corrupt the conversation's tool-slug grounding.
    toolSlugs: workflow.stages.map(s => s.toolSlug).filter(Boolean),
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
    forceRefresh: true,
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
      // See the ceiling-retry note in `completeJson`: 300 was smaller than the
      // reasoning tier's thinking budget, so this returned nothing at all and
      // long-term memory quietly stopped growing.
      maxTokens: 1500,
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
