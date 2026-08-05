/**
 * Grade a workflow already stored on a conversation.
 *
 * Ground-truthing for `e2e-workflow.mjs`'s grader: point it at the session that
 * produced a known-bad plan and confirm the checks actually fire. A grader that
 * cannot catch the failure it was written for is worse than no grader, because
 * a clean run then reads as evidence.
 *
 *   node scripts/grade-stored-workflow.mjs <sessionId>
 *   node scripts/grade-stored-workflow.mjs --all
 */

import mongoose from 'mongoose';
import config from '../src/config/index.js';
import Conversation from '../src/models/Conversation.js';
import { getCatalog } from '../src/ai/catalog.js';
import { gradeWorkflow, setCatalogNames } from './e2e-workflow.mjs';

const red = s => `\x1b[31m${s}\x1b[0m`;
const green = s => `\x1b[32m${s}\x1b[0m`;
const dim = s => `\x1b[2m${s}\x1b[0m`;
const bold = s => `\x1b[1m${s}\x1b[0m`;

await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 15_000 });
const catalog = await getCatalog({ force: true });
setCatalogNames(catalog.tools.map(t => t.name));

const target = process.argv[2];
const query = !target || target === '--all' ? { lastWorkflow: { $ne: null } } : { sessionId: target };
const convos = await Conversation.find(query).lean();

let totalProblems = 0;

for (const convo of convos) {
  const wf = convo.lastWorkflow;
  if (!wf) continue;

  console.log(`\n${bold(convo.sessionId)} — ${wf.title} ${dim(`(v${wf.version || 1}, ${wf.stages?.length || 0} stages)`)}`);
  console.log(dim(`  ${(wf.stages || []).map(s => `${s.title.slice(0, 30)} [${s.tool?.name}]`).join(' → ')}`));

  const problems = gradeWorkflow(wf);
  totalProblems += problems.length;

  if (!problems.length) console.log(`  ${green('no problems')}`);
  problems.forEach(p => console.log(`  ${red('✗')} ${p}`));
}

console.log(`\n${bold('Total')}: ${totalProblems} problem(s) across ${convos.length} stored workflow(s)\n`);
await mongoose.disconnect();
