/**
 * Verifies every provider in the AI_PROVIDERS failover chain.
 *
 * For each one it authenticates, then sends a real JSON-mode completion using
 * that provider's own planner and fast models — the same request shape the
 * workflow engine sends. Run it after changing keys or before a deploy.
 *
 *   npm run check:providers
 */

import dotenv from 'dotenv';
dotenv.config();

import config from '../src/config/index.js';

const providers = config.ai.providers;

if (!providers.length) {
  console.error('✖ No providers configured. Set AI_PROVIDERS (or AI_API_KEY) in backend/.env');
  process.exit(1);
}

const PLACEHOLDER = /^(REPLACE|YOUR|CHANGE|TODO)/i;

async function callModel(provider, model) {
  const started = Date.now();
  try {
    const res = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'You output JSON only.' },
          { role: 'user', content: 'Return exactly {"ok":true}' },
        ],
        temperature: 0.35,
        max_tokens: 64,
        ...(provider.noJsonMode ? {} : { response_format: { type: 'json_object' } }),
      }),
      signal: AbortSignal.timeout(40000),
    });

    const ms = Date.now() - started;
    const body = await res.json().catch(() => ({}));

    if (!res.ok || body.error) {
      const msg = (body.error?.message || `HTTP ${res.status}`).replace(/\s+/g, ' ');
      return { ok: false, ms, status: res.status, msg: msg.slice(0, 90) };
    }

    const content = body.choices?.[0]?.message?.content ?? '';
    let parses = false;
    try { JSON.parse(content); parses = true; } catch { /* not JSON */ }

    return { ok: true, ms, parses, tokens: body.usage?.total_tokens ?? '?' };
  } catch (err) {
    return { ok: false, ms: Date.now() - started, msg: err.message.slice(0, 90) };
  }
}

console.log(`\nAI provider chain — ${providers.length} configured\n${'═'.repeat(76)}`);

let healthy = 0;

for (const [i, provider] of providers.entries()) {
  console.log(`\n${i + 1}. ${provider.name}  ${provider.baseUrl}`);

  if (!provider.apiKey || PLACEHOLDER.test(provider.apiKey)) {
    console.log('   ⊘ no key set — this provider is a placeholder and will be skipped at runtime');
    continue;
  }

  let providerOk = false;

  for (const [label, model] of [['planner', provider.plannerModel], ['fast', provider.fastModel]]) {
    if (!model) continue;
    const r = await callModel(provider, model);

    if (r.ok) {
      providerOk = true;
      const jsonNote = r.parses ? 'json ok' : 'JSON NOT PARSEABLE';
      console.log(`   ✓ ${label.padEnd(7)} ${model.padEnd(36)} ${String(r.ms).padStart(5)}ms  ${r.tokens} tok  ${jsonNote}`);
    } else {
      console.log(`   ✗ ${label.padEnd(7)} ${model.padEnd(36)} ${String(r.ms).padStart(5)}ms  ${r.msg}`);
    }
  }

  if (providerOk) healthy++;
}

console.log(`\n${'═'.repeat(76)}`);
if (healthy === 0) {
  console.log('✖ NO working provider. The assistant will return AI_QUOTA errors.\n');
  process.exit(1);
}
console.log(`✓ ${healthy} of ${providers.length} providers healthy — failover has somewhere to go.\n`);
