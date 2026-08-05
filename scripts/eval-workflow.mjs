/**
 * Live end-to-end workflow evaluation.
 *
 * Runs real goals through the real pipeline against the real model and grades
 * the output on the things that make a workflow useful rather than merely
 * present: are the tools real, do the stages chain, are the steps specific,
 * is there a usable prompt, are the time and cost claims sane.
 *
 * Needs a working GROQ_API_KEY. Costs a handful of calls per goal.
 *
 *   npm run eval:workflow
 *   npm run eval:workflow -- "produce a lo-fi album"
 */

import mongoose from 'mongoose';
import config from '../src/config/index.js';
import { handleMessage } from '../src/ai/workflowEngine.js';
import { getCatalog } from '../src/ai/catalog.js';
import { isLLMAvailable } from '../src/ai/llm.js';
import { gradeWorkflow, setCatalogNames } from './e2e-workflow.mjs';

const green = s => `\x1b[32m${s}\x1b[0m`;
const red = s => `\x1b[31m${s}\x1b[0m`;
const yellow = s => `\x1b[33m${s}\x1b[0m`;
const dim = s => `\x1b[2m${s}\x1b[0m`;
const bold = s => `\x1b[1m${s}\x1b[0m`;

const DEFAULT_GOALS = [
  'I want to create a YouTube video from scratch about home espresso',
  'Help me write and publish an SEO-optimised blog post for my agency',
  'I want to produce a song with AI — lyrics, vocals and mastering',
  'Design a logo and brand kit for a new coffee shop',
  'Build and deploy a landing page for my SaaS, free tools only',
  'Turn my long podcast episodes into short clips for TikTok',
  // Regression: this goal produced a plan whose build stage was titled after
  // one tool and bound to another, because the catalog had no mobile app
  // builder at all. Kept permanently — it is the shape of goal that exposes a
  // coverage hole, and a coverage hole is what makes a plan start lying.
  'I want to create a mobile application for schools and colleges',
];

const goals = process.argv.slice(2).filter(a => !a.startsWith('--'));
const targets = goals.length ? goals : DEFAULT_GOALS;

if (!isLLMAvailable()) {
  console.error(red('\nGROQ_API_KEY is not set — this eval needs a live model.\n'));
  process.exit(1);
}

await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 15_000 });
const catalog = await getCatalog({ force: true });
const validSlugs = new Set(catalog.tools.map(t => t.slug));
setCatalogNames(catalog.tools.map(t => t.name));

console.log(`\n${bold('Workflow quality eval')} — ${catalog.tools.length} tools indexed\n`);

/**
 * Grade one workflow. Each check is a property a user would notice being wrong.
 * @returns {{score:number, max:number, failures:string[], warnings:string[]}}
 */
function grade(workflow) {
  const failures = [];
  const warnings = [];
  let score = 0;
  let max = 0;

  const check = (label, passed, { warn = false } = {}) => {
    max++;
    if (passed) score++;
    else if (warn) warnings.push(label);
    else failures.push(label);
  };

  const stages = workflow.stages || [];

  check(`has ${config.ai.minStages}-${config.ai.maxStages} stages`,
    stages.length >= config.ai.minStages && stages.length <= config.ai.maxStages);

  // An external stage has no slug by design — it is bound to a product outside
  // the catalog, which is legal only when the user opted in. What must always
  // hold is that it carries a real URL instead of a `/tool/` link to nothing.
  check('every tool is a catalog slug or a properly-formed external tool',
    stages.every(s =>
      validSlugs.has(s.toolSlug) ||
      (s.tool?.external && /^https?:\/\//.test(s.tool.websiteUrl || ''))));

  /**
   * The checks that catch a plan which is well-formed and still wrong: a stage
   * describing a tool it is not bound to, and a stage that shipped the
   * deterministic fallback template instead of a written playbook. Every
   * structural check above passes on both.
   */
  const defects = gradeWorkflow(workflow);
  check('no stage names a tool it is not bound to',
    !defects.some(d => d.startsWith('FOREIGN_TOOL')));
  check('no stage shipped the fallback playbook template',
    !defects.some(d => d.startsWith('FALLBACK_PLAYBOOK')));
  check('no stage rationale reads as a changelog',
    !defects.some(d => d.startsWith('CHANGELOG_WHY')), { warn: true });

  check('no tool is reused across stages',
    new Set(stages.map(s => s.toolSlug)).size === stages.length, { warn: true });

  check('every stage names a concrete output',
    stages.every(s => s.output && s.output.length > 10));

  check('stages chain — each input is the previous output',
    stages.every((s, i) => i === 0 || s.input === stages[i - 1].output));

  check('every stage explains why that tool',
    stages.every(s => s.why && s.why.length > 20));

  check('every stage has 4 steps',
    stages.every(s => s.steps?.length === 4));

  check('steps carry real detail, not just titles',
    stages.every(s => s.steps?.every(step => step.detail && step.detail.length > 25)));

  check('steps are actions, not restatements of the tool name',
    stages.every(s => s.steps?.every(step => step.title.split(/\s+/).length >= 4)));

  check('at least half the stages give a paste-ready prompt',
    stages.filter(s => s.prompt && s.prompt.length > 60).length >= Math.ceil(stages.length / 2));

  check('every stage warns about a pitfall',
    stages.every(s => s.pitfall && s.pitfall.length > 15), { warn: true });

  check('every stage states a checkpoint',
    stages.every(s => s.checkpoint && s.checkpoint.length > 10), { warn: true });

  check('time estimates are plausible (5-240 min per stage)',
    stages.every(s => s.timeMinutes >= 5 && s.timeMinutes <= 240));

  check('names a concrete final deliverable',
    Boolean(workflow.outcome && workflow.outcome.length > 12));

  check('gives at least two non-empty tips',
    (workflow.tips || []).filter(t => t.length > 20).length >= 2, { warn: true });

  return { score, max, failures, warnings };
}

let totalScore = 0;
let totalMax = 0;
let hardFailures = 0;

for (const goal of targets) {
  const started = Date.now();
  process.stdout.write(`${bold(goal)}\n`);

  try {
    const result = await handleMessage({
      message: goal,
      conversation: { messages: [], summary: '', goal: '', lastWorkflow: null },
      onProgress: e => process.stdout.write(dim(`  … ${e.message}\r`)),
    });

    process.stdout.write(' '.repeat(70) + '\r');

    if (!result.workflow) {
      console.log(`  ${red('NO WORKFLOW')} — got a ${result.intent} response instead\n`);
      hardFailures++;
      continue;
    }

    const wf = result.workflow;
    const { score, max, failures, warnings } = grade(wf);
    totalScore += score;
    totalMax += max;
    if (failures.length) hardFailures++;

    const pct = Math.round((score / max) * 100);
    const badge = failures.length === 0 ? green(`${pct}%`) : pct >= 75 ? yellow(`${pct}%`) : red(`${pct}%`);

    console.log(`  ${badge}  ${wf.stages.length} stages · ${wf.totalDuration} · ${wf.costSummary}`);
    console.log(dim(`  ${wf.stages.map(s => s.tool.name).join(' → ')}`));
    console.log(dim(`  outcome: ${wf.outcome}`));
    console.log(dim(`  ${Math.round((Date.now() - started) / 100) / 10}s · ${wf.meta.candidatesConsidered} candidates considered`));

    for (const f of failures) console.log(`  ${red('✗')} ${f}`);
    for (const w of warnings) console.log(`  ${yellow('!')} ${w}`);

    // Show one stage in full so the output can be eyeballed, not just scored.
    const sample = wf.stages[0];
    console.log(dim(`\n  sample stage — ${sample.title} (${sample.tool.name})`));
    sample.steps.forEach((s, i) => console.log(dim(`    ${i + 1}. ${s.title}`)));
    if (sample.prompt) console.log(dim(`    prompt: ${sample.prompt.slice(0, 110)}…`));

    console.log();
  } catch (err) {
    process.stdout.write(' '.repeat(70) + '\r');
    console.log(`  ${red('ERROR')} ${err.message}\n`);
    hardFailures++;
  }
}

const overall = totalMax ? Math.round((totalScore / totalMax) * 100) : 0;
console.log(
  `${bold('Overall')}: ${overall}% of checks passed · ` +
  `${hardFailures === 0 ? green('no goals with hard failures') : red(`${hardFailures} goal(s) with failures`)}\n`
);

await mongoose.disconnect();
process.exit(hardFailures === 0 ? 0 : 1);
