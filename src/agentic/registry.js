/**
 * Node registry — the manifest every other part of the agentic system reads.
 *
 * One entry per node type, and it is the *only* place a node type is described.
 * The executor map keys off it, the graph validator checks required fields
 * against it, the credit meter reads `credits` from it, and the editor palette
 * and inspector are rendered entirely from it (served verbatim at
 * `GET /api/agents/registry`). Adding a node means adding an entry here and an
 * executor with the matching key — no UI change, no migration.
 *
 * Both reference implementations kept a separate client registry (icons, field
 * definitions) and server registry (executors), which meant a new field had to
 * be added in two files that no compiler cross-checks. Shipping the manifest to
 * the browser instead removes that whole class of drift: the inspector cannot
 * render a field the validator doesn't know about, because it is the same
 * object.
 *
 * `icon` is a lucide-react export name, resolved on the client. Keeping it a
 * string is what lets the manifest cross the wire at all.
 */

/** Palettes a node can appear in. A node may belong to both. */
export const SURFACES = ['flow', 'browser'];

/**
 * Field types the inspector knows how to render. `credential` renders a picker
 * scoped to `provider`, and only ever carries a credential id — a secret never
 * enters a graph document.
 */
export const FIELD_TYPES = ['text', 'textarea', 'select', 'number', 'boolean', 'json', 'credential'];

/**
 * Credits charged per successful execution of a node, on top of the flat
 * `agent.run` fee.
 *
 * These are derived the same way as the chat costs in `billing/plans.js`: from
 * measured provider cost at roughly a 4× markup. The three tiers:
 *
 *   • 0     deterministic and effectively free to us (templates, branches).
 *   • 1–2   a network call we pay for in bandwidth and a worker slot.
 *   • 4–25  an LLM call, or a browser step that is an LLM call plus seconds of
 *           a real Chrome process. `browser.agent` runs an autonomous loop of
 *           up to `maxSteps` model calls, which is why it costs the most.
 *
 * Browser wall-clock is billed separately per minute — see BROWSER_MINUTE_COST
 * in `billing/plans.js`. A node that idles on a slow page costs us the session
 * whether or not it thinks, and a per-execution price alone can't see that.
 */

const T = {
  text: (key, label, opts = {}) => ({ key, label, type: 'text', ...opts }),
  textarea: (key, label, opts = {}) => ({ key, label, type: 'textarea', ...opts }),
  select: (key, label, options, opts = {}) => ({ key, label, type: 'select', options, ...opts }),
  number: (key, label, opts = {}) => ({ key, label, type: 'number', ...opts }),
  boolean: (key, label, opts = {}) => ({ key, label, type: 'boolean', ...opts }),
  json: (key, label, opts = {}) => ({ key, label, type: 'json', ...opts }),
  credential: (key, label, provider, opts = {}) => ({
    key,
    label,
    type: 'credential',
    provider,
    ...opts,
  }),
};

/** Standard single-output handle set. */
const OUT = ['main'];

export const NODE_REGISTRY = {
  // ─── Triggers ──────────────────────────────────────────────
  // Exactly one per workflow, enforced by the validator. A trigger produces the
  // run's seed context and never has an inbound edge.

  'trigger.manual': {
    type: 'trigger.manual',
    kind: 'trigger',
    group: 'Triggers',
    label: 'Manual',
    description: 'Runs when you press Run, or when the workflow is called from chat.',
    icon: 'MousePointerClick',
    accent: '#3b82f6',
    surfaces: ['flow', 'browser'],
    credits: 0,
    handles: { in: false, out: OUT },
    fields: [
      T.json('input', 'Test input', {
        placeholder: '{ "topic": "AI newsletters" }',
        help: 'Optional JSON handed to the run as {{ trigger.* }}. Used for manual runs only.',
      }),
    ],
    outputs: [{ path: 'trigger', label: 'Trigger payload' }],
  },

  'trigger.webhook': {
    type: 'trigger.webhook',
    kind: 'trigger',
    group: 'Triggers',
    label: 'Webhook',
    description: 'Runs when an external service POSTs to this workflow’s URL.',
    icon: 'Webhook',
    accent: '#3b82f6',
    surfaces: ['flow', 'browser'],
    credits: 0,
    handles: { in: false, out: OUT },
    fields: [
      T.select('method', 'Method', ['POST', 'GET'], { default: 'POST' }),
      T.boolean('requireSecret', 'Require signed secret', {
        default: true,
        help: 'Reject calls without the ?token= issued for this workflow.',
      }),
    ],
    outputs: [
      { path: 'trigger.body', label: 'Request body' },
      { path: 'trigger.query', label: 'Query string' },
      { path: 'trigger.headers', label: 'Headers' },
    ],
  },

  'trigger.schedule': {
    type: 'trigger.schedule',
    kind: 'trigger',
    group: 'Triggers',
    label: 'Schedule',
    description: 'Runs on a repeating interval.',
    icon: 'Clock',
    accent: '#3b82f6',
    surfaces: ['flow', 'browser'],
    credits: 0,
    handles: { in: false, out: OUT },
    fields: [
      T.select(
        'every',
        'Run every',
        ['15 minutes', 'hour', '6 hours', 'day', 'week'],
        { default: 'day', required: true }
      ),
      T.text('atHour', 'At hour (UTC)', {
        placeholder: '9',
        help: 'Only used for daily and weekly schedules.',
      }),
    ],
    outputs: [{ path: 'trigger.firedAt', label: 'Fired at' }],
  },

  // ─── Core actions ──────────────────────────────────────────

  'core.http': {
    type: 'core.http',
    kind: 'action',
    group: 'Core',
    label: 'HTTP Request',
    description: 'Call any REST API. Response JSON is available downstream.',
    icon: 'Globe',
    accent: '#10b981',
    surfaces: ['flow', 'browser'],
    credits: 1,
    handles: { in: true, out: OUT },
    fields: [
      T.text('url', 'URL', { required: true, placeholder: 'https://api.example.com/items' }),
      T.select('method', 'Method', ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], { default: 'GET' }),
      T.json('headers', 'Headers', { placeholder: '{ "Accept": "application/json" }' }),
      T.textarea('body', 'Body', { placeholder: '{ "name": "{{ trigger.name }}" }' }),
      T.credential('credentialId', 'Auth credential', 'http', {
        help: 'Optional. Sent as an Authorization header — never written into the graph.',
      }),
    ],
    outputs: [
      { path: 'status', label: 'Status code' },
      { path: 'data', label: 'Response body' },
      { path: 'headers', label: 'Response headers' },
    ],
  },

  'core.llm': {
    type: 'core.llm',
    kind: 'action',
    group: 'Core',
    label: 'AI Step',
    description: 'Ask a model to write, summarise, classify or reshape data.',
    icon: 'Sparkles',
    accent: '#8b5cf6',
    surfaces: ['flow', 'browser'],
    credits: 4,
    handles: { in: true, out: OUT },
    fields: [
      T.textarea('system', 'System prompt', {
        placeholder: 'You are a concise editor.',
      }),
      T.textarea('prompt', 'Prompt', {
        required: true,
        placeholder: 'Summarise this in three bullets:\n\n{{ http_1.data }}',
      }),
      T.select('role', 'Model tier', ['fast', 'planner'], {
        default: 'planner',
        help: '“fast” is cheaper and quicker; “planner” reasons better.',
      }),
      T.boolean('json', 'Return JSON', {
        default: false,
        help: 'Forces a JSON object response, parsed into `json` downstream.',
      }),
    ],
    outputs: [
      { path: 'text', label: 'Text' },
      { path: 'json', label: 'Parsed JSON (when enabled)' },
    ],
  },

  'core.template': {
    type: 'core.template',
    kind: 'action',
    group: 'Core',
    label: 'Set / Template',
    description: 'Build a value from upstream output. No model call, no cost.',
    icon: 'Braces',
    accent: '#64748b',
    surfaces: ['flow', 'browser'],
    credits: 0,
    handles: { in: true, out: OUT },
    fields: [
      T.textarea('value', 'Value', {
        required: true,
        placeholder: '{{ llm_1.text }} — sourced from {{ open_1.url }}',
      }),
      T.boolean('parseJson', 'Parse result as JSON', { default: false }),
    ],
    outputs: [{ path: 'value', label: 'Value' }],
  },

  'core.condition': {
    type: 'core.condition',
    kind: 'action',
    group: 'Core',
    label: 'If',
    description: 'Split the flow. Only the matching branch runs.',
    icon: 'GitBranch',
    accent: '#f59e0b',
    surfaces: ['flow', 'browser'],
    credits: 0,
    handles: { in: true, out: ['true', 'false'] },
    fields: [
      T.text('left', 'Left', { required: true, placeholder: '{{ http_1.status }}' }),
      T.select(
        'operator',
        'Operator',
        ['equals', 'not equals', 'contains', 'greater than', 'less than', 'is empty', 'is not empty'],
        { default: 'equals', required: true }
      ),
      T.text('right', 'Right', { placeholder: '200' }),
    ],
    outputs: [{ path: 'result', label: 'Result (true/false)' }],
  },

  'core.delay': {
    type: 'core.delay',
    kind: 'action',
    group: 'Core',
    label: 'Wait',
    description: 'Pause before continuing.',
    icon: 'Timer',
    accent: '#64748b',
    surfaces: ['flow', 'browser'],
    credits: 0,
    handles: { in: true, out: OUT },
    fields: [
      T.number('seconds', 'Seconds', { default: 5, required: true, max: 300 }),
    ],
    outputs: [{ path: 'waitedMs', label: 'Waited (ms)' }],
  },

  'core.email': {
    type: 'core.email',
    kind: 'action',
    group: 'Core',
    label: 'Send Email',
    description: 'Email a result to yourself or a teammate.',
    icon: 'Mail',
    accent: '#14b8a6',
    surfaces: ['flow', 'browser'],
    credits: 2,
    handles: { in: true, out: OUT },
    fields: [
      T.text('to', 'To', { required: true, placeholder: 'you@example.com' }),
      T.text('subject', 'Subject', { required: true, placeholder: 'Your daily digest' }),
      T.textarea('body', 'Body', { required: true, placeholder: '{{ llm_1.text }}' }),
    ],
    outputs: [{ path: 'id', label: 'Message id' }],
  },

  'core.catalog': {
    type: 'core.catalog',
    kind: 'action',
    group: 'Core',
    label: 'Search Tool Catalog',
    description: 'Search our AI tool catalog and use the matches downstream.',
    icon: 'LayoutGrid',
    accent: '#ec4899',
    surfaces: ['flow', 'browser'],
    credits: 1,
    handles: { in: true, out: OUT },
    fields: [
      T.text('query', 'Query', { required: true, placeholder: 'video editing for shorts' }),
      T.number('limit', 'Results', { default: 5, max: 20 }),
    ],
    outputs: [
      { path: 'tools', label: 'Matching tools' },
      { path: 'count', label: 'Count' },
    ],
  },

  // ─── Browser actions ───────────────────────────────────────
  // Every node below needs a live Chrome session. The runner opens one lazily
  // on the first of these it reaches and reuses it for the whole run, so a
  // login on step 2 still holds on step 9 — and so the recording is one file.

  'browser.open': {
    type: 'browser.open',
    kind: 'action',
    group: 'Browser',
    label: 'Open URL',
    description: 'Navigate the session’s page to an address.',
    icon: 'Compass',
    accent: '#10b981',
    surfaces: ['browser'],
    credits: 2,
    requiresBrowser: true,
    handles: { in: true, out: OUT },
    fields: [
      T.text('url', 'URL', { required: true, placeholder: 'https://news.ycombinator.com' }),
      T.select('waitUntil', 'Wait until', ['load', 'domcontentloaded', 'networkidle'], {
        default: 'load',
      }),
    ],
    outputs: [
      { path: 'url', label: 'Final URL' },
      { path: 'title', label: 'Page title' },
    ],
  },

  'browser.act': {
    type: 'browser.act',
    kind: 'action',
    group: 'Browser',
    label: 'Act',
    description: 'Do one thing on the page, described in plain English.',
    icon: 'Pointer',
    accent: '#8b5cf6',
    surfaces: ['browser'],
    credits: 6,
    requiresBrowser: true,
    handles: { in: true, out: OUT },
    fields: [
      T.textarea('instruction', 'Instruction', {
        required: true,
        placeholder: 'Click the “Sign in” button',
      }),
    ],
    outputs: [
      { path: 'success', label: 'Success' },
      { path: 'action', label: 'What it did' },
      { path: 'url', label: 'URL after' },
    ],
  },

  'browser.extract': {
    type: 'browser.extract',
    kind: 'action',
    group: 'Browser',
    label: 'Extract',
    description: 'Pull structured data off the page.',
    icon: 'ScanText',
    accent: '#f59e0b',
    surfaces: ['browser'],
    credits: 6,
    requiresBrowser: true,
    handles: { in: true, out: OUT },
    fields: [
      T.textarea('instruction', 'What to extract', {
        required: true,
        placeholder: 'The top 5 story titles and their points',
      }),
      T.json('schema', 'Shape (optional)', {
        placeholder: '{ "stories": [{ "title": "string", "points": "number" }] }',
        help: 'Describe the shape you want and the result is coerced to it.',
      }),
    ],
    outputs: [{ path: 'data', label: 'Extracted data' }],
  },

  'browser.observe': {
    type: 'browser.observe',
    kind: 'action',
    group: 'Browser',
    label: 'Observe',
    description: 'Find candidate elements without touching them.',
    icon: 'Eye',
    accent: '#0ea5e9',
    surfaces: ['browser'],
    credits: 4,
    requiresBrowser: true,
    handles: { in: true, out: OUT },
    fields: [
      T.textarea('instruction', 'What to look for', {
        required: true,
        placeholder: 'The pagination controls',
      }),
    ],
    outputs: [
      { path: 'matches', label: 'Matches' },
      { path: 'matches[0].selector', label: 'First selector' },
    ],
  },

  'browser.agent': {
    type: 'browser.agent',
    kind: 'action',
    group: 'Browser',
    label: 'Autonomous Agent',
    description: 'Give it a goal; it decides the steps and drives the browser itself.',
    icon: 'Bot',
    accent: '#f43f5e',
    surfaces: ['browser'],
    credits: 25,
    requiresBrowser: true,
    handles: { in: true, out: OUT },
    fields: [
      T.textarea('instruction', 'Goal', {
        required: true,
        placeholder: 'Find the current price of NVDA and the day’s change',
      }),
      T.number('maxSteps', 'Step budget', {
        default: 12,
        max: 40,
        help: 'Hard ceiling on model calls. Each step is charged.',
      }),
    ],
    outputs: [
      { path: 'success', label: 'Success' },
      { path: 'summary', label: 'Summary' },
      { path: 'steps', label: 'Steps taken' },
      { path: 'data', label: 'Anything it collected' },
    ],
  },

  'browser.screenshot': {
    type: 'browser.screenshot',
    kind: 'action',
    group: 'Browser',
    label: 'Screenshot',
    description: 'Capture the page as an image attached to the run.',
    icon: 'Camera',
    accent: '#64748b',
    surfaces: ['browser'],
    credits: 1,
    requiresBrowser: true,
    handles: { in: true, out: OUT },
    fields: [
      T.boolean('fullPage', 'Full page', { default: false }),
    ],
    outputs: [{ path: 'url', label: 'Image URL' }],
  },
};

/** Every node type, as a plain array — the shape the editor palette consumes. */
export const NODE_LIST = Object.values(NODE_REGISTRY);

export function getNodeDef(type) {
  return NODE_REGISTRY[type] || null;
}

export function isKnownType(type) {
  return Object.prototype.hasOwnProperty.call(NODE_REGISTRY, type);
}

/** Types allowed in a workflow of this surface, plus every surface-agnostic one. */
export function typesForSurface(surface) {
  return NODE_LIST.filter(n => n.surfaces.includes(surface)).map(n => n.type);
}

/** True when the graph will need a Chrome session to run. */
export function needsBrowser(nodes = []) {
  return nodes.some(n => getNodeDef(n.type)?.requiresBrowser);
}

/**
 * Per-execution credit price of a node.
 *
 * `browser.agent` is the one variable-cost node: it is a loop, and a loop that
 * runs twelve model calls should not cost the same as one that answers in two.
 * Priced per step actually taken, floored at one so a zero-step agent still
 * pays for the snapshot it read.
 */
export function nodeCredits(type, result = null) {
  const def = getNodeDef(type);
  if (!def) return 0;
  if (type === 'browser.agent' && result?.steps) {
    const perStep = 3;
    return Math.max(perStep, Math.round(perStep * Number(result.steps)));
  }
  return def.credits || 0;
}

/**
 * The manifest as shipped to the browser. Identical to the server's view —
 * there is deliberately no filtering here, because a field the client can't
 * see is a field the user can't fill and the validator will then reject.
 */
export function publicRegistry() {
  return {
    surfaces: SURFACES,
    fieldTypes: FIELD_TYPES,
    nodes: NODE_LIST,
  };
}

export default {
  NODE_REGISTRY,
  NODE_LIST,
  SURFACES,
  getNodeDef,
  isKnownType,
  typesForSurface,
  needsBrowser,
  nodeCredits,
  publicRegistry,
};
