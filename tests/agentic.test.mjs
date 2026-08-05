/**
 * Agentic engine tests — graph ordering, templating, registry integrity, the
 * architect's operation applier and the code sandbox.
 *
 * No database, no LLM, no network. Everything here is pure derivation, which is
 * deliberate: these are the parts where a bug is silent. A wrong topological
 * order or a placeholder that resolves to the string "undefined" doesn't throw,
 * it produces a run that completes and is wrong — and the only place that gets
 * caught cheaply is here.
 *
 *   npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  NODE_REGISTRY,
  NODE_LIST,
  GROUPS,
  getNodeDef,
  nodeCredits,
  nodeTimeoutMs,
  hasSideEffects,
  isTestable,
  publicRegistry,
} from '../src/agentic/registry.js';
import { topoSort, validateGraph, findOrphans, suggestNodeId, ancestors } from '../src/agentic/graph.js';
import { analyzeReferences } from '../src/agentic/references.js';
import { findRegions, coerceItems } from '../src/agentic/regions.js';
import { classifyFailure, withRetry, parseRetryAfter, backoffMs } from '../src/agentic/retry.js';
import { withTimeout } from '../src/utils/deadline.js';
import { interpolate, interpolateDeep, resolveValues, getByPath } from '../src/agentic/interpolate.js';
import { applyOperations, describeGraph } from '../src/agentic/operations.js';
import { executorTypes } from '../src/agentic/executors.js';
import { assertUrlAllowed, capOutput } from '../src/agentic/safety.js';
import { computeNextRun } from '../src/agentic/queue.js';
import { runScript } from '../src/agentic/sandbox.js';
import { defineTool, safeCutPoint, estimateTokens } from '../src/ai/agentLoop.js';

const node = (id, type, values = {}) => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { title: '', values, note: '' },
});
const edge = (source, target, sourceHandle = 'main') => ({
  id: `${source}-${target}`,
  source,
  target,
  sourceHandle,
  targetHandle: 'in',
});

// ─────────────────────────────────────────────────────────────
describe('node registry', () => {
  test('every registry type has an executor', () => {
    for (const type of Object.keys(NODE_REGISTRY)) {
      assert.ok(
        executorTypes.includes(type),
        `"${type}" is in the registry but has no executor — it would fail at run time.`
      );
    }
  });

  test('every executor has a registry entry', () => {
    for (const type of executorTypes) {
      assert.ok(getNodeDef(type), `"${type}" has an executor but no registry entry.`);
    }
  });

  test('node definitions are internally consistent', () => {
    for (const def of NODE_LIST) {
      assert.ok(GROUPS.includes(def.group), `${def.type} is in unknown group "${def.group}"`);
      assert.ok(def.handles.out.length, `${def.type} has no outputs`);
      assert.equal(def.kind === 'trigger', def.handles.in === false,
        `${def.type}: triggers must have no input, actions must have one`);
      for (const field of def.fields) {
        assert.ok(field.key && field.label, `${def.type} has a field missing key or label`);
      }
    }
  });

  test('nothing browser-shaped survives in the palette', () => {
    for (const def of NODE_LIST) {
      assert.ok(!def.type.startsWith('browser.'), `${def.type} is still registered`);
    }
  });

  /**
   * The manifest is the contract with the editor: the palette, the inspector
   * and the validator all render from it. A field the browser can't describe
   * shows up as an empty input the user cannot fill in.
   */
  test('the public manifest carries everything the editor renders from', () => {
    const manifest = publicRegistry();
    assert.ok(manifest.groups.length);
    assert.equal(manifest.nodes.length, NODE_LIST.length);
    for (const def of manifest.nodes) {
      assert.ok(def.type && def.label && def.group);
      assert.ok(Array.isArray(def.fields) && Array.isArray(def.handles.out));
    }
  });

  test('agent credits scale with steps actually taken', () => {
    const short = nodeCredits('core.agent', { steps: 2 });
    const long = nodeCredits('core.agent', { steps: 12 });
    assert.ok(long > short, 'a 12-step agent must cost more than a 2-step one');
    assert.ok(nodeCredits('core.agent', { steps: 0 }) > 0, 'a zero-step agent still costs');
    assert.equal(nodeCredits('core.template'), 0, 'deterministic nodes are free');
  });
});

// ─────────────────────────────────────────────────────────────
describe('graph ordering', () => {
  test('orders nodes so dependencies come first', () => {
    const nodes = [node('c', 'core.llm'), node('a', 'trigger.manual'), node('b', 'core.http')];
    const edges = [edge('a', 'b'), edge('b', 'c')];
    assert.deepEqual(topoSort(nodes, edges).map(n => n.id), ['a', 'b', 'c']);
  });

  test('is stable — the same graph orders the same way twice', () => {
    const nodes = [node('a', 'trigger.manual'), node('b', 'core.http'), node('c', 'core.http')];
    const edges = [edge('a', 'b'), edge('a', 'c')];
    const first = topoSort(nodes, edges).map(n => n.id);
    const second = topoSort(nodes, edges).map(n => n.id);
    assert.deepEqual(first, second);
  });

  test('reports which nodes form a cycle rather than just failing', () => {
    const nodes = [node('a', 'trigger.manual'), node('b', 'core.http'), node('c', 'core.http')];
    const edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'b')];
    assert.throws(
      () => topoSort(nodes, edges),
      err => {
        assert.equal(err.code, 'GRAPH_CYCLE');
        assert.deepEqual(err.cycle.sort(), ['b', 'c']);
        return true;
      }
    );
  });

  test('ignores edges pointing at deleted nodes', () => {
    const nodes = [node('a', 'trigger.manual'), node('b', 'core.http')];
    const edges = [edge('a', 'b'), edge('b', 'ghost')];
    assert.deepEqual(topoSort(nodes, edges).map(n => n.id), ['a', 'b']);
  });

  test('finds nodes the trigger cannot reach', () => {
    const nodes = [node('a', 'trigger.manual'), node('b', 'core.http'), node('lost', 'core.llm')];
    assert.deepEqual(findOrphans(nodes, [edge('a', 'b')]), ['lost']);
  });

  test('ancestors walks the whole upstream chain', () => {
    const edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'd')];
    assert.deepEqual(ancestors(edges, 'd').sort(), ['a', 'b', 'c']);
  });

  test('suggested ids do not collide', () => {
    assert.equal(suggestNodeId('core.http', []), 'http_1');
    assert.equal(suggestNodeId('core.http', ['http_1', 'http_2']), 'http_3');
  });
});

// ─────────────────────────────────────────────────────────────
describe('graph validation', () => {
  const valid = {
    nodes: [node('t', 'trigger.manual'), node('h', 'core.http', { url: 'https://x.dev' })],
    edges: [edge('t', 'h')],
  };

  test('accepts a well-formed graph', () => {
    assert.deepEqual(validateGraph(valid).errors, []);
  });

  test('requires exactly one trigger', () => {
    const two = {
      nodes: [node('t1', 'trigger.manual'), node('t2', 'trigger.webhook'), node('h', 'core.http', { url: 'https://x.dev' })],
      edges: [edge('t1', 'h')],
    };
    assert.match(validateGraph(two).errors.join(' '), /Only one trigger/);
    assert.match(validateGraph({ nodes: [node('h', 'core.http', { url: 'https://x.dev' })], edges: [] }).errors.join(' '), /needs a trigger/);
  });

  test('catches a required field left blank', () => {
    const missing = { nodes: [node('t', 'trigger.manual'), node('h', 'core.http')], edges: [edge('t', 'h')] };
    assert.match(validateGraph(missing).errors.join(' '), /missing URL/i);
  });

  /**
   * Workflows saved before browser support was removed still exist in the
   * database. Opening one has to say what happened, because the alternative is
   * an unrecognised node type and a graph the editor silently drops.
   */
  test('a workflow saved with browser nodes explains itself', () => {
    const legacy = {
      nodes: [node('t', 'trigger.manual'), node('b', 'browser.act', { instruction: 'click' })],
      edges: [edge('t', 'b')],
    };
    assert.match(validateGraph(legacy).errors.join(' '), /no longer runs/);
  });

  test('rejects an edge from a handle the node does not have', () => {
    const bad = {
      nodes: [node('t', 'trigger.manual'), node('h', 'core.http', { url: 'https://x.dev' })],
      edges: [edge('t', 'h', 'false')],
    };
    assert.match(validateGraph(bad).errors.join(' '), /no “false” output/);
  });

  test('an unreachable node warns but does not block the run', () => {
    const orphaned = {
      nodes: [...valid.nodes, node('lost', 'core.template', { value: 'x' })],
      edges: valid.edges,
    };
    const result = validateGraph(orphaned);
    assert.deepEqual(result.errors, []);
    assert.match(result.warnings.join(' '), /won’t run/);
  });

  test('architect mode promotes orphans to errors and softens credentials', () => {
    const orphaned = {
      nodes: [...valid.nodes, node('lost', 'core.template', { value: 'x' })],
      edges: valid.edges,
    };
    const result = validateGraph(orphaned, { mode: 'architect' });
    assert.match(result.errors.join(' '), /won’t run/);

    const requirements = [{ key: 'notion_token', label: 'Notion token', credentialId: null }];
    const creds = validateGraph(valid, { mode: 'architect', requirements });
    assert.deepEqual(creds.errors, []);
    assert.match(creds.warnings.join(' '), /Notion token/);
  });

  test('architect mode allows empty userSupplied email To as a warning', () => {
    const withEmail = {
      nodes: [
        node('t', 'trigger.manual'),
        node('m', 'core.email', { subject: 'Hi', body: 'Body' }),
      ],
      edges: [edge('t', 'm')],
    };
    const runMode = validateGraph(withEmail);
    assert.match(runMode.errors.join(' '), /missing To/i);

    const arch = validateGraph(withEmail, { mode: 'architect' });
    assert.ok(!arch.errors.some(e => /missing To/i.test(e)));
    assert.match(arch.warnings.join(' '), /To/);
  });

  /**
   * The architect declares what secrets a workflow needs; the user supplies
   * them afterwards. Until they do, pressing Run has to fail here rather than
   * three nodes in with an opaque 401 from someone else's API.
   */
  test('an unfulfilled credential requirement blocks the run', () => {
    const requirements = [{ key: 'notion_token', label: 'Notion token', credentialId: null, usedBy: ['h'] }];
    const result = validateGraph(valid, { requirements });
    assert.match(result.errors.join(' '), /Notion token/);

    const fulfilled = [{ ...requirements[0], credentialId: 'abc123' }];
    assert.deepEqual(validateGraph(valid, { requirements: fulfilled }).errors, []);
  });
});

// ─────────────────────────────────────────────────────────────
describe('templating', () => {
  const scope = {
    trigger: { email: 'a@b.dev' },
    http_1: { status: 200, data: { items: [{ id: 7, name: 'Widget' }] } },
    llm_1: { text: 'hello' },
  };

  test('substitutes dotted and indexed paths', () => {
    assert.equal(interpolate('id={{ http_1.data.items[0].id }}', scope), 'id=7');
    assert.equal(interpolate('{{ trigger.email }}', scope), 'a@b.dev');
  });

  test('a missing path renders empty, never "undefined"', () => {
    assert.equal(interpolate('[{{ nope.gone }}]', scope), '[]');
  });

  test('objects are JSON-encoded so they survive inside prose', () => {
    assert.equal(interpolate('{{ http_1.data.items[0] }}', scope), '{"id":7,"name":"Widget"}');
  });

  test('filters apply left to right', () => {
    assert.equal(interpolate('{{ llm_1.text | upper }}', scope), 'HELLO');
    assert.equal(interpolate('{{ http_1.data.items | count }}', scope), '1');
    assert.equal(interpolate('{{ missing.thing | default: n/a }}', scope), 'n/a');
  });

  test('prototype-walking paths resolve to nothing', () => {
    assert.equal(getByPath(scope, '__proto__.polluted'), undefined);
    assert.equal(getByPath(scope, 'constructor.name'), undefined);
  });

  test('interpolateDeep leaves object keys alone', () => {
    const result = interpolateDeep({ '{{ llm_1.text }}': '{{ llm_1.text }}' }, scope);
    assert.deepEqual(result, { '{{ llm_1.text }}': 'hello' });
  });

  test('JSON fields are parsed after substitution, so a placeholder can be a number', () => {
    const fields = getNodeDef('core.http').fields;
    const resolved = resolveValues(
      { url: 'https://x.dev', headers: '{ "X-Id": "{{ http_1.status }}" }' },
      fields,
      scope
    );
    assert.deepEqual(resolved.headers, { 'X-Id': '200' });
  });

  test('a field left untouched falls back to its registry default', () => {
    const fields = getNodeDef('core.http').fields;
    assert.equal(resolveValues({ url: 'https://x.dev' }, fields, scope).method, 'GET');
  });

  test('unparseable JSON is a clear error, not a silent empty object', () => {
    const fields = getNodeDef('core.http').fields;
    assert.throws(
      () => resolveValues({ url: 'https://x.dev', headers: '{ oops' }, fields, scope),
      /not valid JSON/
    );
  });
});

// ─────────────────────────────────────────────────────────────
describe('graph operations', () => {
  const base = { nodes: [node('t', 'trigger.manual')], edges: [] };

  test('adds and connects a node', () => {
    const { graph } = applyOperations(base, [
      { op: 'addNode', id: 'h1', type: 'core.http', values: { url: 'https://x.dev' } },
      { op: 'connect', from: 't', to: 'h1' },
    ]);
    assert.equal(graph.nodes.length, 2);
    assert.equal(graph.edges.length, 1);
    assert.equal(graph.nodes[1].data.values.url, 'https://x.dev');
  });

  test('refuses a second trigger instead of stacking them', () => {
    const { graph, rejected } = applyOperations(base, [
      { op: 'addNode', id: 's1', type: 'trigger.schedule', values: { atHour: '8' } },
    ]);
    assert.equal(rejected.length, 1);
    assert.match(rejected[0], /Only one trigger/);
    assert.equal(graph.nodes.length, 1);
  });

  test('describeGraph surfaces orphan diagnostics', () => {
    const graph = {
      nodes: [
        node('t', 'trigger.manual'),
        node('h', 'core.http', { url: 'https://x.dev' }),
        node('lost', 'core.template', { value: 'x' }),
      ],
      edges: [edge('t', 'h')],
    };
    const text = describeGraph(graph);
    assert.match(text, /ORPHANS/);
    assert.match(text, /lost/);
  });

  test('an edit preserves untouched nodes and their positions', () => {
    const positioned = {
      nodes: [{ ...node('t', 'trigger.manual'), position: { x: 999, y: 42 } }],
      edges: [],
    };
    const { graph } = applyOperations(positioned, [
      { op: 'addNode', id: 'h1', type: 'core.http', values: { url: 'https://x.dev' } },
    ]);
    assert.deepEqual(graph.nodes[0].position, { x: 999, y: 42 });
  });

  test('unknown node types are rejected individually, not fatally', () => {
    const { graph, rejected } = applyOperations(base, [
      { op: 'addNode', id: 'x', type: 'core.doesNotExist' },
      { op: 'addNode', id: 'h1', type: 'core.http', values: { url: 'https://x.dev' } },
    ]);
    assert.equal(rejected.length, 1);
    assert.equal(graph.nodes.length, 2, 'the valid op still applied');
  });

  test('invented field names are dropped', () => {
    const { graph } = applyOperations(base, [
      { op: 'addNode', id: 'h1', type: 'core.http', values: { url: 'https://x.dev', hacked: 'yes' } },
    ]);
    assert.equal(graph.nodes[1].data.values.hacked, undefined);
  });

  test('a colliding id gets a fresh one instead of shadowing', () => {
    const { graph } = applyOperations(base, [{ op: 'addNode', id: 't', type: 'core.http', values: {} }]);
    assert.notEqual(graph.nodes[1].id, 't');
  });

  test('updateNode merges values rather than replacing them', () => {
    const { graph } = applyOperations(base, [
      { op: 'addNode', id: 'h1', type: 'core.http', values: { url: 'https://x.dev', method: 'POST' } },
      { op: 'updateNode', id: 'h1', values: { url: 'https://y.dev' } },
    ]);
    assert.equal(graph.nodes[1].data.values.url, 'https://y.dev');
    assert.equal(graph.nodes[1].data.values.method, 'POST', 'the untouched field survived');
  });

  test('deleting a node takes its edges with it', () => {
    const wired = {
      nodes: [node('t', 'trigger.manual'), node('h', 'core.http', { url: 'https://x.dev' })],
      edges: [edge('t', 'h')],
    };
    const { graph } = applyOperations(wired, [{ op: 'deleteNode', id: 'h' }]);
    assert.equal(graph.nodes.length, 1);
    assert.equal(graph.edges.length, 0);
  });

  test('connecting through a handle the node lacks is rejected', () => {
    const wired = { nodes: [node('t', 'trigger.manual'), node('h', 'core.http', { url: 'https://x.dev' })], edges: [] };
    const { graph, rejected } = applyOperations(wired, [
      { op: 'connect', from: 't', to: 'h', handle: 'false' },
    ]);
    assert.equal(graph.edges.length, 0);
    assert.match(rejected.join(' '), /no "false" output/);
  });

  test('connecting twice does not duplicate the edge', () => {
    const { graph } = applyOperations(
      { nodes: [node('t', 'trigger.manual'), node('h', 'core.http', { url: 'https://x.dev' })], edges: [] },
      [{ op: 'connect', from: 't', to: 'h' }, { op: 'connect', from: 't', to: 'h' }]
    );
    assert.equal(graph.edges.length, 1);
  });

  /**
   * `describeGraph` is what the architect reads back between edits. If it
   * omitted the configured values, the model would re-derive them from its own
   * earlier tool calls — which is exactly the memory we don't trust.
   */
  test('describeGraph renders ids, types, wiring and values', () => {
    const { graph } = applyOperations(base, [
      { op: 'addNode', id: 'h1', type: 'core.http', values: { url: 'https://x.dev' } },
      { op: 'connect', from: 't', to: 'h1' },
    ]);
    const described = describeGraph(graph);
    const text = JSON.stringify(described);
    assert.match(text, /h1/);
    assert.match(text, /core\.http/);
    assert.match(text, /x\.dev/);
  });
});

// ─────────────────────────────────────────────────────────────
describe('code sandbox', () => {
  test('returns what the script returns', async () => {
    const result = await runScript('return input.a + input.b;', { input: { a: 2, b: 3 } });
    assert.equal(result, 5);
  });

  test('async scripts are awaited', async () => {
    const result = await runScript('return await Promise.resolve("done");', {});
    assert.equal(result, 'done');
  });

  test('a thrown error comes back as a message, not a crash', async () => {
    await assert.rejects(() => runScript('throw new Error("nope");', {}), /nope/);
  });

  /**
   * The whole point of the child process. `process.env` inside the sandbox must
   * not be able to see the API keys the server was started with — a user-authored
   * script that can read them can exfiltrate them with one fetch.
   */
  test('the host environment is not visible', async () => {
    process.env.SANDBOX_CANARY = 'leaked';
    try {
      const result = await runScript('return typeof process === "undefined" ? "no process" : (process.env.SANDBOX_CANARY || "empty");', {});
      assert.notEqual(result, 'leaked');
    } finally {
      delete process.env.SANDBOX_CANARY;
    }
  });

  test('an infinite loop is killed rather than hanging the run', async () => {
    await assert.rejects(() => runScript('while (true) {}', {}, { timeoutMs: 500 }), /too long|timed out/i);
  });
});

// ─────────────────────────────────────────────────────────────
describe('tool definitions', () => {
  /**
   * Tools are handed to the provider as JSON Schema. A malformed one is
   * rejected by the API with a 400 that mentions neither the tool nor the
   * field, which is a miserable thing to debug at run time.
   */
  test('defineTool produces a valid function schema', () => {
    const tool = defineTool({
      description: 'Do a thing.',
      properties: { url: { type: 'string', description: 'Where.' } },
      required: ['url'],
      run: async () => ({ ok: true }),
    });
    assert.equal(tool.parameters.type, 'object');
    assert.deepEqual(tool.parameters.required, ['url']);
    assert.equal(tool.parameters.properties.url.type, 'string');
    assert.equal(typeof tool.run, 'function');
  });

  test('a terminal tool is marked as one, so the loop knows to stop', () => {
    const tool = defineTool({ description: 'End.', run: async () => ({}), terminal: true });
    assert.equal(tool.terminal, true);
  });
});

// ─────────────────────────────────────────────────────────────
describe('transcript compaction', () => {
  /**
   * The wire format requires every `tool` message to follow the assistant turn
   * that called it. Cutting between them produces a 400 naming a
   * `tool_call_id` — and only on long runs, which are the ones you least want
   * to lose. So the cut point is the part worth testing directly.
   */
  const transcript = [
    { role: 'system', content: 'rules' },
    { role: 'user', content: 'build me a thing' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'a', function: { name: 'search_web' } }] },
    { role: 'tool', tool_call_id: 'a', name: 'search_web', content: 'results' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'b', function: { name: 'read_url' } }] },
    { role: 'tool', tool_call_id: 'b', name: 'read_url', content: 'docs' },
    { role: 'assistant', content: 'now I will build it' },
  ];

  test('a cut that would orphan a tool result moves past it', () => {
    // Index 3 is a tool result whose assistant turn is at 2. Keeping from 3
    // would send a tool message with no call in front of it.
    assert.equal(safeCutPoint(transcript, 3), 4);
    assert.equal(safeCutPoint(transcript, 5), 6);
  });

  test('a cut already on a safe boundary is left alone', () => {
    assert.equal(safeCutPoint(transcript, 2), 2);
    assert.equal(safeCutPoint(transcript, 4), 4);
    assert.equal(safeCutPoint(transcript, 6), 6);
  });

  test('the system prompt is never cut away', () => {
    // It carries the rules the whole loop depends on; a summary cannot replace it.
    assert.ok(safeCutPoint(transcript, 0) >= 1);
    assert.ok(safeCutPoint(transcript, -5) >= 1);
  });

  test('token estimates count tool call arguments, not just content', () => {
    // Arguments live outside `content`, and a graph edit's arguments are
    // routinely the largest thing in the transcript. Missing them would let it
    // grow well past the compaction threshold unnoticed.
    const bare = [{ role: 'assistant', content: '' }];
    const withCall = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'x', function: { name: 'edit_graph', arguments: 'y'.repeat(4000) } }],
      },
    ];
    assert.equal(estimateTokens(bare), 0);
    assert.ok(estimateTokens(withCall) > 900);
  });
});

// ─────────────────────────────────────────────────────────────
describe('egress safety', () => {
  test('allows ordinary public URLs', () => {
    assert.equal(assertUrlAllowed('https://api.github.com/repos').hostname, 'api.github.com');
  });

  test('blocks the cloud metadata endpoint', () => {
    assert.throws(() => assertUrlAllowed('http://169.254.169.254/latest/meta-data/'), /not allowed|private network/);
  });

  test('blocks non-http schemes', () => {
    assert.throws(() => assertUrlAllowed('file:///etc/passwd'), /Only http and https/);
    assert.throws(() => assertUrlAllowed('gopher://x'), /Only http and https/);
  });

  test('rejects malformed input rather than passing it through', () => {
    assert.throws(() => assertUrlAllowed('not a url'), /not a valid URL/);
  });

  test('capOutput truncates rather than letting a run document blow the size limit', () => {
    const huge = { blob: 'x'.repeat(50_000) };
    const capped = capOutput(huge, 1000);
    assert.equal(capped.truncated, true);
    assert.ok(JSON.stringify(capped).length < 2000);
  });

  test('capOutput leaves small values untouched', () => {
    assert.deepEqual(capOutput({ ok: true }, 1000), { ok: true });
  });
});

// ─────────────────────────────────────────────────────────────
describe('schedule arithmetic', () => {
  test('advances by the configured interval', () => {
    const from = new Date('2026-03-01T10:30:00Z');
    assert.equal(computeNextRun({ every: 'hour' }, from).toISOString(), '2026-03-01T11:00:00.000Z');
    assert.equal(computeNextRun({ every: '15 minutes' }, from).toISOString(), '2026-03-01T10:45:00.000Z');
  });

  test('daily runs land on the requested UTC hour', () => {
    const next = computeNextRun({ every: 'day', atHour: 6 }, new Date('2026-03-01T10:30:00Z'));
    assert.equal(next.toISOString(), '2026-03-02T06:00:00.000Z');
  });

  test('always moves forward', () => {
    const from = new Date('2026-03-01T10:30:00Z');
    for (const every of ['15 minutes', 'hour', '6 hours', 'day', 'week']) {
      assert.ok(computeNextRun({ every, atHour: 9 }, from) > from, `${every} did not advance`);
    }
  });
});

// ─────────────────────────────────────────────────────────────
/**
 * The failure these cover is the quiet one: a reference that points nowhere
 * renders as an empty string, so the workflow runs, every step reports success,
 * the user is charged, and the email arrives blank. Nothing throws, which is
 * exactly why it has to be caught by derivation rather than by running it.
 */
describe('reference analysis', () => {
  const wired = extra => ({
    nodes: [
      node('t', 'trigger.manual'),
      node('fetch', 'core.http', { url: 'https://api.example.com/items', method: 'GET' }),
      ...extra.nodes,
    ],
    edges: [edge('t', 'fetch'), ...extra.edges],
  });

  test('a reference to a declared output is fine', () => {
    const graph = wired({
      nodes: [node('out', 'core.template', { value: 'got {{ fetch.data.items[0].title }} ({{ fetch.status }})' })],
      edges: [edge('fetch', 'out')],
    });
    assert.deepEqual(analyzeReferences(graph).errors, []);
  });

  test('a reference to a step that does not exist is an error', () => {
    const graph = wired({
      nodes: [node('out', 'core.template', { value: '{{ summarise.text }}' })],
      edges: [edge('fetch', 'out')],
    });
    const { errors } = analyzeReferences(graph);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /no step called “summarise”/);
  });

  test('a reference to an output the node never returns is an error', () => {
    const graph = wired({
      nodes: [node('out', 'core.template', { value: '{{ fetch.body }}' })],
      edges: [edge('fetch', 'out')],
    });
    const { errors } = analyzeReferences(graph);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /no “body” output/);
    // The message has to name the alternatives, or the model has nothing to
    // correct it to and guesses again.
    assert.match(errors[0], /status, ok, data, headers/);
  });

  test('reading a step that runs later is an error, not a warning', () => {
    const graph = {
      nodes: [node('t', 'trigger.manual'), node('a', 'core.template', { value: '{{ b.result }}' }), node('b', 'core.code', { script: 'return 1' })],
      edges: [edge('t', 'a'), edge('a', 'b')],
    };
    const { errors } = analyzeReferences(graph);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /runs after it/);
  });

  test('reading an unconnected step that happens to run first is a warning', () => {
    const graph = {
      nodes: [
        node('t', 'trigger.manual'),
        node('a', 'core.code', { script: 'return 1' }),
        node('b', 'core.template', { value: '{{ a.result }}' }),
      ],
      // `a` and `b` are separate branches off the trigger: `a` runs first today,
      // and nothing guarantees it tomorrow.
      edges: [edge('t', 'a'), edge('t', 'b')],
    };
    const { errors, warnings } = analyzeReferences(graph);
    assert.deepEqual(errors, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /not connected/);
  });

  test('references hidden inside a JSON field are found', () => {
    // The case a scan of top-level strings misses, and the one that matters —
    // a request body is where the interesting references live.
    const graph = wired({
      nodes: [node('post', 'core.http', { url: 'https://x.test', method: 'POST', headers: { 'X-Id': '{{ fetch.nope }}' } })],
      edges: [edge('fetch', 'post')],
    });
    const { errors } = analyzeReferences(graph);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /no “nope” output/);
  });

  test('trigger payload paths are never errors — their shape is the caller’s', () => {
    const graph = wired({
      nodes: [node('out', 'core.template', { value: '{{ trigger.body.whatever.deep }}' })],
      edges: [edge('fetch', 'out')],
    });
    assert.deepEqual(analyzeReferences(graph).errors, []);
  });

  test('one bad reference used four times is reported once', () => {
    const graph = wired({
      nodes: [node('out', 'core.template', { value: '{{ x.a }} {{ x.a }} {{ x.a }} {{ x.a }}' })],
      edges: [edge('fetch', 'out')],
    });
    assert.equal(analyzeReferences(graph).errors.length, 1);
  });

  test('validateGraph refuses a dead reference, which is what blocks the architect', () => {
    const graph = wired({
      nodes: [node('out', 'core.template', { value: '{{ fetch.body }}' })],
      edges: [edge('fetch', 'out')],
    });
    assert.ok(validateGraph(graph).errors.some(e => /no “body” output/.test(e)));
  });

  test('every declared output is one an executor really returns', () => {
    // The registry is what reference validation rules against, so an output it
    // under-declares turns a correct reference into a blocking error.
    for (const def of NODE_LIST) {
      assert.ok(def.outputs.length > 0, `${def.type} declares no outputs`);
      for (const output of def.outputs) {
        assert.equal(typeof output.path, 'string');
        assert.ok(output.path.length, `${def.type} has an empty output path`);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────
describe('placeholder misses', () => {
  test('a miss still renders empty — a typo must not kill a run', () => {
    assert.equal(interpolate('x{{ nope.here }}y', {}), 'xy');
  });

  test('but the miss is reported, so a blank result has a stated cause', () => {
    const misses = [];
    interpolate('{{ a.b }} and {{ c.d }}', { a: { b: 'ok' } }, m => misses.push(m.path));
    assert.deepEqual(misses, ['c.d']);
  });

  test('a supplied default is a decision, not a miss', () => {
    const misses = [];
    const out = interpolate('{{ nope.here | default: n/a }}', {}, m => misses.push(m.path));
    assert.equal(out, 'n/a');
    assert.deepEqual(misses, []);
  });

  test('resolveValues reports the field, since that is what the user has to fix', () => {
    const misses = [];
    resolveValues(
      { body: 'Hello {{ absent.name }}' },
      [{ key: 'body', label: 'Body', type: 'text' }],
      {},
      { onMiss: m => misses.push(m) }
    );
    assert.equal(misses.length, 1);
    assert.equal(misses[0].field, 'Body');
    assert.equal(misses[0].path, 'absent.name');
  });

  test('misses are found inside nested field values too', () => {
    const misses = [];
    resolveValues(
      { headers: { Authorization: 'Bearer {{ absent.token }}' } },
      [{ key: 'headers', label: 'Headers', type: 'json' }],
      {},
      { onMiss: m => misses.push(m.path) }
    );
    assert.deepEqual(misses, ['absent.token']);
  });
});

// ─────────────────────────────────────────────────────────────
/**
 * Retrying is easy; retrying only what is safe to repeat is the whole problem.
 * A duplicate email cannot be taken back, so these assert the *refusals* as
 * carefully as the retries.
 */
describe('transient failure handling', () => {
  const err = props => Object.assign(new Error('boom'), props);

  test('rate limits and server errors are retryable, client errors are not', () => {
    assert.equal(classifyFailure(err({ status: 429 })).retryable, true);
    assert.equal(classifyFailure(err({ status: 503 })).retryable, true);
    assert.equal(classifyFailure(err({ status: 404 })).retryable, false);
    assert.equal(classifyFailure(err({ status: 401 })).retryable, false);
  });

  test('a rate limit means nothing happened, so even a POST may be repeated', () => {
    assert.equal(classifyFailure(err({ status: 429 })).sent, false);
    // A 500 may have acted before it failed, so it may not.
    assert.equal(classifyFailure(err({ status: 500 })).sent, true);
  });

  test('a DNS failure proves the request never left, a reset does not', () => {
    assert.equal(classifyFailure(err({ cause: { code: 'ENOTFOUND' } })).sent, false);
    assert.equal(classifyFailure(err({ code: 'ECONNRESET' })).sent, true);
  });

  test('a cancelled run is never retried', () => {
    assert.equal(classifyFailure(err({ name: 'AbortError' })).retryable, false);
  });

  test('Retry-After is honoured in both of its legal forms', () => {
    assert.equal(parseRetryAfter('2'), 2000);
    const at = new Date(Date.now() + 5000).toUTCString();
    assert.ok(Math.abs(parseRetryAfter(at) - 5000) < 1500);
    assert.equal(parseRetryAfter('nonsense'), null);
  });

  test('a step with side effects is not repeated once the request may have landed', async () => {
    let attempts = 0;
    await assert.rejects(
      withRetry(async () => { attempts += 1; throw err({ code: 'ECONNRESET' }); }, { attempts: 3, idempotent: false })
    );
    assert.equal(attempts, 1, 'a dropped connection may have delivered the email');
  });

  test('the same failure on a read-only step is retried', async () => {
    let attempts = 0;
    await assert.rejects(
      withRetry(async () => { attempts += 1; throw err({ code: 'ECONNRESET' }); }, { attempts: 3, idempotent: true })
    );
    assert.equal(attempts, 3);
  });

  test('a side-effecting step is repeated when the request provably never left', async () => {
    let attempts = 0;
    await assert.rejects(
      withRetry(async () => { attempts += 1; throw err({ code: 'ENOTFOUND' }); }, { attempts: 3, idempotent: false })
    );
    assert.equal(attempts, 3);
  });

  test('a recovered attempt returns its value rather than the earlier failure', async () => {
    let attempts = 0;
    const out = await withRetry(
      async () => { attempts += 1; if (attempts < 3) throw err({ status: 503 }); return 'ok'; },
      { attempts: 3, idempotent: true }
    );
    assert.equal(out, 'ok');
  });

  test('backoff is jittered, so scheduled runs do not retry in lockstep', () => {
    const delays = new Set(Array.from({ length: 20 }, () => backoffMs(3)));
    assert.ok(delays.size > 1, 'every retry would collide on the same second');
  });
});

// ─────────────────────────────────────────────────────────────
describe('deadlines', () => {
  test('work that ignores its signal is still stopped', async () => {
    // The case a bare AbortController does not cover, and the one that hangs a
    // build: a tool that never settles and never listens.
    await assert.rejects(
      withTimeout(() => new Promise(() => {}), { ms: 60 }),
      e => e.code === 'STEP_TIMEOUT'
    );
  });

  test('a cancel stays a cancel and is not reported as a timeout', async () => {
    const outer = new AbortController();
    setTimeout(() => outer.abort(), 20);
    await assert.rejects(
      withTimeout(
        signal => new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('Run canceled')))
        ),
        { ms: 5000, signal: outer.signal }
      ),
      /Run canceled/
    );
  });

  test('a value that arrives in time passes straight through', async () => {
    assert.equal(await withTimeout(async () => 42, { ms: 1000 }), 42);
  });
});

// ─────────────────────────────────────────────────────────────
describe('per-node ceilings', () => {
  test('the default applies to nodes that do not declare one', () => {
    assert.equal(nodeTimeoutMs('core.http', 120_000), 120_000);
    assert.equal(nodeTimeoutMs('core.code', 120_000), 120_000);
  });

  test('a Wait outlives the default, since its whole job is to take time', () => {
    // A five-minute pause under a two-minute ceiling is a node that can never
    // do what its own field allows.
    const seconds = NODE_REGISTRY['core.delay'].fields.find(f => f.key === 'seconds');
    assert.ok(nodeTimeoutMs('core.delay', 120_000) > seconds.max * 1000);
  });

  test('an AI Step outlives the provider timeout it wraps', () => {
    assert.ok(nodeTimeoutMs('core.llm', 120_000) > 180_000, 'would fail before the model call does');
  });

  test('the agent node is bounded by steps and the run, not by a wall clock', () => {
    assert.equal(nodeTimeoutMs('core.agent', 120_000), 0);
  });

  test('a node that can be test-run is one with no side effects', () => {
    for (const def of NODE_LIST) {
      if (isTestable(def.type)) {
        assert.ok(!hasSideEffects(def.type), `${def.type} would be executed during a build`);
      }
    }
    // The architect used to keep this list itself; the registry owns it now, so
    // a new delivering node is excluded the moment it is declared.
    for (const type of ['core.email', 'core.slack', 'core.discord', 'core.telegram', 'core.notion']) {
      assert.equal(isTestable(type), false, `${type} must never run during a build`);
    }
  });
});

// ─────────────────────────────────────────────────────────────
/**
 * Loop structure.
 *
 * These messages are a product surface, not diagnostics: they are what the
 * architect reads when `finish` refuses its graph, and a model given "invalid
 * region" fixes it by guessing. Each one therefore names the node and says what
 * to do.
 */
describe('loop regions', () => {
  const loop = (extraNodes = [], extraEdges = []) => ({
    nodes: [
      node('t', 'trigger.manual'),
      node('loop', 'core.forEach', { items: '{{ trigger.list }}' }),
      node('work', 'core.template', { value: '{{ each.item }}' }),
      node('gather', 'core.collect', {}),
      ...extraNodes,
    ],
    edges: [edge('t', 'loop'), edge('loop', 'work'), edge('work', 'gather'), ...extraEdges],
  });

  test('a well-formed loop has one region with the right body', () => {
    const { regions, errors } = findRegions(loop());
    assert.deepEqual(errors, []);
    assert.equal(regions.length, 1);
    assert.deepEqual(regions[0].body, ['work']);
    assert.equal(regions[0].collectId, 'gather');
  });

  test('a loop with no Collect is refused, and says how to close it', () => {
    const graph = loop();
    graph.nodes = graph.nodes.filter(n => n.id !== 'gather');
    graph.edges = graph.edges.filter(e => e.target !== 'gather');

    const { errors } = findRegions(graph);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /never ends/);
    assert.match(errors[0], /Add a Collect step/);
  });

  test('a Collect with no loop is refused too', () => {
    const graph = {
      nodes: [node('t', 'trigger.manual'), node('gather', 'core.collect', {})],
      edges: [edge('t', 'gather')],
    };
    assert.match(findRegions(graph).errors[0], /nothing upstream starts a loop/);
  });

  test('an empty loop body is refused — it would repeat nothing', () => {
    const graph = {
      nodes: [node('t', 'trigger.manual'), node('loop', 'core.forEach', {}), node('gather', 'core.collect', {})],
      edges: [edge('t', 'loop'), edge('loop', 'gather')],
    };
    assert.match(findRegions(graph).errors[0], /loops over nothing/);
  });

  /**
   * Nesting multiplies what a run costs in a way the user cannot see coming,
   * and the honest version of the feature needs a cost preview that does not
   * exist. Refusing it plainly beats shipping a way to spend a month's credits
   * on one click.
   */
  test('a loop inside a loop is refused with the reason', () => {
    const graph = loop(
      [node('inner', 'core.forEach', {}), node('innerWork', 'core.template', {}), node('innerGather', 'core.collect', {})],
      [edge('work', 'inner'), edge('inner', 'innerWork'), edge('innerWork', 'innerGather'), edge('innerGather', 'gather')]
    );
    const { errors } = findRegions(graph);
    // And it must be the *only* error. Nesting trips several later rules on its
    // way past — the outer opener sees two Collects — and an author told "this
    // loop has 2 Collect steps" deletes one, which is not the fix.
    assert.equal(errors.length, 1, errors.join(' | '));
    assert.match(errors[0], /starts a loop inside the one/);
    assert.match(errors[0], /multiply what a run costs/);
  });

  test('an edge into the middle of a loop body is refused', () => {
    // It would run once per pass on the strength of a value produced once.
    const graph = loop([node('outside', 'core.template', {})], [edge('t', 'outside'), edge('outside', 'work')]);
    assert.ok(findRegions(graph).errors.some(e => /into the middle of the loop/.test(e)));
  });

  test('an edge out of a loop body is refused, and points at Collect', () => {
    const graph = loop([node('after', 'core.template', {})], [edge('work', 'after')]);
    const { errors } = findRegions(graph);
    assert.ok(errors.some(e => /connects out to/.test(e)));
    assert.ok(errors.some(e => /gathers them/.test(e)));
  });

  test('a graph with no loops produces no regions and no complaints', () => {
    const { regions, errors } = findRegions({
      nodes: [node('t', 'trigger.manual'), node('a', 'core.template', {})],
      edges: [edge('t', 'a')],
    });
    assert.deepEqual(regions, []);
    assert.deepEqual(errors, []);
  });

  test('a list is recovered from the JSON text an interpolated field produces', () => {
    assert.deepEqual(coerceItems('[{"a":1}]'), [{ a: 1 }]);
    assert.deepEqual(coerceItems([1, 2]), [1, 2]);
    assert.deepEqual(coerceItems(''), []);
    assert.deepEqual(coerceItems(null), []);
  });

  test('anything that is not a list says what to point at instead', () => {
    assert.throws(() => coerceItems('a sentence'), /must be a list/);
    assert.throws(() => coerceItems({ not: 'a list' }), /Point this at a step output/);
  });
});
