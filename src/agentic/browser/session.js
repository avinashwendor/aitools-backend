/**
 * Browser session — one Chrome, one run.
 *
 * Two providers behind one interface, because the right answer depends on
 * volume rather than on taste:
 *
 *   **browserbase** — a hosted browser API. Billed per session-minute used and
 *   nothing when idle, which suits browser workflows because they are bursty:
 *   a workflow that runs four times a day would otherwise pay for a container
 *   sitting empty for twenty-three and a half hours. It also returns a live
 *   view URL and a recording, so a run that misbehaved can be watched back.
 *
 *   **cdp** — a Chrome you host (Browserless or Steel on Railway, or a local
 *   Chrome with --remote-debugging-port). Cheaper once you're running enough
 *   sessions to keep a container busy, and the only option if pages must stay
 *   inside your own network. No recording, and it bills around the clock.
 *
 * Both end at the same place: `playwright-core` attached over CDP. Nothing
 * downstream — not the executors, not the primitives — knows which one it got.
 * `playwright-core` rather than `playwright` because we never launch a browser
 * locally, so shipping ~400MB of browser binaries in the image would be pure
 * deploy latency.
 *
 * The session is opened lazily by the runner on the first browser node and held
 * for the whole run. That is not an optimisation: a login performed at step two
 * has to still hold at step nine.
 */

import Browserbase from '@browserbasehq/sdk';
import config from '../../config/index.js';
import { createLogger } from '../../utils/logger.js';
import { assertUrlAllowed } from '../safety.js';

const log = createLogger('agentic:browser');

let browserbaseClient = null;
let chromiumPromise = null;

async function getChromium() {
  if (!chromiumPromise) {
    chromiumPromise = import('playwright-core').then(mod => mod.chromium);
  }
  return chromiumPromise;
}

/** Lazily built so a deployment without Browserbase never constructs one. */
export function getBrowserbase() {
  const { apiKey } = config.agentic.browser.browserbase;
  if (!apiKey) return null;
  if (!browserbaseClient) browserbaseClient = new Browserbase({ apiKey });
  return browserbaseClient;
}

/**
 * Which provider this deployment will use.
 *
 * Resolved from what's configured rather than requiring a declaration, so a
 * checkout with a Browserbase key just works. `AGENT_BROWSER_PROVIDER` forces
 * one when both are present — useful for testing the self-hosted path without
 * unsetting the key.
 */
export function resolveProvider() {
  const { provider, browserbase, wsEndpoint, apiUrl } = config.agentic.browser;
  const hasBrowserbase = Boolean(browserbase.apiKey);
  const hasCdp = Boolean(wsEndpoint || apiUrl);

  if (provider === 'browserbase') return hasBrowserbase ? 'browserbase' : null;
  if (provider === 'cdp') return hasCdp ? 'cdp' : null;

  // Hosted first: it costs nothing when unused, so a deployment carrying both
  // configs is almost always mid-migration towards the hosted one.
  if (hasBrowserbase) return 'browserbase';
  if (hasCdp) return 'cdp';
  return null;
}

export function isBrowserConfigured() {
  return resolveProvider() !== null;
}

/** What the registry endpoint reports, so the editor can explain itself. */
export function browserCapabilities() {
  const provider = resolveProvider();
  return {
    configured: provider !== null,
    provider,
    // Only the hosted provider can show a run as it happens or play it back.
    liveView: provider === 'browserbase',
    replay: provider === 'browserbase',
  };
}

// ─── Provider: Browserbase ──────────────────────────────────

async function openBrowserbaseSession() {
  const bb = getBrowserbase();
  const { projectId, region, blockAds, stealth } = config.agentic.browser.browserbase;
  const { maxSessionMs, viewport } = config.agentic.browser;

  if (!projectId) {
    const err = new Error(
      'BROWSERBASE_PROJECT_ID is not set. Sessions created without it are billed to no project and are invisible in the dashboard.'
    );
    err.code = 'BROWSER_NOT_CONFIGURED';
    err.status = 503;
    throw err;
  }

  const session = await bb.sessions.create({
    projectId,
    region,
    // Their ceiling as well as ours. If our own guard fails to fire — the
    // process is killed mid-run, say — this is what stops a session billing
    // until it times out at their six-hour default.
    timeout: Math.max(60, Math.round(maxSessionMs / 1000)),
    browserSettings: {
      blockAds,
      solveCaptchas: false,
      viewport: { width: viewport.width, height: viewport.height },
      ...(stealth ? { advancedStealth: true } : {}),
    },
  });

  // Best-effort: a missing live view is a worse console, not a failed run.
  let liveViewUrl = null;
  try {
    const debug = await bb.sessions.debug(session.id);
    liveViewUrl = debug?.debuggerFullscreenUrl || null;
  } catch (err) {
    log.debug('Could not fetch the live view URL', { error: err.message });
  }

  return { connectUrl: session.connectUrl, sessionId: session.id, liveViewUrl };
}

/**
 * End a Browserbase session immediately.
 *
 * Disconnecting Playwright is not enough — the session stays RUNNING and keeps
 * billing until it hits its timeout. This is the single most expensive thing to
 * get wrong in the hosted path: a five-minute ceiling on a workflow that
 * finished in twenty seconds would bill fifteen times what it should.
 */
async function releaseBrowserbaseSession(sessionId) {
  const bb = getBrowserbase();
  const { projectId } = config.agentic.browser.browserbase;
  if (!bb || !sessionId || !projectId) return;

  try {
    await bb.sessions.update(sessionId, { projectId, status: 'REQUEST_RELEASE' });
    log.debug('Browserbase session released', { sessionId });
  } catch (err) {
    log.warn('Could not release the Browserbase session — it will bill until timeout', {
      sessionId,
      error: err.message,
    });
  }
}

// ─── Provider: self-hosted CDP ──────────────────────────────

/**
 * Ask a session-API browser (Steel, and Browserless's newer endpoints) for a
 * dedicated session. Optional, because the simple images have no such call:
 * pointing `AGENT_BROWSER_WS` straight at a Browserless container works.
 */
async function openManagedCdpSession() {
  const { apiUrl, apiToken, maxSessionMs } = config.agentic.browser;

  const response = await fetch(`${apiUrl.replace(/\/$/, '')}/v1/sessions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiToken ? { 'x-api-key': apiToken } : {}),
    },
    body: JSON.stringify({ timeout: maxSessionMs, solveCaptcha: false, blockAds: true }),
  });

  if (!response.ok) {
    throw new Error(`Browser service refused a session (${response.status})`);
  }

  const session = await response.json();
  const connectUrl = session.websocketUrl || session.wsEndpoint || session.connectUrl;
  if (!connectUrl) throw new Error('Browser service returned no websocket URL');

  return { connectUrl, sessionId: session.id || session.sessionId || null, liveViewUrl: null };
}

async function openCdpSession() {
  const { wsEndpoint, apiUrl } = config.agentic.browser;
  if (apiUrl) return openManagedCdpSession();
  return { connectUrl: wsEndpoint, sessionId: null, liveViewUrl: null };
}

// ─── The session ────────────────────────────────────────────

/**
 * Open a browser and return the small surface the runner and executors use.
 *
 * @returns {Promise<object>} `page()`, `goto()`, `screenshot()`, `close()`,
 *   plus `sessionId` / `liveViewUrl` for the console and `elapsedSeconds()`
 *   for the bill.
 */
export async function openSession({ onLog = () => {} } = {}) {
  const provider = resolveProvider();

  if (!provider) {
    const err = new Error(
      'Browser automation is not configured on this server. Set BROWSERBASE_API_KEY (hosted) or AGENT_BROWSER_WS (self-hosted).'
    );
    err.code = 'BROWSER_NOT_CONFIGURED';
    err.status = 503;
    throw err;
  }

  const startedAt = Date.now();
  const { maxSessionMs, timeoutMs, viewport } = config.agentic.browser;

  const { connectUrl, sessionId, liveViewUrl } =
    provider === 'browserbase' ? await openBrowserbaseSession() : await openCdpSession();

  log.debug('Connecting to browser', { provider, sessionId });
  const chromium = await getChromium();
  const browser = await chromium.connectOverCDP(connectUrl, { timeout: timeoutMs });

  // A CDP attach lands in whatever context the remote browser already has.
  // Reusing it keeps single-context images working, while still creating one
  // when the browser starts empty.
  const context = browser.contexts()[0] || (await browser.newContext({ viewport }));
  context.setDefaultTimeout(timeoutMs);
  context.setDefaultNavigationTimeout(timeoutMs);

  const firstPage = context.pages()[0] || (await context.newPage());

  let closed = false;

  const close = async () => {
    if (closed) return;
    closed = true;
    clearTimeout(guard);

    // Disconnect first so nothing is mid-command when the session ends.
    await browser.close().catch(err => log.warn('Browser close failed', { error: err.message }));

    if (provider === 'browserbase') await releaseBrowserbaseSession(sessionId);
  };

  // A hung page is the expensive failure: it bills wall-clock while producing
  // nothing. The runner has its own ceiling, but this one fires even if the
  // runner itself is wedged.
  const guard = setTimeout(() => {
    if (closed) return;
    log.warn('Browser session exceeded its ceiling — closing', { maxSessionMs, sessionId });
    onLog({
      level: 'warn',
      message: `Browser session hit the ${Math.round(maxSessionMs / 1000)}s ceiling and was closed.`,
    });
    close().catch(() => {});
  }, maxSessionMs);
  guard.unref?.();

  return {
    provider,
    sessionId,
    liveViewUrl,
    context,

    /**
     * The page the run is driving — always the *last* in the context, never one
     * captured at open time. A `target="_blank"` link opens a new tab, and a run
     * that keeps driving the original reads as "the agent stopped working" with
     * no error to show for it.
     */
    page() {
      const pages = context.pages();
      return pages[pages.length - 1] || firstPage;
    },

    async goto(url, { waitUntil = 'load' } = {}) {
      assertUrlAllowed(url);
      const target = this.page();
      await target.goto(url, { waitUntil, timeout: timeoutMs });
      return { url: target.url(), title: await target.title().catch(() => '') };
    },

    /** A base64 data URL, small enough to store inline on the run document. */
    async screenshot({ fullPage = false } = {}) {
      const buffer = await this.page().screenshot({
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

    close,
  };
}

/**
 * Fetch a finished session's replay playlist.
 *
 * Returns `null` while the recording is still processing — it lags the session
 * close by a few seconds — so the caller can answer 202 and let the client poll
 * rather than showing an error for a recording that is simply not ready yet.
 */
export async function getReplayPlaylist(sessionId) {
  const bb = getBrowserbase();
  if (!bb || !sessionId) return null;

  try {
    const replay = await bb.sessions.replays.retrieve(sessionId);
    const firstPage = replay?.pages?.[0];
    if (!firstPage) return null;

    const playlist = await bb.sessions.replays.retrievePage(sessionId, firstPage.pageId);
    return await playlist.text();
  } catch (err) {
    // Browserbase 404s the resource before the replay is registered. That's the
    // not-ready window, not a real miss.
    if (err?.status === 404 || /not.?found/i.test(err?.message || '')) return null;
    throw err;
  }
}

export default { openSession, isBrowserConfigured, browserCapabilities, resolveProvider, getReplayPlaylist };
