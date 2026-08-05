/**
 * Retrying the failures that are not really failures.
 *
 * A workflow is a program made of network calls to other people's servers, and
 * those servers rate-limit, restart, and drop connections. Without this, every
 * one of those events is a dead run: the step throws, the walk stops, the user
 * sees "fetch failed", and the only remedy on offer is to press Run again and
 * pay for the steps that already succeeded. A 429 from an API that told us
 * exactly how long to wait is the clearest possible case of a failure the
 * machine should handle and the human should never see.
 *
 * The hard part is not the backoff, it is knowing what may be retried.
 *
 * **Only failures that left the world unchanged.** A POST that timed out may
 * have been received and acted on; retrying it sends the message twice, and a
 * duplicate email is worse than a failed run because it cannot be taken back.
 * So retryability is not a property of the error alone — it is a property of
 * the error *and* the operation. `classifyFailure` answers "did this request
 * reach the server?", and the caller decides whether reaching it twice is safe.
 * Connection-establishment errors are the useful case: `ENOTFOUND`, a refused
 * connection or a connect timeout all mean nothing was sent, which makes them
 * safe to retry even for a POST.
 *
 * **A cancel is not a failure.** The run signal aborting means the user pressed
 * Stop, and retrying through that would ignore them and keep spending.
 */

import { withTimeout, sleep, TimeoutError } from '../utils/deadline.js';

/** Error codes meaning the connection was never established. Safe for any method. */
const NEVER_SENT = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'UND_ERR_CONNECT_TIMEOUT',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
]);

/** Codes meaning the connection dropped, possibly after the server acted on it. */
const IN_FLIGHT = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/** Status codes worth another attempt. 408 and 425 are the server asking for one. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 522, 524]);

/**
 * `Retry-After` in either of its two legal forms: delta-seconds, or an HTTP
 * date. Honouring it is the difference between backing off and being banned —
 * a service that says "wait 30s" and gets three more requests inside a second
 * is entitled to treat us as abuse.
 */
export function parseRetryAfter(header, now = Date.now()) {
  if (!header) return null;
  const seconds = Number(String(header).trim());
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(String(header));
  if (Number.isFinite(at)) return Math.max(0, at - now);
  return null;
}

/**
 * What kind of failure this is.
 *
 * @returns {{retryable: boolean, sent: boolean, reason: string, retryAfterMs: number|null}}
 *   `sent` is whether the request may have reached the far end — the flag that
 *   decides whether a non-idempotent operation may be repeated.
 */
export function classifyFailure(err) {
  const no = { retryable: false, sent: true, reason: 'permanent', retryAfterMs: null };
  if (!err) return no;

  // Deliberate stops are never retried: an aborted run is a user decision, and
  // an already-retried error has had its chances.
  if (err.name === 'AbortError' && !err.timedOut) return { ...no, reason: 'aborted' };
  if (err.retried) return { ...no, reason: 'exhausted' };

  if (err.timedOut || err.code === 'STEP_TIMEOUT') {
    return { retryable: true, sent: true, reason: 'timeout', retryAfterMs: null };
  }

  const status = Number(err.status ?? err.statusCode);
  if (Number.isFinite(status) && RETRYABLE_STATUS.has(status)) {
    return {
      retryable: true,
      // A rate limit is the server declining to act. Nothing happened, so even
      // a POST may be sent again — which is the case that matters, because
      // rate limits are what a workflow hits when it finally starts working.
      sent: status !== 429 && status !== 503,
      reason: `http ${status}`,
      retryAfterMs: parseRetryAfter(err.retryAfter),
    };
  }

  // `fetch` wraps the real cause; the code that tells us anything is underneath.
  const code = err.code || err.cause?.code || '';
  if (NEVER_SENT.has(code)) {
    return { retryable: true, sent: false, reason: code, retryAfterMs: null };
  }
  if (IN_FLIGHT.has(code)) {
    return { retryable: true, sent: true, reason: code, retryAfterMs: null };
  }

  return no;
}

/**
 * Backoff with jitter.
 *
 * Jitter is not a nicety here. Workflows are scheduled, so a hundred of them
 * wake on the same cron minute and hit the same API; if they all back off by
 * exactly 1s, 2s, 4s they stay in lockstep and keep colliding for as long as
 * they keep retrying. Spreading each delay across a window breaks the convoy.
 */
export function backoffMs(attempt, base = 500, cap = 20_000) {
  const exponential = Math.min(cap, base * 2 ** (attempt - 1));
  return Math.round(exponential / 2 + Math.random() * (exponential / 2));
}

/**
 * Run `fn`, retrying transient failures.
 *
 * @param {(attempt: number) => Promise<any>} fn
 * @param {object} opts
 * @param {number} [opts.attempts]      total attempts including the first
 * @param {boolean} [opts.idempotent]   may the operation be repeated after it
 *                                      reached the server? Defaults to false,
 *                                      because assuming a thing can be redone
 *                                      is how a workflow sends two emails.
 * @param {AbortSignal} [opts.signal]
 * @param {(info: {attempt, delayMs, reason, error}) => void} [opts.onRetry]
 */
export async function withRetry(fn, { attempts = 3, idempotent = false, signal, onRetry } = {}) {
  let lastError;

  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      const verdict = classifyFailure(err);

      const mayRepeat = verdict.retryable && (idempotent || !verdict.sent);
      if (!mayRepeat || attempt >= attempts || signal?.aborted) {
        // Marked so a retry wrapper further out doesn't start the whole schedule
        // again — three attempts nested inside three is nine, and nobody chose
        // that number.
        if (verdict.retryable) err.retried = true;
        throw err;
      }

      const delayMs = verdict.retryAfterMs ?? backoffMs(attempt);
      onRetry?.({ attempt, delayMs, reason: verdict.reason, error: err });
      await sleep(delayMs, signal);
    }
  }

  throw lastError;
}

/*
 * Re-exported so a caller that retries also gets the deadline that makes retry
 * meaningful: without one, the first attempt hangs and there is never a second.
 */
export { withTimeout, sleep, TimeoutError };

export default { classifyFailure, withRetry, withTimeout, backoffMs, parseRetryAfter, TimeoutError };
