/**
 * Agentic engine tests — graph ordering, templating, registry integrity and
 * the composer's operation applier.
 *
 * No database, no LLM, no browser. Everything here is pure derivation, which
 * is deliberate: these are the parts where a bug is silent. A wrong topological
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
  getNodeDef,
  nodeCredits,
  needsBrowser,
  typesForSurface,
} from '../src/agentic/registry.js';
import { topoSort, validateGraph, findOrphans, suggestNodeId, ancestors } from '../src/agentic/graph.js';
import { interpolate, interpolateDeep, resolveValues, getByPath } from '../src/agentic/interpolate.js';
import { applyOperations } from '../src/agentic/composer.js';
import { executorTypes } from '../src/agentic/executors.js';
import { assertUrlAllowed, capOutput } from '../src/agentic/safety.js';
import { computeNextRun } from '../src/agentic/queue.js';

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
      assert.ok(def.surfaces.length, `${def.type} belongs to no surface`);
      assert.ok(def.handles.out.length, `${def.type} has no outputs`);
      assert.equal(def.kind === 'trigger', def.handles.in === false,
        `${def.type}: triggers must have no input, actions must have one`);
      for (const field of def.fields) {
        assert.ok(field.key && field.label, `${def.type} has a field missing key or label`);
      }
    }
  });

  test('browser nodes appear only on the browser surface', () => {
    const flowTypes = typesForSurface('flow');
    for (const def of NODE_LIST.filter(n => n.requiresBrowser)) {
      assert.ok(!flowTypes.includes(def.type), `${def.type} leaked into the flow palette`);
    }
  });

  test('agent credits scale with steps actually taken', () => {
    const short = nodeCredits('browser.agent', { steps: 2 });
    const long = nodeCredits('browser.agent', { steps: 12 });
    assert.ok(long > short, 'a 12-step agent must cost more than a 2-step one');
    assert.ok(nodeCredits('browser.agent', { steps: 0 }) > 0, 'a zero-step agent still costs');
    assert.equal(nodeCredits('core.template'), 0, 'deterministic nodes are free');
  });

  test('needsBrowser only fires on browser nodes', () => {
    assert.equal(needsBrowser([node('a', 'core.http')]), false);
    assert.equal(needsBrowser([node('a', 'core.http'), node('b', 'browser.act')]), true);
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
    assert.equal(suggestNodeId('browser.open', []), 'open_1');
    assert.equal(suggestNodeId('browser.open', ['open_1', 'open_2']), 'open_3');
  });
});

// ─────────────────────────────────────────────────────────────
describe('graph validation', () => {
  const valid = {
    nodes: [node('t', 'trigger.manual'), node('h', 'core.http', { url: 'https://x.dev' })],
    edges: [edge('t', 'h')],
  };

  test('accepts a well-formed graph', () => {
    assert.deepEqual(validateGraph(valid, { surface: 'flow' }).errors, []);
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

  test('rejects a browser node on the flow surface', () => {
    const wrong = {
      nodes: [node('t', 'trigger.manual'), node('b', 'browser.act', { instruction: 'click' })],
      edges: [edge('t', 'b')],
    };
    assert.match(validateGraph(wrong, { surface: 'flow' }).errors.join(' '), /isn’t available in a flow workflow/);
    assert.deepEqual(validateGraph(wrong, { surface: 'browser' }).errors, []);
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
describe('composer operations', () => {
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
