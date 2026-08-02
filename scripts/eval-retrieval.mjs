/**
 * Retrieval evaluation harness.
 *
 * Runs a fixed set of goals through the retriever and reports precision-style
 * metrics against hand-labelled expectations. Run after changing ranking so a
 * tuning "improvement" that quietly breaks another query gets caught.
 *
 *   npm run eval:retrieval
 */

import mongoose from 'mongoose';
import config from '../src/config/index.js';
import { retrieve } from '../src/ai/retriever.js';
import { getCatalog } from '../src/ai/catalog.js';

/** Each case: sub-queries the router would produce + slugs that must surface. */
const CASES = [
  {
    name: 'YouTube video end to end',
    queries: ['script writing', 'ai voiceover', 'video editing', 'thumbnail design'],
    categories: ['video', 'writing', 'image'],
    expectAny: ['runway', 'synthesia', 'domoai', 'hypernatural', 'reccloud', 'tubeblink'],
  },
  {
    name: 'Write and publish a blog post',
    queries: ['blog writing', 'seo optimization', 'grammar check', 'featured image'],
    categories: ['writing', 'marketing'],
    expectAny: ['jasper', 'copy-ai', 'writesonic', 'grammarly'],
  },
  {
    name: 'Build a web app',
    queries: ['code generation', 'ai pair programming', 'code review', 'debugging'],
    categories: ['coding'],
    expectAny: ['github-copilot', 'cursor', 'claude-code', 'tabnine', 'qodo'],
  },
  {
    name: 'Design a logo and brand kit',
    queries: ['image generation', 'logo design', 'graphic design', 'presentation'],
    categories: ['image', 'design'],
    expectAny: ['midjourney', 'leonardo-ai', 'adobe-firefly', 'dall-e', 'stable-diffusion'],
  },
  {
    name: 'Free-only research workflow',
    queries: ['web research', 'summarize sources', 'note taking'],
    categories: ['research', 'productivity'],
    pricing: 'free',
    expectAny: ['perplexity-ai', 'komo-search', 'notion-ai', 'otter-ai'],
  },
  {
    name: 'Produce a song end to end',
    queries: ['write lyrics', 'generate music', 'ai vocals', 'audio mastering'],
    categories: ['audio', 'writing'],
    expectAny: ['suno', 'udio', 'elevenlabs', 'adobe-podcast'],
  },
  {
    name: 'Automate a business process',
    queries: ['workflow automation', 'connect apps', 'no code integration'],
    categories: ['productivity', 'business'],
    expectAny: ['make', 'n8n', 'zapier-ai'],
  },
  {
    name: 'Repurpose long video into shorts',
    queries: ['clip long video', 'vertical short form', 'auto captions', 'social scheduling'],
    categories: ['video', 'social'],
    expectAny: ['opus-clip', 'capcut', 'buffer-ai-assistant'],
  },
  {
    name: 'Build a resume and land interviews',
    queries: ['resume builder', 'cover letter', 'interview practice'],
    categories: ['hr'],
    expectAny: ['kickresume', 'enhancv', 'vmock'],
  },
];

const green = s => `\x1b[32m${s}\x1b[0m`;
const red = s => `\x1b[31m${s}\x1b[0m`;
const dim = s => `\x1b[2m${s}\x1b[0m`;

await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 10_000 });
const catalog = await getCatalog({ force: true });

console.log(`\nCorpus: ${catalog.tools.length} tools · ${catalog.index.size} terms\n`);

let passed = 0;

for (const testCase of CASES) {
  const { cards } = await retrieve({
    queries: testCase.queries,
    categories: testCase.categories,
    pricing: testCase.pricing || 'any',
    limit: 32,
  });

  const slugs = cards.map(c => c.slug);
  const hits = testCase.expectAny.filter(s => slugs.includes(s));
  const recall = hits.length / testCase.expectAny.length;

  // Rank of the first expected hit — the planner reads the top of the list first.
  const firstHitRank = slugs.findIndex(s => testCase.expectAny.includes(s));

  const ok = hits.length > 0 && firstHitRank !== -1 && firstHitRank < 12;
  if (ok) passed++;

  console.log(`${ok ? green('PASS') : red('FAIL')}  ${testCase.name}`);
  console.log(
    dim(
      `      recall ${hits.length}/${testCase.expectAny.length} (${(recall * 100).toFixed(0)}%) · ` +
      `first expected hit at rank ${firstHitRank === -1 ? '—' : firstHitRank + 1} · ` +
      `${cards.length} candidates`
    )
  );
  console.log(dim(`      top 8: ${slugs.slice(0, 8).join(', ')}`));

  if (testCase.pricing === 'free') {
    const paidInTop10 = cards.slice(0, 10).filter(c => c.pricing === 'paid').length;
    console.log(dim(`      paid tools in top 10 (want low): ${paidInTop10}`));
  }
  console.log();
}

console.log(`${passed}/${CASES.length} retrieval cases passed\n`);

await mongoose.disconnect();
process.exit(passed === CASES.length ? 0 : 1);
