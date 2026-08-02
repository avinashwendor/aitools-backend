/**
 * AI telemetry, backed by Redis (see `utils/redis.js`).
 *
 * Tracks per-task latency percentiles, token spend and error rate so
 * /api/health/ai can answer "is the assistant healthy and what is it costing"
 * without wiring up an external APM. Previously an in-process Map, which
 * reset on every deploy and gave each Railway instance its own partial view —
 * Redis makes the numbers reflect the whole fleet.
 */

import { getRedis } from '../utils/redis.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('ai:telemetry');

const MAX_SAMPLES = 200;
const NS = 'telemetry';
const TASKS_SET = `${NS}:tasks`;
const TOTAL_CALLS_KEY = `${NS}:totalCalls`;
const TOTAL_ERRORS_KEY = `${NS}:totalErrors`;

const startedAt = Date.now();

/**
 * Fire-and-forget from the caller's perspective (never awaited at the call
 * site in `llm.js`), so a Redis hiccup must never surface as an unhandled
 * rejection or add latency to the model call it's recording.
 */
export async function recordCall({ task = 'generic', model, ms = 0, promptTokens = 0, completionTokens = 0, ok = true }) {
  try {
    const redis = getRedis();
    const taskKey = `${NS}:task:${task}`;

    await redis.sadd(TASKS_SET, task);
    await redis.hincrby(taskKey, 'calls', 1);
    if (!ok) await redis.hincrby(taskKey, 'errors', 1);
    await redis.hincrby(taskKey, 'promptTokens', promptTokens);
    await redis.hincrby(taskKey, 'completionTokens', completionTokens);
    await redis.rpush(`${taskKey}:samples`, String(ms));
    await redis.ltrim(`${taskKey}:samples`, -MAX_SAMPLES, -1);
    if (model) await redis.hincrby(`${taskKey}:models`, model, 1);

    await redis.incr(TOTAL_CALLS_KEY);
    if (!ok) await redis.incr(TOTAL_ERRORS_KEY);
  } catch (err) {
    log.warn('Failed to record telemetry', { task, error: err.message });
  }

  log.debug('llm call', { task, model, ms, promptTokens, completionTokens, ok });
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

export async function getStats() {
  const redis = getRedis();
  const taskNames = await redis.smembers(TASKS_SET);

  const tasks = {};
  for (const task of taskNames) {
    const taskKey = `${NS}:task:${task}`;
    const [hash, modelHash, samples] = await Promise.all([
      redis.hgetall(taskKey),
      redis.hgetall(`${taskKey}:models`),
      redis.lrange(`${taskKey}:samples`, 0, -1),
    ]);

    const calls = Number(hash.calls) || 0;
    const errors = Number(hash.errors) || 0;
    const promptTokens = Number(hash.promptTokens) || 0;
    const completionTokens = Number(hash.completionTokens) || 0;
    const sorted = samples.map(Number).sort((a, z) => a - z);

    tasks[task] = {
      calls,
      errors,
      errorRate: calls ? +(errors / calls).toFixed(3) : 0,
      latencyMs: {
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        max: sorted.at(-1) ?? 0,
      },
      tokens: {
        prompt: promptTokens,
        completion: completionTokens,
        total: promptTokens + completionTokens,
      },
      models: Object.fromEntries(Object.entries(modelHash).map(([m, c]) => [m, Number(c)])),
    };
  }

  const [totalCallsRaw, totalErrorsRaw] = await Promise.all([
    redis.get(TOTAL_CALLS_KEY),
    redis.get(TOTAL_ERRORS_KEY),
  ]);
  const totalCalls = Number(totalCallsRaw) || 0;
  const totalErrors = Number(totalErrorsRaw) || 0;

  return {
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    totalCalls,
    totalErrors,
    errorRate: totalCalls ? +(totalErrors / totalCalls).toFixed(3) : 0,
    tasks,
  };
}

export async function resetStats() {
  const redis = getRedis();
  const keys = await redis.keys(`${NS}:*`);
  await Promise.all(keys.map(k => redis.del(k)));
}

export default { recordCall, getStats, resetStats };
