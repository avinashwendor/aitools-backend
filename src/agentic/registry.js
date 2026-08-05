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
    description: 'Runs once every day at the hour you pick (UTC).',
    icon: 'Clock',
    accent: '#3b82f6',
    credits: 0,
    handles: { in: false, out: OUT },
    fields: [
      T.select(
        'atHour',
        'Run at hour (UTC)',
        Array.from({ length: 24 }, (_, hour) => String(hour)),
        {
          default: '9',
          required: true,
          help:
            'Fires once per day at this hour, UTC. Enable “Run on schedule” below ' +
            'and activate the workflow for it to arm.',
        }
      ),
      T.boolean('weekdaysOnly', 'Weekdays only', {
        default: false,
        help:
          'When on, add a Code step right after this trigger that skips Saturday ' +
          'and Sunday (getUTCDay() 0 or 6). The architect does this automatically.',
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
    // `Code2` is lucide's deprecated alias for this; it still resolves, but
    // aliases go away on majors and a missing icon degrades silently to a box.
    icon: 'CodeXml',
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
    outputs: [
      { path: 'result', label: 'Result (true/false)' },
      { path: 'branch', label: 'Branch taken' },
    ],
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
    testable: false,
    /** Its whole job is to take time — the field caps it at 300s, plus slack. */
    timeoutMs: 310_000,
    handles: { in: true, out: OUT },
    fields: [
      T.number('seconds', 'Seconds', { default: 5, required: true, max: 300 }),
    ],
    outputs: [{ path: 'waitedMs', label: 'Waited (ms)' }],
  },

  /*
   * The pair that makes a workflow able to do a job more than once.
   *
   * They are two nodes rather than one because the boundary is the useful part:
   * between them, values are per-iteration, and the only thing that leaves is
   * what Collect gathered. Drawing that on the canvas is what stops someone
   * wiring the fourth iteration's output into an email.
   */
  'core.forEach': {
    type: 'core.forEach',
    kind: 'action',
    group: 'Core',
    label: 'For Each',
    description: 'Repeat the following steps once for every item in a list.',
    icon: 'Repeat',
    accent: '#f97316',
    credits: 0,
    /*
     * Testable, and worth testing.
     *
     * Running the opener does not run the body — it resolves the list and
     * counts it, which is exactly the question a loop gets wrong. `{{
     * fetch.data.items }}` passes reference validation because `data` is a
     * declared output, and then turns out to be an object, or a string, or a
     * list nested one level deeper than assumed. That failure is invisible
     * until a run, and free to catch here.
     */
    handles: { in: true, out: OUT },
    fields: [
      T.text('items', 'List', {
        required: true,
        placeholder: '{{ fetch.data.items }}',
        help: 'A step output that is a list. Each entry becomes {{ each.item }} inside the loop.',
      }),
      T.number('maxItems', 'Stop after', {
        default: 25,
        max: 500,
        help:
          'Every item runs the whole loop body, and every step in it costs credits. This is ' +
          'the ceiling that stops a feed with 4,000 entries from spending your month.',
      }),
      T.number('concurrency', 'At a time', {
        default: 1,
        max: 5,
        help:
          'One at a time is the safe default — most APIs rate-limit, and a loop is exactly ' +
          'where you hit it. Raise it only for endpoints you know tolerate it.',
      }),
    ],
    outputs: [
      { path: 'item', label: 'Current item (as {{ each.item }})' },
      { path: 'total', label: 'Items to process' },
    ],
  },

  'core.collect': {
    type: 'core.collect',
    kind: 'action',
    group: 'Core',
    label: 'Collect',
    description: 'End a loop and gather every iteration’s result into one list.',
    icon: 'Layers',
    accent: '#f97316',
    credits: 0,
    testable: false,
    handles: { in: true, out: OUT },
    fields: [
      T.text('value', 'Keep from each pass', {
        placeholder: '{{ summarise.text }}',
        help:
          'What to gather from one iteration. Leave empty to keep the whole output of the ' +
          'step feeding this one.',
      }),
      T.boolean('skipEmpty', 'Drop empty results', {
        default: true,
        help: 'Iterations that produced nothing are left out of the list rather than padding it.',
      }),
    ],
    outputs: [
      { path: 'items', label: 'Gathered results' },
      { path: 'count', label: 'How many' },
      { path: 'failed', label: 'Iterations that failed' },
    ],
  },

  /*
   * The node that makes a schedule mean anything.
   *
   * A workflow that polls a source on a timer and has no memory re-delivers the
   * same items on every tick — the same ten articles, every hour, forever.
   * That is not a rough edge, it is the schedule trigger being useless for the
   * thing schedules are for, and no amount of graph-building skill works around
   * it because the missing piece is state, not structure.
   */
  'core.dedupe': {
    type: 'core.dedupe',
    kind: 'action',
    group: 'Data',
    label: 'Only New Items',
    description: 'Filter a list down to the items this workflow has never seen before.',
    icon: 'ListFilter',
    accent: '#0ea5e9',
    credits: 0,
    handles: { in: true, out: OUT },
    fields: [
      T.text('items', 'List', {
        required: true,
        placeholder: '{{ rss_1.items }}',
        help: 'The list to filter.',
      }),
      T.text('key', 'Identify each item by', {
        required: true,
        default: 'id',
        placeholder: 'id',
        help:
          'A field on each item that is stable between runs — an id, a URL, a guid. Not a ' +
          'title, which gets edited, and not a date, which is not unique.',
      }),
      T.select('scope', 'Remember for', ['this workflow', 'this step'], {
        default: 'this workflow',
        help: 'Two steps in the same workflow can share one memory, or keep their own.',
      }),
      T.number('rememberDays', 'Forget after (days)', {
        default: 30,
        max: 365,
        help: 'An item not seen for this long counts as new again.',
      }),
      T.boolean('markOnly', 'Preview without remembering', {
        default: false,
        help:
          'Report what is new but do not record it, so the next run sees the same items. For ' +
          'testing a workflow without burning through the backlog.',
      }),
    ],
    outputs: [
      { path: 'items', label: 'New items only' },
      { path: 'count', label: 'How many are new' },
      { path: 'skipped', label: 'How many were already seen' },
    ],
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
    /**
     * Above the provider's own agentic timeout, so a slow model call fails as
     * "the model timed out" rather than as a node the runner killed first —
     * which reads as our bug and hides theirs.
     */
    timeoutMs: 240_000,
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
      { path: 'model', label: 'Model that answered' },
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
    testable: false,
    /**
     * A loop of up to forty model calls, each of which may read a page. No
     * per-node ceiling that also protects an HTTP call could contain it, so
     * this one is governed by the run's own deadline instead — and its loop
     * already bounds itself by steps, which is the meaningful limit here.
     */
    timeoutMs: 0,
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
      { path: 'finishReason', label: 'Why it stopped' },
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
    sideEffects: true,
    handles: { in: true, out: OUT },
    fields: [
      T.text('to', 'To', {
        required: true,
        userSupplied: true,
        placeholder: 'you@example.com',
        help: 'Sent through the server mail integration — no API key field on this node.',
      }),
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
    sideEffects: true,
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
    sideEffects: true,
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
    sideEffects: true,
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
    sideEffects: true,
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
 * Does running this node change the world?
 *
 * Declared here rather than inferred, because two separate parts of the system
 * need the answer and getting it wrong is expensive in both. The runner asks
 * before retrying a step that failed halfway — a retried email is a second
 * email, which cannot be taken back. The architect asks before test-running a
 * step while building — a build that posts to a live Slack channel to check its
 * work is a far worse bug than an unverified node.
 *
 * Absent means no side effects, so a new read-only node is safe by default and
 * a new delivering one has to say so. That is the right way round: forgetting
 * the flag on a reader costs nothing, and the flag is the first thing anyone
 * writes when adding an integration that sends something.
 */
export function hasSideEffects(type) {
  return Boolean(getNodeDef(type)?.sideEffects);
}

/**
 * How long one execution of this node may take.
 *
 * A single ceiling for every node type cannot work, because "too long" means
 * something different per node: two minutes is patient for an HTTP call and
 * absurd for a Wait step configured to pause for five. Declaring it here rather
 * than in the runner keeps the answer next to the node whose behaviour decides
 * it — the alternative is a runner that special-cases three types and silently
 * strangles the fourth one somebody adds.
 *
 * @param {string} type
 * @param {number} fallback  the deployment-wide default
 */
export function nodeTimeoutMs(type, fallback) {
  return getNodeDef(type)?.timeoutMs ?? fallback;
}

/**
 * May the architect execute this node while building?
 *
 * Side effects rule a node out. So does `testable: false`, which is for the
 * nodes that are safe but not worth running — `core.agent` would spend a dozen
 * model calls inside a build the user is already paying for, and `core.delay`
 * would do nothing except take as long as it says.
 */
export function isTestable(type) {
  const def = getNodeDef(type);
  return Boolean(def) && !def.sideEffects && def.testable !== false;
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
  hasSideEffects,
  isTestable,
  nodeTimeoutMs,
  nodeCredits,
  publicRegistry,
};
