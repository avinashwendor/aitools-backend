/**
 * LLM gateway.
 *
 * Everything that talks to the model goes through here so that timeouts,
 * retries, model fallback, JSON repair and token accounting are applied
 * uniformly instead of being re-invented at every call site.
 */

import OpenAI from 'openai';
import config from '../config/index.js';
import { createLogger } from '../utils/logger.js';
import { recordCall } from './telemetry.js';
import { recordLlmUsage } from '../billing/meterContext.js';

const log = createLogger('ai:llm');

/**
 * Provider chain.
 *
 * The OpenAI SDK speaks the wire format every major gateway implements, so one
 * client class covers OpenAI, Groq, OpenRouter, Together, a self-hosted vLLM —
 * only the base URL, key and model names differ.
 *
 * Each configured provider gets its own client. Requests walk the chain, so an
 * exhausted quota on provider 1 (which returns 429/401 for *every* model it
 * offers, defeating model-level fallback) transparently falls through to
 * provider 2.
 *
 * Base URLs must include the version path — the SDK appends only
 * `/chat/completions`, so `https://host/v1` is right and `https://host` is not.
 */
const providers = config.ai.providers.map(p => ({
  ...p,
  client: new OpenAI({
    apiKey: p.apiKey,
    baseURL: p.baseUrl,
    timeout: config.ai.timeoutMs,
    maxRetries: 0,
  }),
  /**
   * Set when a provider proves it is out of credit, so the rest of the request
   * — and subsequent requests — skip it instead of paying its latency again.
   * Cleared after a cool-off so a top-up recovers without a redeploy.
   */
  disabledUntil: 0,
}));

if (providers.length) {
  log.info('LLM provider chain ready', {
    chain: providers.map(p => `${p.name}(${p.plannerModel})`).join(' → '),
    reasoning: providers.map(p => `${p.name}(${p.reasoningModel})`).join(' → '),
  });
} else {
  log.warn('No AI provider configured — LLM calls will fail fast with AI_DISABLED');
}

/** How long a provider stays benched after it reports an exhausted quota. */
const QUOTA_COOLOFF_MS = 5 * 60 * 1000;

export const isLLMAvailable = () => providers.length > 0;

/**
 * Resolve a role to this provider's model list.
 *
 * Three tiers, and the split is by what breaks if you get it wrong rather than
 * by cost:
 *
 *   fast       classification and routing. A wrong answer costs one bad
 *              retrieval, so the cheapest model that can read is correct.
 *   planner    chat and workflow plans. Read by a person who can tell when
 *              they're wrong.
 *   reasoning  the architect and the agent node. These write programs that
 *              then run unattended against real APIs with the user's
 *              credentials, and a plausible-but-wrong answer here is not a
 *              worse paragraph — it is a workflow that posts the wrong thing
 *              to Slack every morning until someone notices. It gets the
 *              strongest model available, and the fallback chain is skipped:
 *              silently degrading a build to a small model produces exactly
 *              the invented-endpoint graphs this system was rebuilt to stop.
 */
function modelsFor(provider, role) {
  if (role === 'reasoning') {
    return [provider.reasoningModel || provider.plannerModel].filter(Boolean);
  }
  const primary = role === 'fast' ? provider.fastModel : provider.plannerModel;
  return [primary, ...provider.fallbackModels.filter(m => m !== primary)].filter(Boolean);
}

/**
 * A 429 means two very different things: "slow down" (retry helps) or
 * "you are out of credit" (retry never helps). Providers signal the latter in
 * the message rather than the status, so match on it and bench the provider.
 */
function isQuotaExhausted(err) {
  const text = `${err?.message || ''} ${JSON.stringify(err?.error ?? '')}`.toLowerCase();
  return /no credits|out of credits|insufficient|quota|exhausted|billing|top up|payment required/.test(text);
}

export class LLMError extends Error {
  constructor(message, { code = 'LLM_ERROR', status = 502, retryable = false } = {}) {
    super(message);
    this.name = 'LLMError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Errors worth retrying — transient network, rate limit, or upstream 5xx. */
function isRetryable(err) {
  const status = err?.status ?? err?.response?.status;
  if (status === 429) return true;
  if (status >= 500) return true;
  const code = err?.code || '';
  return ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'].includes(code);
}

/**
 * Strip the wrappers models habitually add around JSON
 * (```json fences, "Here is the JSON:", trailing prose) and balance braces.
 */
export function extractJson(raw) {
  if (!raw || typeof raw !== 'string') return null;

  let text = raw.trim();

  // Remove ```json ... ``` fences.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();

  const start = text.search(/[[{]/);
  if (start === -1) return null;

  const opener = text[start];
  const closer = opener === '{' ? '}' : ']';

  // Walk the string tracking string-literal state so braces inside strings
  // don't confuse the depth counter.
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === opener) depth++;
    else if (ch === closer) {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }

  let candidate = end !== -1 ? text.slice(start, end) : text.slice(start);

  try {
    return JSON.parse(candidate);
  } catch {
    // Repair pass: close unterminated strings/structures from a truncated
    // completion, and drop trailing commas.
    let repaired = candidate.replace(/,\s*([}\]])/g, '$1');

    const quotes = (repaired.match(/(?<!\\)"/g) || []).length;
    if (quotes % 2 !== 0) repaired += '"';

    const opens = (repaired.match(/[{[]/g) || []).length;
    const closes = (repaired.match(/[}\]]/g) || []).length;
    if (opens > closes) {
      // Close in the reverse order the structures were opened.
      const stack = [];
      let str = false, esc = false;
      for (const ch of repaired) {
        if (esc) { esc = false; continue; }
        if (ch === '\\') { esc = true; continue; }
        if (ch === '"') { str = !str; continue; }
        if (str) continue;
        if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
        else if (ch === '}' || ch === ']') stack.pop();
      }
      repaired += stack.reverse().join('');
    }

    repaired = repaired.replace(/,\s*([}\]])/g, '$1');

    try {
      return JSON.parse(repaired);
    } catch (err) {
      log.warn('JSON repair failed', { error: err.message, sample: candidate.slice(0, 160) });
      return null;
    }
  }
}

/**
 * Tool-call arguments, whatever shape the provider sent them in.
 *
 * The spec says a JSON string, and most providers comply. Some send an object
 * already parsed, and some send a truncated string when the model ran out of
 * tokens mid-call — which is why this goes through the same repair pass as
 * every other JSON response rather than a bare `JSON.parse`.
 */
function parseToolArguments(args) {
  if (args === null || args === undefined) return {};
  if (typeof args === 'object') return args;
  return extractJson(String(args)) ?? {};
}

/**
 * Chat completion with retry + model fallback.
 *
 * @param {object}  opts
 * @param {Array}   opts.messages       OpenAI-style message array
 * @param {string} [opts.role]          'fast' | 'planner' | 'reasoning'
 * @param {string} [opts.model]         primary model (defaults to the role's model)
 * @param {number} [opts.temperature]
 * @param {number} [opts.maxTokens]     0 or null sends no ceiling at all
 * @param {number} [opts.timeoutMs]     overrides the provider client's default
 * @param {boolean}[opts.json]          request a JSON object response
 * @param {Array}  [opts.tools]         OpenAI function-tool definitions
 * @param {string|object} [opts.toolChoice]
 * @param {string} [opts.task]          label used in telemetry
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{content, toolCalls, finishReason, model, usage, ms}>}
 */
export async function complete({
  messages,
  role = 'planner',
  model = null,
  temperature = config.ai.temperature,
  maxTokens,
  timeoutMs,
  json = false,
  tools = null,
  toolChoice = undefined,
  task = 'generic',
  signal,
} = {}) {
  // Resolved from the role rather than defaulted in the signature, so a caller
  // that asks for reasoning gets the agentic budget without having to know
  // there are two of them.
  const tokenCeiling = maxTokens === undefined
    ? (role === 'reasoning' ? config.ai.agenticMaxTokens : config.ai.maxTokens)
    : maxTokens;

  const callTimeout = timeoutMs
    ?? (role === 'reasoning' ? config.ai.agenticTimeoutMs : config.ai.timeoutMs);

  if (!providers.length) {
    throw new LLMError('AI is not configured on this server.', {
      code: 'AI_DISABLED',
      status: 503,
    });
  }

  const startedAt = Date.now();
  let lastError = null;
  let sawQuotaExhausted = false;
  let sawAuthFailure = false;
  const tried = [];

  for (const provider of providers) {
    if (provider.disabledUntil > Date.now()) {
      tried.push(`${provider.name}:benched`);
      continue;
    }

    // An explicit `model` override only makes sense on the provider that
    // actually offers it — the first one. Later providers use their own roles.
    const chain = model && provider === providers[0] ? [model] : modelsFor(provider, role);

    for (const candidateModel of chain) {
      for (let attempt = 0; attempt <= config.ai.maxRetries; attempt++) {
        try {
          const response = await provider.client.chat.completions.create(
            {
              messages,
              model: candidateModel,
              temperature,
              // Omitted entirely when there is no ceiling, rather than sent as
              // null: providers differ on whether null means "unlimited" or is
              // a 400, and absent means the model's own maximum everywhere.
              ...(tokenCeiling > 0 ? { max_tokens: tokenCeiling } : {}),
              top_p: 0.9,
              stream: false,
              // Some providers (e.g. Perplexity Sonar) only accept
              // json_schema/text and hard-400 on json_object.
              ...(json && !provider.noJsonMode
                ? { response_format: { type: 'json_object' } }
                : {}),
              // Tool definitions are only sent when there are any: a provider
              // that doesn't support them 400s on an empty array, which would
              // bench a perfectly healthy model for every tool-free call.
              ...(tools?.length ? { tools, ...(toolChoice ? { tool_choice: toolChoice } : {}) } : {}),
            },
            { signal, timeout: callTimeout }
          );

          const choice = response.choices?.[0];
          const content = choice?.message?.content ?? '';
          const ms = Date.now() - startedAt;

          recordCall({
            task,
            model: `${provider.name}/${candidateModel}`,
            ms,
            promptTokens: response.usage?.prompt_tokens ?? 0,
            completionTokens: response.usage?.completion_tokens ?? 0,
            ok: true,
          });

          // Attribute the spend to whichever user action is in flight. A no-op
          // outside a metered request (background jobs, the seeder, tests), so
          // no branch is needed here.
          recordLlmUsage({
            model: `${provider.name}/${candidateModel}`,
            promptTokens: response.usage?.prompt_tokens ?? 0,
            completionTokens: response.usage?.completion_tokens ?? 0,
          });

          if (tried.length) {
            log.warn('Served after failover', {
              task,
              used: `${provider.name}/${candidateModel}`,
              skipped: tried.join(', '),
            });
          }

          return {
            content,
            // Normalised here rather than at every call site, because providers
            // disagree about whether arguments arrive as a string or an object
            // and an agent loop that guesses wrong fails on its first tool call.
            toolCalls: (choice?.message?.tool_calls || []).map(call => ({
              id: call.id,
              name: call.function?.name,
              arguments: parseToolArguments(call.function?.arguments),
              raw: call,
            })),
            finishReason: choice?.finish_reason || 'stop',
            model: candidateModel,
            provider: provider.name,
            usage: response.usage ?? {},
            ms,
          };
        } catch (err) {
          lastError = err;

          // Some providers bill (and report usage on) a request that then
          // failed downstream — a content filter, a length stop, a 5xx after
          // generation. Those tokens are real money, so record them when they
          // are reported rather than letting failed calls look free.
          const failedUsage = err?.error?.usage || err?.response?.data?.usage;
          if (failedUsage?.prompt_tokens || failedUsage?.completion_tokens) {
            recordLlmUsage({
              model: `${provider.name}/${candidateModel}`,
              promptTokens: failedUsage.prompt_tokens ?? 0,
              completionTokens: failedUsage.completion_tokens ?? 0,
            });
          }

          if (signal?.aborted) {
            throw new LLMError('Request cancelled.', { code: 'ABORTED', status: 499 });
          }

          const status = err?.status ?? err?.response?.status;

          // Out of credit: every model here will fail identically. Bench the
          // whole provider and move on rather than grinding through its list.
          if (isQuotaExhausted(err)) {
            sawQuotaExhausted = true;
            provider.disabledUntil = Date.now() + QUOTA_COOLOFF_MS;
            log.error('Provider out of credit — benched', {
              provider: provider.name,
              coolOffMinutes: QUOTA_COOLOFF_MS / 60000,
              reason: String(err?.message || '').slice(0, 140),
            });
            tried.push(`${provider.name}:no-credit`);
            break;
          }

          // Bad key: same story — no model on this provider will work.
          if (status === 401 || status === 403) {
            sawAuthFailure = true;
            provider.disabledUntil = Date.now() + QUOTA_COOLOFF_MS;
            log.error('Provider rejected the API key — benched', { provider: provider.name });
            tried.push(`${provider.name}:auth`);
            break;
          }

          // Wrong model id for this account — try the provider's next model.
          if (status === 400 || status === 404) {
            log.warn('Model unavailable, falling through', {
              provider: provider.name, model: candidateModel, status,
            });
            break;
          }

          if (!isRetryable(err) || attempt === config.ai.maxRetries) break;

          // Honour the provider's own backpressure signal when it sends one;
          // guessing shorter than Retry-After just burns the next attempt too.
          const retryAfter = Number(
            err?.headers?.['retry-after'] ?? err?.response?.headers?.get?.('retry-after')
          );
          const backoff = Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1000, 10_000)
            : Math.min(2 ** attempt * 400 + Math.random() * 250, 4000);

          log.debug('Retrying LLM call', {
            provider: provider.name, task, model: candidateModel, attempt, backoff, status,
          });
          await sleep(backoff);
        }
      }

      // Provider benched mid-chain — stop working through its models.
      if (provider.disabledUntil > Date.now()) break;
    }
  }

  recordCall({ task, model: `chain/${role}`, ms: Date.now() - startedAt, ok: false });

  log.error('Every provider failed', {
    task,
    role,
    tried: tried.join(', ') || 'none',
    reason: String(lastError?.message || '').slice(0, 200),
  });

  // Distinguish "you need to top up" from "try again shortly" — they need
  // completely different actions from whoever runs the deployment.
  if (sawQuotaExhausted || sawAuthFailure) {
    throw new LLMError(
      'The AI service is unavailable — the configured provider credentials are ' +
      'out of credit or invalid. Please contact support.',
      { code: 'AI_QUOTA', status: 503, retryable: false }
    );
  }

  const status = lastError?.status ?? lastError?.response?.status;
  if (status === 429) {
    throw new LLMError('The AI service is busy. Please try again in a few seconds.', {
      code: 'RATE_LIMITED',
      status: 429,
      retryable: true,
    });
  }

  throw new LLMError(
    "I couldn't reach the AI service just now. Give it a moment and try again — " +
    'your workflow will pick up right where it left off.',
    { code: 'AI_UNAVAILABLE', status: 503, retryable: true }
  );
}

/** Provider health, for the /api/health/ai endpoint. */
export function getProviderStatus() {
  const now = Date.now();
  return providers.map(p => ({
    name: p.name,
    baseUrl: p.baseUrl,
    planner: p.plannerModel,
    fast: p.fastModel,
    reasoning: p.reasoningModel,
    available: p.disabledUntil <= now,
    benchedForSeconds: p.disabledUntil > now ? Math.round((p.disabledUntil - now) / 1000) : 0,
  }));
}

/**
 * Completion that must return JSON matching a shape.
 * Runs one self-correcting repair round-trip before giving up.
 *
 * @param {object} opts                 same as `complete`, plus:
 * @param {(value:any)=>string|null} [opts.validate]
 *        return an error string to trigger the repair round-trip, or null if valid
 */
export async function completeJson({ validate, ...opts }) {
  const first = await complete({ ...opts, json: true });
  let parsed = extractJson(first.content);

  let problem = null;
  if (!parsed) problem = 'The response was not valid JSON.';
  else if (validate) problem = validate(parsed);

  if (!problem) return { data: parsed, raw: first.content, model: first.model, usage: first.usage };

  log.warn('JSON output invalid — attempting self-repair', { task: opts.task, problem });

  const repair = await complete({
    ...opts,
    json: true,
    temperature: 0.1,
    messages: [
      ...opts.messages,
      { role: 'assistant', content: first.content.slice(0, 4000) },
      {
        role: 'user',
        content:
          `Your previous response was rejected: ${problem}\n\n` +
          `Return ONLY the corrected JSON object. No prose, no markdown fences.`,
      },
    ],
    task: `${opts.task || 'generic'}:repair`,
  });

  parsed = extractJson(repair.content);
  const stillBroken = !parsed ? 'not valid JSON' : validate ? validate(parsed) : null;

  if (stillBroken) {
    throw new LLMError(`AI returned an unusable response (${stillBroken}).`, {
      code: 'AI_BAD_OUTPUT',
      status: 502,
    });
  }

  return { data: parsed, raw: repair.content, model: repair.model, usage: repair.usage };
}

export default { complete, completeJson, extractJson, isLLMAvailable, LLMError };
