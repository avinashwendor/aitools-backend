/**
 * Probes candidate models with the EXACT request shape the engine sends
 * (temperature + max_tokens + JSON mode), so incompatibilities surface here
 * rather than as a runtime 400 on a user's first workflow.
 */

import dotenv from 'dotenv';
dotenv.config();

const baseURL = process.env.AI_BASE_URL;
const apiKey = process.env.AI_API_KEY;
const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };

const CANDIDATES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['gpt-4.1-mini', 'gpt-4.1', 'gpt-5.4-nano', 'gpt-5.4-mini', 'gpt-5.4', 'gpt-5-mini'];

async function probe(model) {
  const body = {
    model,
    messages: [
      { role: 'system', content: 'You output JSON only.' },
      { role: 'user', content: 'Return {"stages":[{"title":"Draft","tool":"x"}],"ok":true}' },
    ],
    temperature: 0.35,
    max_tokens: 200,
    response_format: { type: 'json_object' },
  };

  const started = Date.now();
  let res = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  let json = await res.json();
  const notes = [];

  // Newer reasoning models reject `max_tokens` and/or a non-default temperature.
  if (!res.ok && /max_tokens/.test(json?.error?.message || '')) {
    notes.push('needs max_completion_tokens');
    delete body.max_tokens;
    body.max_completion_tokens = 200;
    res = await fetch(`${baseURL}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) });
    json = await res.json();
  }
  if (!res.ok && /temperature/.test(json?.error?.message || '')) {
    notes.push('temperature must be default');
    delete body.temperature;
    res = await fetch(`${baseURL}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) });
    json = await res.json();
  }

  const ms = Date.now() - started;
  if (!res.ok) {
    return { model, ok: false, ms, note: (json?.error?.message || '').slice(0, 110) };
  }

  const content = json.choices?.[0]?.message?.content ?? '';
  let parses = false;
  try { JSON.parse(content); parses = true; } catch { /* not valid JSON */ }

  return {
    model,
    ok: true,
    ms,
    tokens: json.usage?.total_tokens ?? '?',
    parses,
    note: notes.join(' + ') || 'standard params OK',
  };
}

console.log(`provider: ${baseURL}\n`);
for (const m of CANDIDATES) {
  const r = await probe(m);
  console.log(
    `${r.ok ? '✓' : '✗'} ${m.padEnd(16)} ${String(r.ms).padStart(6)}ms  ` +
    `${r.ok ? `json:${r.parses ? 'yes' : 'NO '} tokens:${String(r.tokens).padEnd(5)}` : ''} ${r.note}`
  );
}
