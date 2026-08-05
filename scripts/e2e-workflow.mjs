/**
 * End-to-end workflow harness — the multi-turn one.
 *
 * `eval-workflow.mjs` grades a single first-turn plan. That is not how anyone
 * uses the product: real sessions are intake → approve → refine → ask about a
 * stage, and every defect that has actually reached a user lived in the turns
 * after the first one. This drives whole conversations through `handleMessage`
 * with hand-built conversation objects — no HTTP, no auth, and nothing written
 * to the database, so it is safe to point at production.
 *
 * It grades the four properties that a plausible-looking workflow can violate
 * while every existing check passes:
 *
 *   FOREIGN_TOOL       a stage's prose names a tool it is not bound to. This is
 *                      the "Build the App (Glide…) — Lovable" failure: the JSON
 *                      repair round-trip fixes the rejected slug and leaves the
 *                      prose describing the tool that was rejected.
 *   FALLBACK_PLAYBOOK  a stage shipped `fallbackPlaybook()`'s template. It
 *                      renders identically to a real playbook and is charged at
 *                      the same rate, so nothing downstream notices.
 *   BROKEN_CHAIN       a stage's input is not the previous stage's output.
 *   CHANGELOG_WHY      `why` written as a note about what changed rather than as
 *                      the user-facing description of the stage.
 *
 *   npm run e2e:workflow
 *   npm run e2e:workflow -- --personas beginner,pro
 */

import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import mongoose from 'mongoose';
import config from '../src/config/index.js';
import { handleMessage } from '../src/ai/workflowEngine.js';
import { getCatalog } from '../src/ai/catalog.js';
import { isLLMAvailable } from '../src/ai/llm.js';
import { isWebSearchConfigured } from '../src/ai/tools/webSearch.js';
import { expandIntakeAnswers } from '../src/ai/personalization.js';
import { foreignToolNames } from '../src/ai/toolNames.js';

const green = s => `\x1b[32m${s}\x1b[0m`;
const red = s => `\x1b[31m${s}\x1b[0m`;
const yellow = s => `\x1b[33m${s}\x1b[0m`;
const dim = s => `\x1b[2m${s}\x1b[0m`;
const bold = s => `\x1b[1m${s}\x1b[0m`;

const argOf = name => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
};

const OUT_DIR = argOf('out') || path.join(process.cwd(), '.e2e');

/**
 * The exact strings `fallbackPlaybook()` emits. Matching on the deterministic
 * text is the only reliable signal today — the fallback carries no marker of
 * its own, which is the reason it has been invisible.
 */
const FALLBACK_MARKERS = [
  'Instructions unavailable',
  'We could not generate the step-by-step playbook',
  'These are placeholder steps',
  'Hit Regenerate on this stage',
  // Legacy template (pre-fix) — still flag if an old cached playbook appears.
  'Bring in what the last stage produced',
  'Do the core work for this stage',
];

let CATALOG_NAMES = [];

/** Exported so other harnesses can reuse `gradeWorkflow` against stored plans. */
export function setCatalogNames(names) {
  CATALOG_NAMES = names;
}

/** @returns {string[]} one line per defect, empty when the workflow is sound */
export function gradeWorkflow(workflow) {
  const problems = [];
  const stages = workflow?.stages || [];

  /**
   * Every tool this plan legitimately talks about: the tool bound to any stage
   * — a chain's stages refer to each other's tools by design ("export what the
   * FlutterFlow build expects") — plus anything named as a gap.
   *
   * A tool bound to no stage at all is the contradiction worth reporting.
   */
  const declared = [
    ...stages.map(s => s.tool?.name || s.toolSlug).filter(Boolean),
    ...(workflow?.gaps || []).map(g => g.suggestedTool || g.tool || g.name).filter(Boolean),
  ];

  stages.forEach((stage, i) => {
    const n = i + 1;
    const boundName = stage.tool?.name || stage.toolSlug;

    const foreign = foreignToolNames(`${stage.title} — ${stage.why}`, boundName, {
      catalogNames: CATALOG_NAMES,
      allowed: declared,
    });
    if (foreign.length) {
      problems.push(
        `FOREIGN_TOOL stage ${n} is bound to "${boundName}" but its prose names ` +
        `${foreign.join(', ')} — "${stage.title}"`
      );
    }

    const playbookText = [
      ...(stage.steps || []).map(s => `${s.title} ${s.detail}`),
      stage.pitfall || '',
    ].join(' ');
    const markerHits = FALLBACK_MARKERS.filter(m => playbookText.includes(m));
    if (markerHits.length >= 2) {
      problems.push(`FALLBACK_PLAYBOOK stage ${n} (${boundName}) shipped the template`);
    }

    if (i > 0 && stage.input !== stages[i - 1].output) {
      problems.push(`BROKEN_CHAIN stage ${n} input does not match stage ${i} output`);
    }

    const why = String(stage.why || '').trim();
    if (/^(this stage (has been|is) replaced|replaced|swapped|changed (from|to)|previously|instead of)/i.test(why)) {
      problems.push(`CHANGELOG_WHY stage ${n}: "${why.slice(0, 90)}"`);
    }
    // A raw .slice() cut lands mid-word; a sentence-aware one never does.
    if (/[a-z]{1,3}$/.test(why) && !/[.!?)]$/.test(why) && why.length > 250) {
      problems.push(`TRUNCATED_WHY stage ${n}: "…${why.slice(-45)}"`);
    }
  });

  return problems;
}

// ─────────────────────────────────────────────────────────────
// Conversation driver
// ─────────────────────────────────────────────────────────────

/**
 * A conversation object of the shape `memory.loadConversation` returns, kept
 * in memory. Turns are appended locally so the engine sees a growing history
 * without a single database write.
 */
function newConversation(sessionId) {
  return {
    sessionId,
    messages: [],
    summary: '',
    goal: '',
    brief: '',
    lastWorkflow: null,
    clarificationState: null,
    turnCount: 0,
  };
}

const transcript = [];

async function turn(convo, label, message, opts = {}) {
  const started = Date.now();
  let result;
  let error = null;

  try {
    result = await handleMessage({
      message,
      conversation: convo,
      // No userId: intake state and the profile live in Mongo, and this harness
      // must not write there. The intake branch is exercised separately below
      // by seeding `clarificationState` directly.
      userId: null,
      ...opts,
    });
  } catch (err) {
    error = err.message;
    result = { message: '', intent: 'error', workflow: null };
  }

  const ms = Date.now() - started;

  // Mirror what `appendTurn` would have persisted, so the next turn sees the
  // same context a real session would.
  convo.messages.push({ role: 'user', content: message });
  convo.messages.push({
    role: 'assistant',
    content: result.message || '',
    ...(result.workflow ? { workflow: result.workflow, workflowDiff: result.workflowDiff } : {}),
  });
  convo.turnCount += 1;
  if (result.goal) convo.goal = result.goal;
  // Written once, exactly like `appendTurn` does it.
  if (result.brief && !convo.brief) convo.brief = result.brief;
  if (result.workflow) convo.lastWorkflow = result.workflow;

  const problems = result.workflow ? gradeWorkflow(result.workflow) : [];
  const entry = {
    label,
    message,
    intent: result.intent,
    ms,
    error,
    clarifyingQuestions: (result.clarifyingQuestions || []).map(q => q.question),
    reply: result.message,
    workflow: result.workflow
      ? {
          id: result.workflow.id,
          version: result.workflow.version,
          title: result.workflow.title,
          meta: result.workflow.meta,
          stages: result.workflow.stages.map(s => ({
            id: s.id,
            title: s.title,
            toolSlug: s.toolSlug,
            toolName: s.tool?.name,
            external: Boolean(s.tool?.external),
            why: s.why,
            input: s.input,
            output: s.output,
            steps: s.steps,
            prompt: s.prompt,
            settings: s.settings,
            pitfall: s.pitfall,
            checkpoint: s.checkpoint,
          })),
          tips: result.workflow.tips,
        }
      : null,
    workflowDiff: result.workflowDiff || null,
    problems,
  };
  transcript.push(entry);

  const badge = error ? red('ERROR') : problems.length ? red(`${problems.length} problem(s)`) : green('ok');
  console.log(`  ${label} ${dim(`(${(ms / 1000).toFixed(1)}s, intent=${result.intent})`)} ${badge}`);
  if (error) console.log(`    ${red('!')} ${error}`);
  if (entry.clarifyingQuestions.length) {
    entry.clarifyingQuestions.forEach(q => console.log(dim(`    ? ${q}`)));
  }
  if (result.workflow) {
    console.log(dim(
      `    ${result.workflow.stages.map(s => {
        const tag = s.tool?.external ? 'ext' : 'cat';
        return `${s.title.slice(0, 28)} [${s.tool?.name || '?'} · ${tag}]`;
      }).join(' → ')}`
    ));
  }
  problems.forEach(p => console.log(`    ${red('✗')} ${p}`));

  return { result, entry };
}

/** Ids kept between two versions of a plan, and tools swapped in place. */
function compareVersions(before, after) {
  if (!before || !after) return null;
  const beforeStages = before.stages || [];
  const afterStages = after.stages || [];
  const preserved = afterStages.filter(a => beforeStages.some(b => b.id === a.id));
  const swapped = afterStages
    .map(a => {
      const b = beforeStages.find(x => x.id === a.id);
      return b && b.toolSlug !== a.toolSlug ? { id: a.id, from: b.tool?.name, to: a.tool?.name } : null;
    })
    .filter(Boolean);
  return {
    before: beforeStages.length,
    after: afterStages.length,
    preservedIds: preserved.length,
    swaps: swapped,
  };
}

function reportDiff(label, cmp) {
  if (!cmp) return;
  const swapText = cmp.swaps.length
    ? cmp.swaps.map(s => `${s.from}→${s.to}`).join(', ')
    : 'none';
  console.log(dim(`    ${label}: ${cmp.before}→${cmp.after} stages · ${cmp.preservedIds} ids preserved · swaps: ${swapText}`));
}

// ─────────────────────────────────────────────────────────────
// Personas
// ─────────────────────────────────────────────────────────────

/**
 * The reported failure, end to end: a goal the catalog cannot serve, followed
 * by the user pointing out that it was not served.
 */
async function personaBeginner({ allowExternalTools }) {
  const name = allowExternalTools ? 'beyond-catalog' : 'beginner';
  console.log(`\n${bold(name)} ${dim(`— school mobile app, allowExternalTools=${allowExternalTools}`)}`);

  const convo = newConversation(`e2e-${name}`);
  const opts = { allowExternalTools };

  // Mirror the real intake: "All of the above" must expand before it reaches
  // the enriched goal the planner reads.
  const intakeQuestions = [
    {
      id: 'features',
      question: 'Which core features are most important to include in v1?',
      options: [
        'Attendance tracking',
        'Grades & report cards',
        'Announcements / notices',
        'Timetable / schedule',
        'Parent-teacher messaging',
        'All of the above',
      ],
    },
  ];
  const resolvedAnswers = expandIntakeAnswers(
    { features: 'All of the above' },
    intakeQuestions
  );
  if (!String(resolvedAnswers.features || '').includes('Attendance tracking')) {
    throw new Error('expandIntakeAnswers failed to expand "All of the above" before planning');
  }
  console.log(dim(`  intake expand: ${resolvedAnswers.features}`));

  // The intake questions are asked by the surface, not the engine, when there
  // is no userId — so seed the approved state the way a real session reaches
  // the planner, carrying everything the user answered.
  convo.clarificationState = {
    phase: 'awaiting_approval',
    questions: intakeQuestions,
    answersText: `Which core features are most important to include in v1? ${resolvedAnswers.features}`,
    answers: resolvedAnswers,
    baseGoal: 'Create a mobile application for schools and colleges',
    enrichedGoal:
      'Create a mobile application for schools and colleges.\n\nUser preferences:\n' +
      `Which core features are most important to include in v1? ${resolvedAnswers.features}. ` +
      'Platforms: both iOS and Android. Users: students, parents, teachers and admins. ' +
      'No preferred no-code platform. Budget: Freemium OK.',
    intakeOverrides: { skill: 'beginner' },
  };

  const first = await turn(convo, 'approve → generate', 'Yes, create the workflow with these preferences.', opts);

  const refine = await turn(
    convo,
    'refine: mobile not web',
    'I asked for a mobile app and you gave me a web app. The build stage must produce an ' +
      'installable iOS and Android app, not a website.',
    opts
  );
  reportDiff('refine', compareVersions(first.result.workflow, refine.result.workflow));

  const plan = refine.result.workflow || first.result.workflow;
  const externalStages = (plan?.stages || []).filter(s => s.tool?.external);
  if (allowExternalTools) {
    if (externalStages.length) {
      console.log(green(
        `  ✓ beyond-catalog bound ${externalStages.length} external stage(s): ` +
        externalStages.map(s => s.tool.name).join(', ')
      ));
    } else if (isWebSearchConfigured()) {
      // Soft signal — Tavily may return nothing useful, but the path must have
      // run without error. Fail hard only when the plan still looks like a
      // website stack after the user insisted on a native mobile app.
      const names = (plan?.stages || []).map(s => s.tool?.name || s.toolSlug).join(', ');
      console.log(yellow(
        `  ! beyond-catalog: no external stages bound (catalog: ${names || 'none'}). ` +
        'Search ran but the planner stayed in-catalog.'
      ));
      if (/lovable|v0|framer|webflow|bubble/i.test(names) && !/flutterflow|adalo|glide|thunkable|draftbit|bravo/i.test(names)) {
        const msg =
          'BEYOND_CATALOG expected a mobile-app builder (or external tool) after refine, ' +
          `got catalog-only web stack: ${names}`;
        refine.entry.problems.push(msg);
        console.log(`    ${red('✗')} ${msg}`);
      }
    } else {
      console.log(yellow('  ! beyond-catalog: Tavily not configured — external path skipped'));
    }
  }

  const buildStage = refine.result.workflow?.stages?.[2];
  if (buildStage) {
    await turn(convo, 'question about the build stage', 'How exactly do I do the build step? What do I click first?', {
      ...opts,
      stageId: buildStage.id,
    });
  }

  return { name, convo };
}

/** A goal the catalog genuinely covers, refined twice. */
async function personaPro() {
  console.log(`\n${bold('pro')} ${dim('— SEO blog post, advanced, two refines')}`);

  const convo = newConversation('e2e-pro');
  convo.clarificationState = {
    phase: 'awaiting_approval',
    questions: [],
    answersText: '',
    baseGoal: 'Research, write and publish an SEO-optimised blog post for an agency',
    enrichedGoal:
      'Research, write and publish an SEO-optimised blog post for an agency.\n\nUser preferences:\n' +
      'Advanced user, paid tools are fine, needed this week.',
    intakeOverrides: { skill: 'advanced', pricing: 'paid' },
  };

  const v1 = await turn(convo, 'approve → generate', 'Yes, create the workflow with these preferences.');
  const v2 = await turn(convo, 'refine: free only', 'Make it free only — swap out anything paid.');
  reportDiff('v1→v2', compareVersions(v1.result.workflow, v2.result.workflow));

  const v3 = await turn(convo, 'refine: add a stage', 'Add a stage for turning the finished post into a LinkedIn carousel.');
  reportDiff('v2→v3', compareVersions(v2.result.workflow, v3.result.workflow));

  return { name: 'pro', convo };
}

// ─────────────────────────────────────────────────────────────

// Importable as a library (see grade-stored-workflow.mjs) — only run the
// personas when this file is the entry point.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const requested = (argOf('personas') || 'beginner,pro,beyond-catalog').split(',').map(s => s.trim());

  if (!isLLMAvailable()) {
    console.error(red('\nNo AI provider configured — this harness needs a live model.\n'));
    process.exit(1);
  }

  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 15_000 });
  const catalog = await getCatalog({ force: true });
  CATALOG_NAMES = catalog.tools.map(t => t.name);

  console.log(
    `\n${bold('Multi-turn workflow E2E')} — ${catalog.tools.length} tools · ` +
    `models: ${config.ai.providers.map(p => `${p.name}(reasoning=${p.reasoningModel}, planner=${p.plannerModel})`).join(', ')}\n`
  );

  const started = Date.now();

  if (requested.includes('beginner')) await personaBeginner({ allowExternalTools: false });
  if (requested.includes('pro')) await personaPro();
  if (requested.includes('beyond-catalog')) await personaBeginner({ allowExternalTools: true });

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outfile = path.join(OUT_DIR, `e2e-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(
    outfile,
    JSON.stringify(
      { at: new Date().toISOString(), catalogSize: catalog.tools.length, transcript },
      null,
      2
    )
  );

  const allProblems = transcript.flatMap(t => t.problems.map(p => `${t.label}: ${p}`));
  const errors = transcript.filter(t => t.error);

  console.log(`\n${'─'.repeat(72)}`);
  console.log(
    `${bold('Result')}: ${transcript.length} turns in ${Math.round((Date.now() - started) / 1000)}s · ` +
    `${errors.length ? red(`${errors.length} error(s)`) : green('no errors')} · ` +
    `${allProblems.length ? red(`${allProblems.length} problem(s)`) : green('no problems')}`
  );
  allProblems.forEach(p => console.log(`  ${red('✗')} ${p}`));
  console.log(dim(`\n${outfile}\n`));

  await mongoose.disconnect();
  process.exit(allProblems.length || errors.length ? 1 : 0);
}
