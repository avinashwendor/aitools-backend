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
 * makes an executor testable by calling it with an object.
 *
 * Failures throw. The runner catches, marks the step failed, and decides
 * whether the run continues — a decision no individual node should be making.
 */

import crypto from 'crypto';
import config from '../config/index.js';
import { complete, completeJson } from '../ai/llm.js';
import { search as searchCatalog } from '../ai/retriever.js';
import { webSearch, isWebSearchConfigured } from '../ai/tools/webSearch.js';
import { fetchPage } from '../ai/tools/fetchPage.js';
import { runAgentLoop, defineTool } from '../ai/agentLoop.js';
import { sendEmail, isEmailConfigured } from '../services/email/index.js';
import { AgentCredential, AgentMemory } from '../models/index.js';
import { assertUrlAllowed } from './safety.js';
import { withRetry, withTimeout, classifyFailure } from './retry.js';
import { coerceItems } from './regions.js';
import { getByPath } from './interpolate.js';
import { runScript } from './sandbox.js';

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

/** The raw secret behind a credential, for APIs that want it in a URL path. */
async function loadSecret(credentialId, userId) {
  const credential = await loadCredential(credentialId, userId);
  return credential?.plaintext ?? null;
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

  /**
   * The one node that retries inside itself.
   *
   * Everywhere else, a transient failure throws and the runner's retry sees it.
   * This node cannot work that way: a non-2xx is *returned* as data, on purpose,
   * so that a workflow can branch on a 404. That same design hides a 429 from
   * the runner — it looks like a perfectly successful step whose `ok` happens to
   * be false, and the next node interpolates an error body into an email.
   *
   * So the retryable statuses are handled here, where the status is still
   * visible, and everything else is left to the runner. If the attempts run out
   * the last response is returned rather than thrown, because the contract that
   * a status is data has to hold for 429 as much as for 404.
   */
  'core.http': async ({ values, userId, signal }) => {
    const url = assertUrlAllowed(values.url);
    const method = (values.method || 'GET').toUpperCase();
    const safeMethod = method === 'GET' || method === 'HEAD';

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

    let last = null;

    const attempt = async () => {
      const response = await withTimeout(
        requestSignal => fetch(target, { ...init, signal: requestSignal }),
        { ms: config.agentic.httpTimeoutMs, signal, what: 'request' }
      );

      const contentType = response.headers.get('content-type') || '';
      const data = contentType.includes('json')
        ? await response.json().catch(() => null)
        : await response.text();

      // A non-2xx is returned, not thrown. Plenty of useful workflows branch on
      // a 404, and an executor that throws makes that unexpressible — the If
      // node never gets to see the status.
      last = {
        status: response.status,
        ok: response.ok,
        data,
        headers: Object.fromEntries(response.headers.entries()),
      };

      const verdict = classifyFailure({ status: response.status, retryAfter: response.headers.get('retry-after') });
      if (verdict.retryable) {
        // Thrown only so `withRetry` can see it. It never escapes: the catch
        // below hands back `last`, which is the response the workflow asked for.
        const err = new Error(`${method} ${url.host} returned ${response.status}.`);
        err.status = response.status;
        err.retryAfter = response.headers.get('retry-after');
        throw err;
      }

      return last;
    };

    try {
      return await withRetry(attempt, {
        attempts: config.agentic.nodeAttempts,
        idempotent: safeMethod,
        signal,
      });
    } catch (err) {
      // Attempts exhausted on a retryable status — hand back the response so a
      // downstream If can still branch on it. A genuine transport failure has
      // no response to return and stays an error the runner can act on.
      if (last && Number(err.status)) return last;
      throw err;
    }
  },

  'core.code': async ({ values, scope, trigger, nodeId, edges }) => {
    // `input` is the single upstream node's output when there is exactly one,
    // which is the case that covers almost every script anyone writes. With
    // several parents there is no defensible choice, so it is null and the
    // author reaches into `steps` by name instead of us guessing.
    const parents = (edges || []).filter(e => e.target === nodeId).map(e => e.source);
    const input = parents.length === 1 ? scope[parents[0]] ?? null : null;

    const result = await runScript(String(values.script || ''), {
      input,
      steps: scope,
      trigger: trigger?.payload || {},
    });

    /*
     * `return { skip: true }` is the weekday/weekend gate. Surface `skip` at
     * the top level so the runner can short-circuit the rest of the chain —
     * wrapping it only under `result` would make weekend digests still fire.
     */
    if (result && typeof result === 'object' && !Array.isArray(result) && result.skip === true) {
      return { result, skip: true, reason: result.reason || 'Skipped by code' };
    }

    return { result };
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
      // minutes holding a concurrency slot the user has already given up on.
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('Run canceled'));
      }, { once: true });
    });
    return { waitedMs: ms };
  },

  /*
   * The loop boundaries are executors only so that the runner's walk, the
   * console's step list and the credit meter all treat them like any other
   * node. The repetition itself lives in the runner, which is the only place
   * that can drive a body more than once — see `runner.js` and `regions.js`.
   *
   * `core.forEach` resolves and bounds the list. `core.collect` never runs
   * through here at all: the runner writes its output directly, because what it
   * gathers only exists inside the iteration loop.
   */
  'core.forEach': async ({ values }) => {
    const items = coerceItems(values.items);
    const cap = Math.min(Math.max(Number(values.maxItems) || 25, 1), 500);
    return {
      items: items.slice(0, cap),
      total: Math.min(items.length, cap),
      available: items.length,
      capped: items.length > cap,
    };
  },

  'core.collect': async ({ scope, nodeId }) => scope[nodeId] ?? { items: [], count: 0, failed: 0 },

  /**
   * Already-seen filtering.
   *
   * Two details are the whole value of this node. The keys are hashed, because
   * they are other people's identifiers and nothing here ever needs to read one
   * back. And the write is `insertMany` with `ordered: false`, so two runs
   * overlapping — a schedule firing while a manual run is still going — race
   * into a unique-index conflict instead of both deciding an item is new and
   * both delivering it.
   */
  'core.dedupe': async ({ values, nodeId, workflowId }) => {
    const items = coerceItems(values.items);
    const keyPath = String(values.key || 'id').trim();
    const scopeKey = values.scope === 'this step' ? String(nodeId) : '*';
    const days = Math.min(Math.max(Number(values.rememberDays) || 30, 1), 365);

    if (!items.length) return { items: [], count: 0, skipped: 0 };

    /*
     * No workflow means nowhere to remember, and that is the architect
     * test-running this step while building.
     *
     * Recording there would be the worst possible bug in this node: it would
     * mark the whole existing backlog as seen before the workflow had ever run,
     * so the user's first real run finds nothing new and the thing they just
     * paid to build appears to do nothing. Passing everything through untracked
     * is both safe and honest — it is exactly what a genuine first run does.
     */
    if (!workflowId) {
      return { items, count: items.length, skipped: 0, note: 'Not recorded — this was a test run.' };
    }

    const keyed = items.map(item => {
      const raw = getByPath(item, keyPath);
      return {
        item,
        // An item with no value at the key cannot be tracked. Falling back to
        // the whole item keeps it de-duplicable rather than making it either
        // permanently new (delivered every run) or permanently seen (never
        // delivered), which are both worse than a slightly brittle key.
        value: raw === undefined || raw === null || raw === '' ? JSON.stringify(item) : String(raw),
      };
    });

    const hashes = keyed.map(entry =>
      crypto.createHash('sha256').update(entry.value).digest('hex')
    );

    const known = new Set(
      (
        await AgentMemory.find({ workflow: workflowId, scope: scopeKey, keyHash: { $in: hashes } })
          .select('keyHash')
          .lean()
      ).map(row => row.keyHash)
    );

    const fresh = [];
    const freshHashes = new Set();
    keyed.forEach((entry, index) => {
      const hash = hashes[index];
      // A list can repeat an item within itself; the second copy is not new.
      if (known.has(hash) || freshHashes.has(hash)) return;
      freshHashes.add(hash);
      fresh.push(entry.item);
    });

    if (fresh.length && !values.markOnly) {
      const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
      await AgentMemory.insertMany(
        [...freshHashes].map(keyHash => ({
          workflow: workflowId,
          scope: scopeKey,
          keyHash,
          expiresAt,
        })),
        { ordered: false }
      ).catch(err => {
        // Duplicate-key means another run recorded it first, which is the
        // mechanism working. Anything else and we would rather deliver an item
        // twice than fail a run that has already done its work.
        if (err.code !== 11000) throw err;
      });
    }

    return {
      items: fresh,
      count: fresh.length,
      skipped: items.length - fresh.length,
      ...(values.markOnly ? { note: 'Preview only — these will be new again next run.' } : {}),
    };
  },

  // ─── Intelligence ────────────────────────────────────────

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

  /**
   * An autonomous agent as a single node.
   *
   * Its tools are deliberately read-only — search and fetch. A node that could
   * also write would be a second, invisible workflow hiding inside a box on the
   * canvas, and the whole point of the graph is that side effects are things
   * you can see and connect. Anything that changes the world is a node the
   * author placed.
   */
  'core.agent': async ({ values, signal, onLog }) => {
    const allowed = String(values.tools || 'search + fetch');
    const canSearch = allowed.includes('search') && isWebSearchConfigured();
    const canFetch = allowed.includes('fetch');
    const sources = new Set();

    const tools = {};

    if (canSearch) {
      tools.search_web = defineTool({
        description: 'Search the live web. Returns titles, URLs and snippets.',
        properties: {
          query: { type: 'string', description: 'What to search for.' },
        },
        required: ['query'],
        run: async ({ query }) => {
          const results = await webSearch(String(query), { maxResults: 5 });
          if (!results) throw new Error('Web search is unavailable right now.');
          results.forEach(r => sources.add(r.url));
          return results;
        },
      });
    }

    if (canFetch) {
      tools.read_url = defineTool({
        description:
          'Fetch a public URL and return its readable text or JSON. Use this to read a page ' +
          'a search turned up, or to call a public API endpoint.',
        properties: {
          url: { type: 'string', description: 'An http(s) URL.' },
        },
        required: ['url'],
        run: async ({ url }) => {
          const page = await fetchPage(String(url), { maxChars: 6000, signal });
          sources.add(page.url);
          return { title: page.title, text: page.text };
        },
      });
    }

    tools.finish = defineTool({
      description:
        'Call this when you have the answer. This ends your turn — do not call it before ' +
        'you have actually gathered what you were asked for.',
      properties: {
        answer: { type: 'string', description: 'The answer, in plain prose.' },
        data: {
          type: 'object',
          description: 'The answer as structured data, matching the requested shape if one was given.',
          additionalProperties: true,
        },
      },
      required: ['answer'],
      terminal: true,
      run: async ({ answer, data }) => ({ answer, data: data ?? null }),
    });

    const shape = values.schema
      ? `\n\nReturn \`data\` matching this shape exactly:\n${JSON.stringify(values.schema, null, 2)}`
      : '';

    const outcome = await runAgentLoop({
      system:
        'You are a research agent inside an automation workflow. You are given a goal and a ' +
        'small set of read-only tools. Work in small steps: gather what you actually need, ' +
        'then call `finish`.\n\n' +
        'Rules:\n' +
        '- Never invent a fact you did not read from a tool result.\n' +
        '- Prefer two good sources over six shallow ones.\n' +
        '- If a tool fails, try a different query or URL rather than repeating it.\n' +
        '- You must end by calling `finish`.' +
        shape,
      messages: [
        {
          role: 'user',
          content:
            `GOAL: ${values.goal}` +
            (values.context ? `\n\nCONTEXT FROM EARLIER STEPS:\n${String(values.context).slice(0, 6000)}` : ''),
        },
      ],
      tools,
      maxSteps: Math.min(Math.max(Number(values.maxSteps) || 8, 1), 40),
      // Same tier as the architect: this node's job is to be right about
      // something the workflow will then act on unattended.
      role: 'reasoning',
      // Pages, not paragraphs. The node is charged for the tokens it reads.
      maxResultChars: 16_000,
      task: 'agentic:node-agent',
      signal,
      onEvent: event => {
        if (event.type === 'tool.start') {
          onLog?.({ level: 'info', message: `${event.name}(${JSON.stringify(event.args).slice(0, 160)})` });
        } else if (event.type === 'thinking' && event.text) {
          onLog?.({ level: 'debug', message: event.text.slice(0, 400) });
        }
      },
    });

    // An agent that ran out of budget still has whatever prose it last wrote,
    // and that is usually most of the answer. Returning it with success:false
    // lets a downstream If branch on the difference instead of the run simply
    // failing with nothing to show for the credits it spent.
    return {
      success: outcome.finishReason === 'finished',
      answer: outcome.result?.answer ?? outcome.text ?? '',
      data: outcome.result?.data ?? null,
      steps: outcome.steps,
      sources: [...sources],
      finishReason: outcome.finishReason,
    };
  },

  // ─── Data ────────────────────────────────────────────────

  'core.websearch': async ({ values }) => {
    if (!isWebSearchConfigured()) {
      throw new Error('Web search is not configured on this server (TAVILY_API_KEY).');
    }
    const results = await webSearch(String(values.query), {
      maxResults: Math.min(Number(values.limit) || 5, 10),
    });
    if (!results) throw new Error('Web search is unavailable right now — try again shortly.');

    return {
      results,
      // A pre-joined text form so the common next step (feed it to an AI Step)
      // doesn't need a Code node in between just to flatten an array.
      text: results.map(r => `${r.title}\n${r.url}\n${r.snippet}`).join('\n\n'),
      count: results.length,
    };
  },

  'core.fetchPage': async ({ values, signal }) => {
    const page = await fetchPage(String(values.url), {
      maxChars: Math.min(Number(values.maxChars) || 8000, 40000),
      signal,
    });
    return { title: page.title, text: page.text, url: page.url };
  },

  'core.rss': async ({ values, signal }) => {
    const url = assertUrlAllowed(values.url);
    const response = await fetch(url.toString(), {
      signal,
      headers: { 'User-Agent': 'AIToolsWorkflow/1.0', Accept: 'application/rss+xml, application/xml, text/xml, */*' },
    });
    if (!response.ok) throw new Error(`Feed returned ${response.status}.`);

    const xml = await response.text();
    const limit = Math.min(Number(values.limit) || 10, 50);
    const items = parseFeed(xml, limit);

    if (!items.length) throw new Error('No items found — is that URL an RSS or Atom feed?');
    return { items, count: items.length };
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

  // ─── Deliver ─────────────────────────────────────────────

  'core.email': async ({ values, user }) => {
    if (!isEmailConfigured()) {
      throw new Error('Email is not configured on this server.');
    }

    // Unrestricted send would turn every account into an open relay wearing our
    // sending domain. The compromise: the recipient is whatever the author
    // typed, the sender identity is always ours, and the owning account is
    // named in the footer, so abuse is attributable.
    const result = await sendEmail({
      to: String(values.to),
      subject: String(values.subject).slice(0, 200),
      text: `${values.body}\n\n—\nSent by an automated workflow (${user?.email || 'unknown account'}).`,
    });

    return { id: result?.id || null, to: values.to, sent: true };
  },

  'core.slack': async ({ values, signal }) => {
    const url = assertUrlAllowed(values.webhookUrl);
    const content = String(values.content || '').slice(0, 4000);
    if (!content) throw new Error('Slack message content is required.');

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: content }),
      signal,
    });
    if (!response.ok) {
      throw new Error(`Slack webhook failed (${response.status}).`);
    }
    return { messageContent: content };
  },

  'core.discord': async ({ values, signal }) => {
    const url = assertUrlAllowed(values.webhookUrl);
    const content = String(values.content || '').slice(0, 2000);
    if (!content) throw new Error('Discord message content is required.');

    const body = { content };
    if (values.username) body.username = String(values.username).slice(0, 80);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      throw new Error(`Discord webhook failed (${response.status}).`);
    }
    return { messageContent: content };
  },

  'core.telegram': async ({ values, userId, signal }) => {
    const token = await loadSecret(values.credentialId, userId);
    if (!token) throw new Error('Select the credential holding your Telegram bot token.');

    const content = String(values.content || '').slice(0, 4000);
    if (!content) throw new Error('Telegram message content is required.');

    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: String(values.chatId), text: content }),
      signal,
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      // Telegram's own description is far more useful than the status code —
      // "chat not found" and "bot was blocked" are both 400.
      throw new Error(`Telegram rejected the message: ${data.description || response.status}.`);
    }

    return { messageId: data.result?.message_id ?? null, messageContent: content };
  },

  'core.notion': async ({ values, userId, signal }) => {
    const token = await loadSecret(values.credentialId, userId);
    if (!token) throw new Error('Select the credential holding your Notion integration token.');

    const properties = {
      // Notion requires the title property by name, and it differs per
      // database. "Name" is the default Notion itself creates, and an author
      // who renamed it can override through the extra properties field.
      Name: { title: [{ text: { content: String(values.title).slice(0, 2000) } }] },
      ...(values.properties || {}),
    };

    const children = values.content
      ? [{
          object: 'block',
          type: 'paragraph',
          paragraph: { rich_text: [{ text: { content: String(values.content).slice(0, 2000) } }] },
        }]
      : [];

    const response = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28',
      },
      body: JSON.stringify({
        parent: { database_id: String(values.databaseId).replace(/-/g, '') },
        properties,
        ...(children.length ? { children } : {}),
      }),
      signal,
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`Notion rejected the page: ${data.message || response.status}.`);
    }

    return { id: data.id, url: data.url };
  },
};

/**
 * Minimal RSS/Atom reader.
 *
 * A regex rather than an XML parser, for the same reason `fetchPage` uses one:
 * feeds are read to be summarised, and the five fields anyone summarises are
 * unambiguous in both dialects. A parser would add a dependency to gain
 * correctness on namespaced extensions nothing downstream reads.
 */
function parseFeed(xml, limit) {
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];

  const field = (block, name) => {
    const match = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
    if (!match) return '';
    return match[1]
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  };

  return blocks.slice(0, limit).map(block => {
    // Atom puts the URL in an attribute, RSS in the element body.
    const href = block.match(/<link\b[^>]*href=["']([^"']+)["']/i);
    return {
      title: field(block, 'title').slice(0, 300),
      link: (href ? href[1] : field(block, 'link')).slice(0, 800),
      publishedAt: field(block, 'pubDate') || field(block, 'updated') || field(block, 'published'),
      summary: (field(block, 'description') || field(block, 'summary') || field(block, 'content')).slice(0, 1000),
    };
  });
}

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
