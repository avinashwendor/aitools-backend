/**
 * Graph utilities — ordering and validation, with no I/O.
 *
 * Kept pure on purpose: the same `validateGraph` runs in the editor before the
 * user presses Run (so they get a toast instead of a failed run) and on the
 * server at save time (so an edited payload can't smuggle in a cycle). A
 * validator that needs a database can only ever run in one of those places.
 *
 * The ordering is a Kahn topological sort written out rather than pulled from
 * `toposort`, for two reasons. It reports the *members* of a cycle instead of
 * just "Cyclic dependency", which is the difference between a usable error and
 * a shrug. And it is stable: ties break on the node's position in the saved
 * array, so two runs of the same graph list their steps in the same order and
 * the run console doesn't reshuffle between runs.
 */

import { getNodeDef, isKnownType } from './registry.js';

/**
 * Order nodes so every node follows the ones feeding it.
 *
 * @param {Array} nodes  [{ id, type, data }]
 * @param {Array} edges  [{ source, target, sourceHandle }]
 * @returns {Array} the same node objects, in execution order
 * @throws {Error} with `.cycle` listing the offending node ids
 */
export function topoSort(nodes, edges) {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const indegree = new Map(nodes.map(n => [n.id, 0]));
  const adjacency = new Map(nodes.map(n => [n.id, []]));

  for (const edge of edges) {
    // Edges pointing at deleted nodes are dropped rather than fatal: the editor
    // can race a node delete against an edge write, and refusing to run a graph
    // over a dangling reference punishes the user for our race.
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
    adjacency.get(edge.source).push(edge.target);
    indegree.set(edge.target, indegree.get(edge.target) + 1);
  }

  // Seed with every root, in authored order, so ordering is deterministic.
  const queue = nodes.filter(n => indegree.get(n.id) === 0).map(n => n.id);
  const sorted = [];

  while (queue.length) {
    const id = queue.shift();
    sorted.push(byId.get(id));
    for (const next of adjacency.get(id)) {
      const remaining = indegree.get(next) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }

  if (sorted.length !== nodes.length) {
    const cycle = nodes.filter(n => indegree.get(n.id) > 0).map(n => n.id);
    const err = new Error(
      `Workflow has a loop through ${cycle.length} node${cycle.length === 1 ? '' : 's'}.`
    );
    err.code = 'GRAPH_CYCLE';
    err.cycle = cycle;
    throw err;
  }

  return sorted;
}

/** Nodes that can never run because nothing connects them to the trigger. */
export function findOrphans(nodes, edges) {
  if (!nodes.length) return [];
  const trigger = nodes.find(n => getNodeDef(n.type)?.kind === 'trigger');
  if (!trigger) return [];

  const downstream = new Map();
  for (const edge of edges) {
    if (!downstream.has(edge.source)) downstream.set(edge.source, []);
    downstream.get(edge.source).push(edge.target);
  }

  const reachable = new Set([trigger.id]);
  const stack = [trigger.id];
  while (stack.length) {
    for (const next of downstream.get(stack.pop()) || []) {
      if (!reachable.has(next)) {
        reachable.add(next);
        stack.push(next);
      }
    }
  }

  return nodes.filter(n => !reachable.has(n.id)).map(n => n.id);
}

/**
 * Everything knowable about a graph before it runs.
 *
 * Returns `{ errors, warnings }`. Errors block the run; warnings are shown but
 * don't. The split matters: an unreachable node someone parked on the canvas
 * while thinking is not a reason to refuse to run the six that are wired up,
 * but a missing required field is — that node will throw the moment it starts,
 * and failing at save time is far cheaper than failing nine steps into a run
 * that has already opened a browser and spent credits.
 */
export function validateGraph({ nodes = [], edges = [] } = {}, { surface = 'flow' } = {}) {
  const errors = [];
  const warnings = [];

  if (!nodes.length) {
    return { errors: ['Add a trigger to get started.'], warnings: [] };
  }

  const triggers = nodes.filter(n => getNodeDef(n.type)?.kind === 'trigger');
  if (triggers.length === 0) errors.push('This workflow needs a trigger.');
  if (triggers.length > 1) {
    errors.push(`Only one trigger is allowed — found ${triggers.length}.`);
  }

  const ids = new Set();
  for (const node of nodes) {
    if (ids.has(node.id)) errors.push(`Duplicate node id "${node.id}".`);
    ids.add(node.id);

    const def = getNodeDef(node.type);
    if (!def) {
      errors.push(`Unknown node type "${node.type}".`);
      continue;
    }

    if (!def.surfaces.includes(surface)) {
      errors.push(`“${def.label}” isn’t available in a ${surface} workflow.`);
    }

    const label = node.data?.title || def.label;
    for (const field of def.fields) {
      if (!field.required) continue;
      const value = node.data?.values?.[field.key];
      if (value === undefined || value === null || String(value).trim() === '') {
        errors.push(`“${label}” is missing ${field.label}.`);
      }
    }
  }

  for (const edge of edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) continue;
    if (edge.source === edge.target) {
      errors.push('A node cannot connect to itself.');
    }
    const sourceDef = getNodeDef(nodes.find(n => n.id === edge.source)?.type);
    if (sourceDef && edge.sourceHandle && !sourceDef.handles.out.includes(edge.sourceHandle)) {
      errors.push(`“${sourceDef.label}” has no “${edge.sourceHandle}” output.`);
    }
  }

  try {
    topoSort(nodes, edges);
  } catch (err) {
    if (err.code === 'GRAPH_CYCLE') errors.push(err.message);
    else throw err;
  }

  if (nodes.length > 1 && edges.length === 0) {
    errors.push('Connect your nodes — nothing downstream of the trigger will run.');
  }

  const orphans = findOrphans(nodes, edges);
  if (orphans.length) {
    warnings.push(
      `${orphans.length} node${orphans.length === 1 ? '' : 's'} won’t run — nothing connects ${
        orphans.length === 1 ? 'it' : 'them'
      } to the trigger.`
    );
  }

  return { errors, warnings };
}

/**
 * Suggest a node id that reads well in a template.
 *
 * References are written `{{ open_1.url }}`, so ids are part of the authoring
 * surface, not an implementation detail. A cuid would be invisible in the
 * database and unbearable in a prompt.
 */
export function suggestNodeId(type, existingIds = []) {
  const base = String(type).split('.').pop().replace(/[^a-z0-9]/gi, '') || 'node';
  const taken = new Set(existingIds);
  for (let i = 1; i < 500; i++) {
    const candidate = `${base}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}_${Date.now()}`;
}

/** Node ids reachable from `sourceId` through the given handle, one hop. */
export function successors(edges, sourceId, handle = null) {
  return edges
    .filter(e => e.source === sourceId && (handle === null || (e.sourceHandle || 'main') === handle))
    .map(e => e.target);
}

/** Direct predecessors of a node — what the inspector offers as `{{ … }}` sources. */
export function predecessors(edges, targetId) {
  return edges.filter(e => e.target === targetId).map(e => e.source);
}

/**
 * Everything upstream of a node, transitively.
 *
 * The inspector's reference picker uses this rather than direct predecessors:
 * a value produced three nodes back is still in scope at run time (the context
 * is cumulative), and offering only the immediate parent would hide most of
 * what the user can actually reference.
 */
export function ancestors(edges, targetId) {
  const incoming = new Map();
  for (const edge of edges) {
    if (!incoming.has(edge.target)) incoming.set(edge.target, []);
    incoming.get(edge.target).push(edge.source);
  }

  const seen = new Set();
  const stack = [...(incoming.get(targetId) || [])];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(incoming.get(id) || []));
  }
  return [...seen];
}

export default {
  topoSort,
  validateGraph,
  findOrphans,
  suggestNodeId,
  successors,
  predecessors,
  ancestors,
};
