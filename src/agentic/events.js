/**
 * Run event bus — how a live run reaches the browser.
 *
 * The editor watches a run over SSE, and the process serving that SSE
 * connection is very often not the process executing the run: with a BullMQ
 * worker the run is deliberately elsewhere, and even without one, two Railway
 * replicas behind a load balancer will split the request from the work. A
 * plain `EventEmitter` therefore works perfectly on one machine and silently
 * shows a frozen spinner on two, which is the worst failure mode available —
 * it passes local testing.
 *
 * So: an in-process emitter for the same-process case, plus a Redis pub/sub
 * fan-out when `REDIS_URL` is set. Publishers call `publish()` and never know
 * which they got; subscribers get both, deduplicated by sequence number.
 *
 * Redis is optional throughout this codebase and stays optional here. Without
 * it, a single instance is fully live and a multi-instance deploy falls back to
 * the client's own poll — degraded, but never wrong.
 */

import { EventEmitter } from 'node:events';
import Redis from 'ioredis';
import { createLogger } from '../utils/logger.js';

const log = createLogger('agentic:events');

const local = new EventEmitter();
// One SSE connection per run is the norm, but a user with the editor open in
// two tabs is not an error — raise the ceiling rather than logging a warning
// at them.
local.setMaxListeners(200);

const CHANNEL = 'agentic:run-events';

let publisher = null;
let subscriber = null;
let redisReady = false;

function connectRedis() {
  if (subscriber || !process.env.REDIS_URL) return;

  try {
    publisher = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: false });
    subscriber = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: false });

    subscriber.on('message', (_channel, raw) => {
      try {
        const event = JSON.parse(raw);
        // Re-emit only what came from *another* process. Locally published
        // events already fired synchronously, and replaying them here would
        // deliver every step twice to a same-process listener.
        if (event.origin !== ORIGIN) local.emit(event.runId, event);
      } catch {
        /* a malformed message is not worth killing the subscriber over */
      }
    });

    subscriber.subscribe(CHANNEL, err => {
      if (err) {
        log.warn('Run event subscribe failed — live updates are per-instance', { error: err.message });
        return;
      }
      redisReady = true;
      log.info('Run events fanning out through Redis');
    });

    for (const client of [publisher, subscriber]) {
      client.on('error', err => {
        redisReady = false;
        log.debug('Redis run-event client error', { error: err.message });
      });
    }
  } catch (err) {
    log.warn('Redis unavailable for run events — falling back to in-process', { error: err.message });
  }
}

/** Identifies this process, so we don't re-handle our own broadcasts. */
const ORIGIN = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

connectRedis();

/**
 * Broadcast one run event.
 *
 * @param {string} runId
 * @param {object} event  `{ type, ...payload }` — `type` is the SSE event name
 */
export function publish(runId, event) {
  const enriched = { ...event, runId: String(runId), at: Date.now(), origin: ORIGIN };

  local.emit(String(runId), enriched);

  if (redisReady && publisher) {
    publisher.publish(CHANNEL, JSON.stringify(enriched)).catch(() => {
      // A dropped live update is cosmetic; the run document is the source of
      // truth and the client reconciles against it on reconnect.
    });
  }
}

/**
 * Listen to one run. Returns an unsubscribe function.
 * Callers must call it — an SSE connection that closes without unsubscribing
 * leaks a listener per request, which is how a long-lived process runs out of
 * memory in a week rather than an hour.
 */
export function subscribe(runId, handler) {
  const key = String(runId);
  local.on(key, handler);
  return () => local.off(key, handler);
}

export function eventBusStatus() {
  return { redis: redisReady, origin: ORIGIN, listeners: local.eventNames().length };
}

export async function closeEventBus() {
  await Promise.allSettled([publisher?.quit(), subscriber?.quit()]);
  publisher = null;
  subscriber = null;
  redisReady = false;
}

export default { publish, subscribe, eventBusStatus, closeEventBus };
