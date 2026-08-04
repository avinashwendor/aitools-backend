/**
 * Node executors — one function per registry type.
 *
 * Every executor has the same contract and it is intentionally narrow:
 *
 *   in   resolved field values (placeholders already substituted), plus the
 *        capabilities the node declared it needs
 *   out  a plain JSON object, which becomes `{{ thisNode.* }}` downstream
 *
 * No executor touches the run document, the ledger, the event bus or the
 * database directly. That belongs to the runner, and keeping it there is what
 * makes an executor testable by calling it with an object — the node-based
 * reference threaded a whole step-tools object and a publish function through
 * every executor, and the result is that none of them can be exercised without
 * standing up the queue.
 *
 * Failures throw. The runner catches, marks the step failed, and decides
 * whether the run continues — a decision no individual node should be making.
 */

import config from '../config/index.js';
import { complete, completeJson } from '../ai/llm.js';
import { search as searchCatalog } from '../ai/retriever.js';
import { sendEmail, isEmailConfigured } from '../services/email/index.js';
import { AgentCredential } from '../models/index.js';
import { assertUrlAllowed } from './safety.js';
import * as browser from './browser/primitives.js';

/** Load a credential the node referenced, scoped to the run's owner. */
async function loadCredential(credentialId, userId) {
  if (!credentialId) return null;
  const credential = await AgentCredential.findOne({
    _id: credentialId,
    user: userId,
  }).select('+secret');

  // A missing credential is fatal rather than silently unauthenticated: an
  // HTTP node that quietly drops its auth header returns a 401 body as if it
  // were data, and that failure surfaces three nodes later as nonsense.
  if (!credential) {
    const err = new Error('The credential this step uses no longer exists.');
    err.code = 'CREDENTIAL_MISSING';
    throw err;
  }

  // Fire-and-forget: a "last used" timestamp is not worth failing a run over.
  AgentCredential.updateOne({ _id: credential._id }, { lastUsedAt: new Date() }).catch(() => {});

  return credential;
}

const executors = {
  // ─── Triggers ────────────────────────────────────────────
  // A trigger's output is the run's seed payload, decided before the walk
  // begins. It executes as a no-op so the console still shows it as a step —
  // a run whose first visible node is step two reads as if something was
  // skipped.

  'trigger.manual': async ({ trigger }) => ({ ...(trigger?.payload || {}) }),
  'trigger.webhook': async ({ trigger }) => ({ ...(trigger?.payload || {}) }),
  'trigger.schedule': async ({ trigger }) => ({
    firedAt: new Date().toISOString(),
    ...(trigger?.payload || {}),
  }),

  // ─── Core ────────────────────────────────────────────────

  'core.http': async ({ values, userId, signal }) => {
    const url = assertUrlAllowed(values.url);
    const method = (values.method || 'GET').toUpperCase();

    let headers = { 'User-Agent': 'AIToolsWorkflow/1.0', ...(values.headers || {}) };
    let target = url.toString();

    const credential = await loadCredential(values.credentialId, userId);
    if (credential) {
      const applied = credential.applyTo({ headers, url: target });
      headers = applied.headers;
      target = applied.url;
    }

    const init = { method, headers, signal, redirect: 'follow' };

    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && values.body) {
      init.body = typeof values.body === 'string' ? values.body : JSON.stringify(values.body);
      if (!Object.keys(headers).some(h => h.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = 'application/json';
      }
    }

    const response = await fetch(target, init);
    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('json')
      ? await response.json().catch(() => null)
      : await response.text();

    // A non-2xx is returned, not thrown. Plenty of useful workflows branch on
    // a 404, and an executor that throws makes that unexpressible — the If node
    // never gets to see the status.
    return {
      status: response.status,
      ok: response.ok,
      data,
      headers: Object.fromEntries(response.headers.entries()),
    };
  },

  'core.llm': async ({ values, signal }) => {
    const messages = [];
    if (values.system) messages.push({ role: 'system', content: String(values.system) });
    messages.push({ role: 'user', content: String(values.prompt) });

    if (values.json) {
      const { data, model } = await completeJson({
        messages,
        role: values.role === 'fast' ? 'fast' : 'planner',
        task: 'agentic:node-llm',
        signal,
      });
      return { json: data, text: JSON.stringify(data), model };
    }

    const result = await complete({
      messages,
      role: values.role === 'fast' ? 'fast' : 'planner',
      task: 'agentic:node-llm',
      signal,
    });
    return { text: result.content, model: result.model };
  },

  'core.template': async ({ values }) => {
    // The value arrived already substituted — this node exists so a graph can
    // name an intermediate result, which is what makes long chains readable.
    if (!values.parseJson) return { value: values.value };
    try {
      return { value: JSON.parse(String(values.value)) };
    } catch (err) {
      throw new Error(`Result is not valid JSON: ${err.message}`);
    }
  },

  'core.condition': async ({ values }) => {
    const left = values.left ?? '';
    const right = values.right ?? '';
    const asNumber = v => Number(String(v).replace(/[^0-9.-]/g, ''));

    let result;
    switch (values.operator) {
      case 'not equals': result = String(left) !== String(right); break;
      case 'contains': result = String(left).toLowerCase().includes(String(right).toLowerCase()); break;
      case 'greater than': result = asNumber(left) > asNumber(right); break;
      case 'less than': result = asNumber(left) < asNumber(right); break;
      case 'is empty': result = String(left).trim() === ''; break;
      case 'is not empty': result = String(left).trim() !== ''; break;
      default: result = String(left) === String(right);
    }

    // `branch` is read by the runner to decide which outgoing handle stays
    // live. Returning it as data (rather than signalling out-of-band) means the
    // decision is visible in the run console like any other step output.
    return { result, branch: result ? 'true' : 'false' };
  },

  'core.delay': async ({ values, signal }) => {
    const ms = Math.min(Math.max(Number(values.seconds) || 0, 0), 300) * 1000;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      // Without this, cancelling a run leaves the worker asleep for five
      // minutes holding a concurrency slot that the user has already given up on.
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('Run canceled'));
      }, { once: true });
    });
    return { waitedMs: ms };
  },

  'core.email': async ({ values, user }) => {
    if (!isEmailConfigured()) {
      throw new Error('Email is not configured on this server.');
    }

    // Only to addresses the account owns or has already been in touch with is
    // too strict to be useful, but unrestricted send turns every account into
    // an open relay wearing our sending domain. The compromise: the recipient
    // is whatever the author typed, and the sender identity is always ours with
    // the owning account named in the body footer, so abuse is attributable.
    const result = await sendEmail({
      to: String(values.to),
      subject: String(values.subject).slice(0, 200),
      text: `${values.body}\n\n—\nSent by an automated workflow (${user?.email || 'unknown account'}).`,
    });

    return { id: result?.id || null, to: values.to, sent: true };
  },

  'core.catalog': async ({ values }) => {
    const tools = await searchCatalog(String(values.query), {
      limit: Math.min(Number(values.limit) || 5, 20),
    });
    return {
      tools: (tools || []).map(t => ({
        name: t.name,
        slug: t.slug,
        category: t.category,
        pricing: t.pricing,
        tagline: t.tagline,
        description: t.description,
        url: t.websiteUrl,
      })),
      count: tools?.length || 0,
    };
  },

  // ─── Browser ─────────────────────────────────────────────
  // `getBrowser()` is provided by the runner and opens the session on first
  // call. Nodes never see the connection details, and a graph that reaches no
  // browser node never opens one — which is the difference between a flow
  // workflow costing nothing extra and costing a Chrome container.

  'browser.open': async ({ values, getBrowser }) => {
    const session = await getBrowser();
    return session.goto(values.url, { waitUntil: values.waitUntil || 'load' });
  },

  'browser.act': async ({ values, getBrowser }) => {
    const session = await getBrowser();
    return browser.act({ page: session.page(), instruction: values.instruction });
  },

  'browser.extract': async ({ values, getBrowser }) => {
    const session = await getBrowser();
    return browser.extract({
      page: session.page(),
      instruction: values.instruction,
      schema: values.schema || null,
    });
  },

  'browser.observe': async ({ values, getBrowser }) => {
    const session = await getBrowser();
    return browser.observe({ page: session.page(), instruction: values.instruction });
  },

  'browser.agent': async ({ values, getBrowser, onLog }) => {
    const session = await getBrowser();
    return browser.agent({
      page: session.page(),
      instruction: values.instruction,
      maxSteps: values.maxSteps,
      // Streamed to the run console as they happen. An autonomous agent that
      // shows nothing for ninety seconds is indistinguishable from a hung one,
      // and users kill runs that look hung.
      onStep: ({ step, thought, action }) =>
        onLog({ level: 'info', message: `Step ${step}: ${action}${thought ? ` — ${thought}` : ''}` }),
    });
  },

  'browser.screenshot': async ({ values, getBrowser, onScreenshot }) => {
    const session = await getBrowser();
    const dataUrl = await session.screenshot({ fullPage: Boolean(values.fullPage) });
    onScreenshot(dataUrl);
    // The image goes on the run document, not in the node's output: a data URL
    // in the context would be re-serialized into every downstream prompt.
    return { captured: true, fullPage: Boolean(values.fullPage) };
  },
};

export function getExecutor(type) {
  const executor = executors[type];
  if (!executor) {
    const err = new Error(`No executor for node type "${type}".`);
    err.code = 'NO_EXECUTOR';
    throw err;
  }
  return executor;
}

export function hasExecutor(type) {
  return Object.prototype.hasOwnProperty.call(executors, type);
}

/** Every registry type must have one of these — asserted by the test suite. */
export const executorTypes = Object.keys(executors);

export default { getExecutor, hasExecutor, executorTypes, maxNodes: config.agentic.maxNodes };
