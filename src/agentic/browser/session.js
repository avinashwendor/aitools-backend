/**
 * Browser session — one Chrome, one run.
 *
 * The reference implementation used Browserbase: a hosted browser with its own
 * SDK, its own billing, and its own model gateway. That is three vendors for
 * one capability, and none of their costs appear in our ledger. This connects
 * `playwright-core` to any CDP endpoint instead, which on Railway is the
 * Browserless v2 or Steel Browser template deployed as a private service. The
 * browser becomes a line item we control, on the platform everything else runs
 * on, and its cost lands in `UsageLedger` like every other cost.
 *
 * `playwright-core` rather than `playwright`: it ships no browser binaries, so
 * the backend image stays small and the deploy stays fast. We never launch a
 * browser locally — we attach to one over a socket.
 *
 * The session is opened lazily by the runner on the first browser node and held
 * for the whole run. That is not an optimisation: a login performed at step two
 * has to still hold at step nine, and a fresh browser per node would throw away
 * every cookie between them.
 */

import { chromium } from 'playwright-core';
import config from '../../config/index.js';
import { createLogger } from '../../utils/logger.js';
import { assertUrlAllowed } from '../safety.js';

const log = createLogger('agentic:browser');

export function isBrowserConfigured() {
  return Boolean(config.agentic.browser.wsEndpoint || config.agentic.browser.apiUrl);
}

/**
 * Ask a session-API browser (Steel, and Browserless's newer session endpoints)
 * for a dedicated session, and return the socket it hands back.
 *
 * Kept optional because the simple images don't have it: pointing
 * `AGENT_BROWSER_WS` straight at a Browserless container works with no session
 * call at all, and requiring one would rule that deployment out.
 */
async function openManagedSession() {
  const { apiUrl, apiToken, maxSessionMs } = config.agentic.browser;

  const response = await fetch(`${apiUrl.replace(/\/$/, '')}/v1/sessions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiToken ? { 'x-api-key': apiToken } : {}),
    },
    body: JSON.stringify({
      timeout: maxSessionMs,
      solveCaptcha: false,
      blockAds: true,
    }),
  });

  if (!response.ok) {
    throw new Error(`Browser service refused a session (${response.status})`);
  }

  const session = await response.json();
  const ws = session.websocketUrl || session.wsEndpoint || session.connectUrl;
  if (!ws) throw new Error('Browser service returned no websocket URL');

  return { ws, sessionId: session.id || session.sessionId || null };
}

/**
 * An open browser, plus the bookkeeping the runner and the ledger need.
 *
 * Deliberately a small hand-rolled object rather than a class hierarchy: the
 * only thing anyone does with it is `page()`, `screenshot()` and `close()`, and
 * the elapsed-seconds counter that makes it billable.
 */
export async function openSession({ onLog = () => {} } = {}) {
  if (!isBrowserConfigured()) {
    const err = new Error(
      'Browser automation is not configured on this server. Set AGENT_BROWSER_WS to your Railway browser service.'
    );
    err.code = 'BROWSER_NOT_CONFIGURED';
    err.status = 503;
    throw err;
  }

  const startedAt = Date.now();
  const { wsEndpoint, apiUrl, maxSessionMs, timeoutMs, viewport } = config.agentic.browser;

  let ws = wsEndpoint;
  let sessionId = null;
  if (apiUrl) {
    const managed = await openManagedSession();
    ws = managed.ws;
    sessionId = managed.sessionId;
  }

  log.debug('Connecting to browser service', { managed: Boolean(apiUrl) });
  const browser = await chromium.connectOverCDP(ws, { timeout: timeoutMs });

  // A CDP attach lands in whatever context the remote browser already has.
  // Reusing it (rather than always calling newContext) is what keeps
  // Browserless's single-context images working, while still creating one when
  // the browser starts empty.
  const context = browser.contexts()[0] || (await browser.newContext({ viewport }));
  context.setDefaultTimeout(timeoutMs);
  context.setDefaultNavigationTimeout(timeoutMs);

  const firstPage = context.pages()[0] || (await context.newPage());

  let closed = false;

  /**
   * The page the run is driving.
   *
   * Always the *last* page in the context, not a page captured at open time:
   * clicking a `target="_blank"` link opens a new tab, and a run that keeps
   * driving the original one silently operates on a page the user isn't
   * looking at — which reads as "the agent stopped working" with no error.
   */
  const page = () => {
    const pages = context.pages();
    return pages[pages.length - 1] || firstPage;
  };

  // A hung page is the expensive failure: it bills wall-clock forever while
  // producing nothing. The runner also has its own ceiling, but this one closes
  // the socket even if the runner itself is wedged.
  const guard = setTimeout(() => {
    if (closed) return;
    log.warn('Browser session exceeded its ceiling — closing', { maxSessionMs });
    onLog({ level: 'warn', message: `Browser session hit the ${Math.round(maxSessionMs / 1000)}s ceiling and was closed.` });
    browser.close().catch(() => {});
    closed = true;
  }, maxSessionMs);
  guard.unref?.();

  return {
    sessionId,
    page,
    context,

    /** Navigate with the shared safety check applied. */
    async goto(url, { waitUntil = 'load' } = {}) {
      assertUrlAllowed(url);
      const target = page();
      await target.goto(url, { waitUntil, timeout: timeoutMs });
      return { url: target.url(), title: await target.title().catch(() => '') };
    },

    /** A base64 data URL, small enough to store inline on the run document. */
    async screenshot({ fullPage = false } = {}) {
      const buffer = await page().screenshot({
        fullPage,
        type: 'jpeg',
        quality: 60,
        timeout: timeoutMs,
      });
      return `data:image/jpeg;base64,${buffer.toString('base64')}`;
    },

    /** Seconds held so far — the billable quantity, readable mid-run. */
    elapsedSeconds() {
      return Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    },

    async close() {
      if (closed) return;
      closed = true;
      clearTimeout(guard);
      // Close the browser handle, not the context: on a shared Browserless
      // container closing the context can take the whole instance down for the
      // next tenant. Disconnecting is the polite operation.
      await browser.close().catch(err => {
        log.warn('Browser close failed', { error: err.message });
      });
    },
  };
}

export default { openSession, isBrowserConfigured };
