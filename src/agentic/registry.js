/**
 * Node registry — the manifest every other part of the agentic system reads.
 *
 * One entry per node type, and it is the *only* place a node type is described.
 * The executor map keys off it, the graph validator checks required fields
 * against it, the credit meter reads `credits` from it, the architect agent
 * builds its prompt from it, and the editor palette and inspector are rendered
 * entirely from it (served verbatim at `GET /api/agents/registry`). Adding a
 * node means adding an entry here and an executor with the matching key — no UI
 * change, no migration.
 *
 * Shipping the manifest to the browser is what removes a whole class of drift:
 * the inspector cannot render a field the validator doesn't know about, because
 * it is the same object.
 *
 * `icon` is a lucide-react export name, resolved on the client. Keeping it a
 * string is what lets the manifest cross the wire at all.
 */

/**
 * Field types the inspector knows how to render. `credential` renders a picker
 * scoped to `provider`, and only ever carries a credential id — a secret never
 * enters a graph document.
 */
export const FIELD_TYPES = ['text', 'textarea', 'select', 'number', 'boolean', 'json', 'code', 'credential'];

/** Palette sections, in the order the editor shows them. */
export const GROUPS = ['Triggers', 'Core', 'Intelligence', 'Data', 'Deliver'];

/**
 * Credits charged per successful execution of a node, on top of the flat
 * `agent.run` fee.
 *
 * Derived the same way as the chat costs in `billing/plans.js`: from measured
 * provider cost at roughly a 4× markup. Three tiers:
 *
 *   • 0     deterministic and effectively free to us (templates, code, branches).
 *   • 1–2   a network call we pay for in bandwidth and a worker slot.
 *   • 4+    an LLM call. `core.agent` runs an autonomous loop of up to
 *           `maxSteps` model calls, which is why it is priced per step taken.
 */

const T = {
  text: (key, label, opts = {}) => ({ key, label, type: 'text', ...opts }),
  textarea: (key, label, opts = {}) => ({ key, label, type: 'textarea', ...opts }),
  select: (key, label, options, opts = {}) => ({ key, label, type: 'select', options, ...opts }),
  number: (key, label, opts = {}) => ({ key, label, type: 'number', ...opts }),
  boolean: (key, label, opts = {}) => ({ key, label, type: 'boolean', ...opts }),
  json: (key, label, opts = {}) => ({ key, label, type: 'json', ...opts }),
  code: (key, label, opts = {}) => ({ key, label, type: 'code', ...opts }),
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

  // ─── Core ──────────────────────────────────────────────────

  'core.http': {
    type: 'core.http',
    kind: 'action',
    group: 'Core',
    label: 'HTTP Request',
    description: 'Call any REST API. The response is available to every later step.',
    icon: 'Globe',
    accent: '#10b981',
    credits: 1,
    handles: { in: true, out: OUT },
    fields: [
      T.text('url', 'URL', { required: true, placeholder: 'https://api.example.com/items' }),
      T.select('method', 'Method', ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], { default: 'GET' }),
      T.json('headers', 'Headers', { placeholder: '{ "Accept": "application/json" }' }),
      T.textarea('body', 'Body', { placeholder: '{ "name": "{{ trigger.name }}" }' }),
      T.credential('credentialId', 'Auth credential', 'http', {
        help: 'Optional. Applied as a header or query parameter — never written into the graph.',
      }),
    ],
    outputs: [
      { path: 'status', label: 'Status code' },
      { path: 'ok', label: 'Succeeded (2xx)' },
      { path: 'data', label: 'Response body' },
      { path: 'headers', label: 'Response headers' },
    ],
  },

  'core.code': {
    type: 'core.code',
    kind: 'action',
    group: 'Core',
    label: 'Code',
    description: 'Reshape data with JavaScript. Map, filter, pick fields, do maths.',
    icon: 'Code2',
    accent: '#0ea5e9',
    credits: 0,
    handles: { in: true, out: OUT },
    fields: [
      T.code('script', 'JavaScript', {
        required: true,
        language: 'javascript',
        default: '// `input` is the previous step. `steps` holds every step by id.\nreturn input;',
        help:
          'Runs in a sandbox with no network and no filesystem. Return the value you want ' +
          'downstream. Available: input, steps, trigger.',
      }),
    ],
    outputs: [{ path: 'result', label: 'Returned value' }],
  },

  'core.template': {
    type: 'core.template',
    kind: 'action',
    group: 'Core',
    label: 'Set / Template',
    description: 'Build a value from earlier output. No model call, no cost.',
    icon: 'Braces',
    accent: '#64748b',
    credits: 0,
    handles: { in: true, out: OUT },
    fields: [
      T.textarea('value', 'Value', {
        required: true,
        placeholder: '{{ llm_1.text }} — sourced from {{ http_1.data.url }}',
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
    credits: 0,
    handles: { in: true, out: OUT },
    fields: [
      T.number('seconds', 'Seconds', { default: 5, required: true, max: 300 }),
    ],
    outputs: [{ path: 'waitedMs', label: 'Waited (ms)' }],
  },

  // ─── Intelligence ──────────────────────────────────────────

  'core.llm': {
    type: 'core.llm',
    kind: 'action',
    group: 'Intelligence',
    label: 'AI Step',
    description: 'Ask a model to write, summarise, classify or reshape data. One call.',
    icon: 'Sparkles',
    accent: '#8b5cf6',
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

  'core.agent': {
    type: 'core.agent',
    kind: 'action',
    group: 'Intelligence',
    label: 'AI Agent',
    description:
      'Give it a goal and it works out the steps itself — searching the web and calling APIs until it has an answer.',
    icon: 'Bot',
    accent: '#f43f5e',
    credits: 12,
    handles: { in: true, out: OUT },
    fields: [
      T.textarea('goal', 'Goal', {
        required: true,
        placeholder: 'Find the three most-discussed AI video tools this week and summarise each.',
      }),
      T.textarea('context', 'Context to hand it', {
        placeholder: '{{ http_1.data }}',
        help: 'Optional. Data from earlier steps the agent should start from.',
      }),
      T.select('tools', 'Tools it may use', ['search', 'fetch', 'search + fetch', 'none'], {
        default: 'search + fetch',
        help: '“fetch” lets it call public HTTP endpoints. It can never reach your private network.',
      }),
      T.number('maxSteps', 'Step budget', {
        default: 8,
        max: 20,
        help: 'Hard ceiling on model calls. Each step is charged.',
      }),
      T.json('schema', 'Answer shape (optional)', {
        placeholder: '{ "tools": [{ "name": "string", "why": "string" }] }',
        help: 'Describe the JSON you want back and the answer is coerced to it.',
      }),
    ],
    outputs: [
      { path: 'success', label: 'Success' },
      { path: 'answer', label: 'Answer text' },
      { path: 'data', label: 'Structured answer' },
      { path: 'steps', label: 'Steps taken' },
      { path: 'sources', label: 'URLs it used' },
    ],
  },

  // ─── Data ──────────────────────────────────────────────────

  'core.websearch': {
    type: 'core.websearch',
    kind: 'action',
    group: 'Data',
    label: 'Web Search',
    description: 'Search the live web and hand the results downstream.',
    icon: 'Search',
    accent: '#ec4899',
    credits: 2,
    handles: { in: true, out: OUT },
    fields: [
      T.text('query', 'Query', { required: true, placeholder: 'best AI video editors {{ trigger.month }}' }),
      T.number('limit', 'Results', { default: 5, max: 10 }),
    ],
    outputs: [
      { path: 'results', label: 'Results' },
      { path: 'text', label: 'Results as text' },
      { path: 'count', label: 'Count' },
    ],
  },

  'core.fetchPage': {
    type: 'core.fetchPage',
    kind: 'action',
    group: 'Data',
    label: 'Read Page',
    description: 'Fetch a public page and return its readable text — docs, articles, changelogs.',
    icon: 'FileText',
    accent: '#0ea5e9',
    credits: 1,
    handles: { in: true, out: OUT },
    fields: [
      T.text('url', 'URL', { required: true, placeholder: 'https://example.com/docs/api' }),
      T.number('maxChars', 'Max characters', { default: 8000, max: 40000 }),
    ],
    outputs: [
      { path: 'title', label: 'Page title' },
      { path: 'text', label: 'Readable text' },
      { path: 'url', label: 'Final URL' },
    ],
  },

  'core.rss': {
    type: 'core.rss',
    kind: 'action',
    group: 'Data',
    label: 'RSS Feed',
    description: 'Read the latest items from an RSS or Atom feed.',
    icon: 'Rss',
    accent: '#f59e0b',
    credits: 1,
    handles: { in: true, out: OUT },
    fields: [
      T.text('url', 'Feed URL', { required: true, placeholder: 'https://news.ycombinator.com/rss' }),
      T.number('limit', 'Items', { default: 10, max: 50 }),
    ],
    outputs: [
      { path: 'items', label: 'Items' },
      { path: 'count', label: 'Count' },
    ],
  },

  'core.catalog': {
    type: 'core.catalog',
    kind: 'action',
    group: 'Data',
    label: 'Search Tool Catalog',
    description: 'Search our AI tool catalog and use the matches downstream.',
    icon: 'LayoutGrid',
    accent: '#ec4899',
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

  // ─── Deliver ───────────────────────────────────────────────

  'core.email': {
    type: 'core.email',
    kind: 'action',
    group: 'Deliver',
    label: 'Send Email',
    description: 'Email a result to yourself or a teammate.',
    icon: 'Mail',
    accent: '#14b8a6',
    credits: 2,
    handles: { in: true, out: OUT },
    fields: [
      T.text('to', 'To', { required: true, placeholder: 'you@example.com' }),
      T.text('subject', 'Subject', { required: true, placeholder: 'Your daily digest' }),
      T.textarea('body', 'Body', { required: true, placeholder: '{{ llm_1.text }}' }),
    ],
    outputs: [{ path: 'id', label: 'Message id' }],
  },

  'core.slack': {
    type: 'core.slack',
    kind: 'action',
    group: 'Deliver',
    label: 'Slack',
    description: 'Post a message to Slack via an incoming webhook.',
    icon: 'Hash',
    accent: '#4A154B',
    credits: 1,
    handles: { in: true, out: OUT },
    fields: [
      T.text('webhookUrl', 'Webhook URL', {
        required: true,
        placeholder: 'https://hooks.slack.com/services/…',
        help: 'Slack App → Incoming Webhooks.',
      }),
      T.textarea('content', 'Message', {
        required: true,
        placeholder: '{{ llm_1.text }}',
        help: 'Supports {{ node.path }} templates.',
      }),
    ],
    outputs: [{ path: 'messageContent', label: 'Sent message' }],
  },

  'core.discord': {
    type: 'core.discord',
    kind: 'action',
    group: 'Deliver',
    label: 'Discord',
    description: 'Send a message to a Discord channel via webhook.',
    icon: 'MessageSquare',
    accent: '#5865F2',
    credits: 1,
    handles: { in: true, out: OUT },
    fields: [
      T.text('webhookUrl', 'Webhook URL', {
        required: true,
        placeholder: 'https://discord.com/api/webhooks/…',
        help: 'Channel Settings → Integrations → Webhooks.',
      }),
      T.textarea('content', 'Message', {
        required: true,
        placeholder: '{{ llm_1.text }}',
        help: 'Supports {{ node.path }} templates.',
      }),
      T.text('username', 'Bot username', { placeholder: 'Optional override' }),
    ],
    outputs: [{ path: 'messageContent', label: 'Sent message' }],
  },

  'core.telegram': {
    type: 'core.telegram',
    kind: 'action',
    group: 'Deliver',
    label: 'Telegram',
    description: 'Send a message from your bot to a chat or channel.',
    icon: 'Send',
    accent: '#229ED9',
    credits: 1,
    handles: { in: true, out: OUT },
    fields: [
      T.credential('credentialId', 'Bot token', 'telegram', {
        required: true,
        help: 'Create a bot with @BotFather and store the token as a credential.',
      }),
      T.text('chatId', 'Chat ID', {
        required: true,
        placeholder: '-1001234567890',
        help: 'Message your bot, then read the id from getUpdates.',
      }),
      T.textarea('content', 'Message', { required: true, placeholder: '{{ llm_1.text }}' }),
    ],
    outputs: [
      { path: 'messageId', label: 'Message id' },
      { path: 'messageContent', label: 'Sent message' },
    ],
  },

  'core.notion': {
    type: 'core.notion',
    kind: 'action',
    group: 'Deliver',
    label: 'Notion',
    description: 'Add a page to a Notion database.',
    icon: 'NotebookPen',
    accent: '#0f172a',
    credits: 1,
    handles: { in: true, out: OUT },
    fields: [
      T.credential('credentialId', 'Integration token', 'notion', {
        required: true,
        help: 'notion.so/my-integrations → Internal integration secret. Share the database with it.',
      }),
      T.text('databaseId', 'Database ID', {
        required: true,
        placeholder: '1f2e3d4c5b6a7890…',
        help: 'The 32-character id in the database URL.',
      }),
      T.text('title', 'Title', { required: true, placeholder: '{{ llm_1.text }}' }),
      T.textarea('content', 'Body', { placeholder: 'Optional page body.' }),
      T.json('properties', 'Extra properties', {
        placeholder: '{ "Status": { "select": { "name": "New" } } }',
        help: 'Raw Notion property values, merged into the page.',
      }),
    ],
    outputs: [
      { path: 'id', label: 'Page id' },
      { path: 'url', label: 'Page URL' },
    ],
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

/**
 * Per-execution credit price of a node.
 *
 * `core.agent` is the one variable-cost node: it is a loop, and a loop that
 * runs eight model calls should not cost the same as one that answers in two.
 * Priced per step actually taken, floored at one step so an agent that answers
 * immediately still pays for the call it made.
 */
export function nodeCredits(type, result = null) {
  const def = getNodeDef(type);
  if (!def) return 0;
  if (type === 'core.agent') {
    const perStep = 4;
    return perStep * Math.max(1, Number(result?.steps) || 1);
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
    groups: GROUPS,
    fieldTypes: FIELD_TYPES,
    nodes: NODE_LIST,
  };
}

export default {
  NODE_REGISTRY,
  NODE_LIST,
  GROUPS,
  FIELD_TYPES,
  getNodeDef,
  isKnownType,
  nodeCredits,
  publicRegistry,
};
