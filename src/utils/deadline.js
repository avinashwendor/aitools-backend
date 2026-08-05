/**
 * Giving one piece of work its own clock.
 *
 * Lives in `utils` rather than next to either caller because both the workflow
 * runner and the agent loop need exactly this, and the tricky part is not the
 * timer — it is telling a timeout apart from a cancel. They arrive as the same
 * `AbortError`, and confusing them is how a run the user stopped gets reported
 * as "the step timed out", or worse, retried.
 */

export class TimeoutError extends Error {
  constructor(ms, what = 'step') {
    super(`This ${what} took longer than ${Math.round(ms / 1000)}s and was stopped.`);
    this.name = 'TimeoutError';
    this.code = 'STEP_TIMEOUT';
    /** Read by the retry classifier: a timeout may be retried, a cancel may not. */
    this.timedOut = true;
  }
}

/** A sleep a cancelled operation interrupts rather than sitting through. */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Run canceled'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('Run canceled'));
      },
      { once: true }
    );
  });
}

/**
 * Run `fn` with a deadline, handing it a signal chained to the caller's.
 *
 * Chained, not replaced: work that stops responding to a cancel because it was
 * given a private signal is worse than work with no deadline at all.
 *
 * @param {(signal: AbortSignal) => Promise<any>} fn
 * @param {object} opts
 * @param {number} opts.ms          deadline; 0 or absent means no deadline
 * @param {AbortSignal} [opts.signal]
 * @param {string} [opts.what]      named in the error the user reads
 */
export async function withTimeout(fn, { ms, signal, what = 'step' } = {}) {
  if (!ms || ms <= 0) return fn(signal);

  const timer = new AbortController();
  const combined = signal ? AbortSignal.any([signal, timer.signal]) : timer.signal;

  let fire;
  /*
   * A race, not just an abort.
   *
   * Aborting alone would be enough if every callee honoured its signal, and
   * most do — `fetch` does. But a deadline that only works for well-behaved
   * work is not a deadline: one tool that ignores the signal, or one promise
   * that never settles either way, and we wait forever having *also* told the
   * caller we wouldn't. The signal is still passed so cooperative work stops
   * doing real damage; the race is what guarantees we return.
   */
  const expiry = new Promise((_resolve, reject) => {
    fire = setTimeout(() => {
      timer.abort();
      reject(new TimeoutError(ms, what));
    }, ms);
  });

  const work = Promise.resolve()
    .then(() => fn(combined))
    // The loser of the race is abandoned, and an abandoned promise that later
    // rejects takes the process down as an unhandled rejection. Attaching this
    // now means the failure is already claimed by the time it arrives.
    .catch(err => {
      if (timer.signal.aborted && !signal?.aborted) throw new TimeoutError(ms, what);
      throw err;
    });
  work.catch(() => {});

  try {
    return await Promise.race([work, expiry]);
  } finally {
    clearTimeout(fire);
  }
}

export default { withTimeout, sleep, TimeoutError };
