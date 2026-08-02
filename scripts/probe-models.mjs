/**
 * Verifies the configured AI provider: lists models, then probes each one with
 * a tiny completion so you know which ids actually serve traffic (providers
 * routinely advertise models they don't route).
 *
 *   npm run check:models          # probe every advertised model
 *   npm run check:models -- fast  # only probe the two configured models
 */

import dotenv from 'dotenv';
dotenv.config();

const baseURL = process.env.AI_BASE_URL || 'https://api.groq.com/openai/v1';
const apiKey = process.env.AI_API_KEY || process.env.GROQ_API_KEY;

if (!apiKey) {
  console.error('✖ No AI_API_KEY (or GROQ_API_KEY) in backend/.env');
  process.exit(1);
}

const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
const fastOnly = process.argv.includes('fast');

console.log(`→ provider: ${baseURL}\n`);

// ─── 1. advertised models ────────────────────────────────────
let models = [];
try {
  const res = await fetch(`${baseURL}/models`, { headers });
  const body = await res.json();
  if (!res.ok) {
    console.error(`✖ /models returned ${res.status}:`, JSON.stringify(body).slice(0, 300));
    process.exit(1);
  }
  models = (body.data || []).map(m => m.id).sort();
  console.log(`  ${models.length} models advertised\n`);
} catch (err) {
  console.error('✖ could not reach provider:', err.message);
  process.exit(1);
}

const configured = [
  process.env.AI_MODEL_PLANNER,
  process.env.AI_MODEL_FAST,
  ...(process.env.AI_MODEL_FALLBACKS || '').split(',').map(s => s.trim()),
].filter(Boolean);

const targets = fastOnly ? [...new Set(configured)] : models;

// ─── 2. probe each ───────────────────────────────────────────
async function probe(model) {
  const started = Date.now();
  try {
    const res = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with exactly: pong' }],
        max_tokens: 16,
      }),
    });

    const ms = Date.now() - started;
    const text = await res.text();

    if (!res.ok) {
      // Some gateways answer with an HTML error page — don't dump it.
      const detail = text.trimStart().startsWith('<') ? 'HTML error page' : text.slice(0, 90);
      return { model, ok: false, ms, note: `${res.status} ${detail}` };
    }

    const body = JSON.parse(text);
    const content = (body.choices?.[0]?.message?.content ?? '').trim();
    return { model, ok: true, ms, note: content.slice(0, 40) || '(empty)' };
  } catch (err) {
    return { model, ok: false, ms: Date.now() - started, note: err.message.slice(0, 60) };
  }
}

const results = [];
for (const model of targets) {
  const r = await probe(model);
  results.push(r);
  const mark = r.ok ? '✓' : '✗';
  const badge = configured.includes(model) ? ' (configured)' : '';
  console.log(`  ${mark} ${model.padEnd(24)} ${String(r.ms).padStart(6)}ms  ${r.note}${badge}`);
}

// ─── 3. verdict ──────────────────────────────────────────────
const working = results.filter(r => r.ok).map(r => r.model);
const brokenConfigured = configured.filter(m => !working.includes(m));

console.log(`\n  ${working.length}/${results.length} models responded.`);

if (brokenConfigured.length) {
  console.log(`\n✖ These are set in .env but do NOT work: ${brokenConfigured.join(', ')}`);
  if (working.length) {
    const fastest = results.filter(r => r.ok).sort((a, b) => a.ms - b.ms)[0];
    console.log(`  Suggested AI_MODEL_FAST=${fastest.model} (fastest working)`);
    console.log(`  Working ids: ${working.join(', ')}`);
  }
  process.exit(1);
}

console.log('✓ every configured model is reachable.');
