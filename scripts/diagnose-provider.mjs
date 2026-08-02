/**
 * Provider diagnosis: shows the raw HTTP status and body for /models and a
 * minimal completion, across every candidate base URL. Use this when the app
 * reports "AI service is busy" and you need to know whether that is a real
 * rate limit, an exhausted quota, a bad model id, or the wrong host.
 *
 *   node scripts/diagnose-provider.mjs
 */

import dotenv from 'dotenv';
dotenv.config();

const KEY = process.env.AI_API_KEY;
const BASES = [
  process.env.AI_BASE_URL,
  'https://omega.kesarcloud.in/v1',
  'https://api.omegaplusapi.com/v1',
].filter((v, i, a) => v && a.indexOf(v) === i);

if (!KEY) { console.error('No AI_API_KEY in .env'); process.exit(1); }

const headers = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const short = s => String(s).replace(/\s+/g, ' ').slice(0, 220);

for (const base of BASES) {
  console.log(`\n${'='.repeat(70)}\n${base}\n${'='.repeat(70)}`);

  // ── /models ──
  let models = [];
  try {
    const res = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(20000) });
    const text = await res.text();
    console.log(`GET /models -> ${res.status}`);
    try {
      const j = JSON.parse(text);
      models = (j.data || []).map(m => m.id);
      if (models.length) {
        console.log(`  ${models.length} models: ${models.slice(0, 25).join(', ')}${models.length > 25 ? ' …' : ''}`);
      } else {
        console.log(`  body: ${short(text)}`);
      }
    } catch { console.log(`  body: ${short(text)}`); }
  } catch (err) {
    console.log(`GET /models -> network error: ${err.message}`);
    continue;
  }

  // ── completion, on models this host actually advertises ──
  const targets = models.length
    ? models.slice(0, 3)
    : [process.env.AI_MODEL_PLANNER].filter(Boolean);

  for (const model of targets) {
    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'Say: pong' }],
          max_tokens: 16,
        }),
        signal: AbortSignal.timeout(30000),
      });
      const text = await res.text();
      let out = short(text);
      try {
        const j = JSON.parse(text);
        if (j.choices?.[0]?.message?.content !== undefined) {
          out = `content="${j.choices[0].message.content}" tokens=${j.usage?.total_tokens ?? '?'}`;
        } else if (j.error) {
          out = `error: ${short(j.error.message || JSON.stringify(j.error))}`;
        }
      } catch { /* keep raw text */ }
      console.log(`POST /chat/completions [${model}] -> ${res.status}  ${out}`);
    } catch (err) {
      console.log(`POST /chat/completions [${model}] -> network error: ${err.message}`);
    }
  }
}
