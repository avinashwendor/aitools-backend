/**
 * Probes OpenRouter models with the exact request shape the engine sends
 * (temperature + max_tokens + JSON mode), and reports latency, token cost
 * and whether the reply actually parses as JSON.
 *
 *   node scripts/probe-openrouter.mjs [model ...]
 */

const KEY = process.env.OPENROUTER_API_KEY || process.argv.find(a => a.startsWith('sk-or-'));
const BASE = 'https://openrouter.ai/api/v1';

if (!KEY) { console.error('Pass an sk-or-… key or set OPENROUTER_API_KEY'); process.exit(1); }

const MODELS = process.argv.slice(2).filter(a => !a.startsWith('sk-or-'));
const CANDIDATES = MODELS.length ? MODELS : [
  'openai/gpt-4o-mini',
  'openai/gpt-4.1-mini',
  'anthropic/claude-3.5-haiku',
  'google/gemini-2.0-flash-001',
  'meta-llama/llama-3.3-70b-instruct',
  'perplexity/sonar',
  'perplexity/sonar-pro',
];

const headers = {
  Authorization: `Bearer ${KEY}`,
  'Content-Type': 'application/json',
  'HTTP-Referer': 'http://localhost:5174',
  'X-Title': 'AI Tools Workflow Studio',
};

// Mirrors a real planner call: JSON mode, a schema-ish instruction, short output.
const payload = model => ({
  model,
  messages: [
    { role: 'system', content: 'You are a workflow planner. Output JSON only.' },
    { role: 'user', content: 'Return exactly {"stages":[{"title":"Research","tool":"perplexity"},{"title":"Draft","tool":"claude"}],"ok":true}' },
  ],
  temperature: 0.35,
  max_tokens: 300,
  response_format: { type: 'json_object' },
});

console.log(`provider: ${BASE}\n`);
console.log('model                              status   latency  tokens  json   note');
console.log('─'.repeat(96));

for (const model of CANDIDATES) {
  const started = Date.now();
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload(model)),
      signal: AbortSignal.timeout(60000),
    });
    const ms = Date.now() - started;
    const body = await res.json();

    if (!res.ok || body.error) {
      const msg = (body.error?.message || JSON.stringify(body)).replace(/\s+/g, ' ').slice(0, 40);
      console.log(`${model.padEnd(34)} ${String(res.status).padEnd(8)} ${String(ms + 'ms').padEnd(8)} ${'-'.padEnd(7)} ${'-'.padEnd(6)} ${msg}`);
      continue;
    }

    const content = body.choices?.[0]?.message?.content ?? '';
    let parses = false;
    try { JSON.parse(content); parses = true; } catch { /* not JSON */ }

    const tokens = body.usage?.total_tokens ?? '?';
    console.log(
      `${model.padEnd(34)} ${'200'.padEnd(8)} ${String(ms + 'ms').padEnd(8)} ` +
      `${String(tokens).padEnd(7)} ${(parses ? 'yes' : 'NO').padEnd(6)} ${content.replace(/\s+/g, ' ').slice(0, 34)}`
    );
  } catch (err) {
    console.log(`${model.padEnd(34)} ${'ERR'.padEnd(8)} ${String(Date.now() - started + 'ms').padEnd(8)} ${'-'.padEnd(7)} ${'-'.padEnd(6)} ${err.message.slice(0, 40)}`);
  }
}
