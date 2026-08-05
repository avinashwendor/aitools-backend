/**
 * Static analysis of `{{ node.path }}` references.
 *
 * This exists because of the one failure the rest of the system cannot see.
 * `interpolate` resolves a path that leads nowhere to an empty string — the
 * right call at run time, since a typo in a template should not kill a run nine
 * steps in. But it means a reference to a step that does not exist, or to a
 * field the step never returns, produces no error anywhere: the HTTP node posts
 * `{"title": ""}`, the email node sends a blank body, every step reports
 * success, the run is charged, and the user gets nothing with no indication of
 * why. A graph that is structurally perfect can be entirely inert.
 *
 * It is also the most likely thing to be wrong, because references are the part
 * of a graph a model writes from assumption. It reads that an endpoint returns
 * a list and writes `{{ fetch.data.items }}`; the API calls it `results`. The
 * node registry knows the answer for the first segment — `data` is declared,
 * `body` is not — and the graph knows whether `fetch` runs before this node at
 * all. Both checks are pure derivation over data we already have.
 *
 * Two severities, and the line between them is whether the reference can *ever*
 * resolve:
 *
 *   error    the target does not exist, or runs after the node that reads it.
 *            Guaranteed empty. The architect's `finish` gate refuses these, so
 *            the model fixes them instead of the user discovering them.
 *   warning  the target exists and runs first but is not upstream — it resolves
 *            today by accident of ordering, and stops resolving the moment
 *            someone reorders the canvas or a branch goes the other way.
 */

import { getNodeDef } from './registry.js';
import { topoSort, ancestors } from './graph.js';

const PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g;

/**
 * Roots that are not node ids.
 *
 * `trigger` is the run's seed payload, which is whatever the caller posted —
 * its shape is not knowable from the graph, so paths beneath it are never
 * errors. `each` is the current item inside a loop, and the same applies: what
 * is on an item belongs to whoever produced the list.
 */
const RUNTIME_ROOTS = new Set(['trigger', 'each']);

/**
 * Split a placeholder body into its root and first path segment.
 *
 * `http_1.data.items[0].id | json` → `{ root: 'http_1', first: 'data' }`.
 * Only the first segment is checkable: the registry declares that `core.http`
 * returns `data`, but what is *inside* `data` belongs to somebody else's API.
 */
export function parseReference(expression) {
  const path = String(expression).split('|')[0].trim();
  if (!path) return null;

  const segments = path
    .replace(/\[(\w+)\]/g, '.$1')
    .split('.')
    .map(segment => segment.trim())
    .filter(Boolean);

  if (!segments.length) return null;
  return { path, root: segments[0], first: segments[1] ?? null, segments };
}

/**
 * Every reference in a value, however deeply it is nested.
 *
 * Walks objects and arrays rather than only top-level strings, because a JSON
 * field is stored as an object and a request body is exactly where the
 * interesting references live — `{ "text": "{{ summarise.text }}" }` is
 * invisible to a scan of top-level strings.
 */
function collectFromValue(value, found) {
  if (typeof value === 'string') {
    for (const match of value.matchAll(PLACEHOLDER)) {
      const parsed = parseReference(match[1]);
      if (parsed) found.push(parsed);
    }
    return found;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectFromValue(entry, found);
    return found;
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) collectFromValue(entry, found);
  }
  return found;
}

/** Every reference on one node, tagged with the field it came from. */
export function referencesOf(node) {
  const values = node?.data?.values || {};
  const found = [];
  for (const [key, value] of Object.entries(values)) {
    const before = found.length;
    collectFromValue(value, found);
    for (let i = before; i < found.length; i++) found[i].field = key;
  }
  return found;
}

/**
 * Check every reference in a graph.
 *
 * @param {{nodes: Array, edges: Array}} graph
 * @returns {{errors: string[], warnings: string[]}}
 */
export function analyzeReferences({ nodes = [], edges = [] } = {}, { regions = [] } = {}) {
  const errors = [];
  const warnings = [];
  if (!nodes.length) return { errors, warnings };

  const byId = new Map(nodes.map(node => [node.id, node]));

  /**
   * `nodeId → the loop body it belongs to`.
   *
   * Two rules hang off this, and both describe a value that does not exist at
   * the moment it is read. A body node's output is per-iteration and gone when
   * the pass ends, so reading it from outside the loop gets whichever pass
   * happened to finish last — the sort of bug that is correct in a test with
   * one item. And `{{ each.item }}` outside a loop has no current item at all.
   */
  const bodyOf = new Map();
  /**
   * The two nodes that are not in a body but do read per-iteration values.
   *
   * `collect` is evaluated once per pass — picking what to keep out of the
   * iteration is its entire job — so it is inside the scope even though it is
   * not inside the loop. Treating it as outside would make the one correct use
   * of a body reference the only one that gets rejected.
   */
  const evaluatedPerIteration = new Map();
  for (const region of regions) {
    for (const id of region.body) bodyOf.set(id, region);
    evaluatedPerIteration.set(region.collectId, region);
  }
  const iterationScopeOf = id => bodyOf.get(id) || evaluatedPerIteration.get(id) || null;

  /**
   * Execution position per node.
   *
   * A cyclic graph has no order, but it already reported a cycle as an error of
   * its own — running the reference checks on it as well would bury that under
   * a list of consequences. So order-dependent checks are simply skipped.
   */
  let position = null;
  try {
    position = new Map(topoSort(nodes, edges).map((node, index) => [node.id, index]));
  } catch {
    position = null;
  }

  for (const node of nodes) {
    const def = getNodeDef(node.type);
    const label = node.data?.title || def?.label || node.id;
    const upstream = new Set(ancestors(edges, node.id));

    // One complaint per distinct reference. A body that interpolates the same
    // missing field in four places is one mistake, and four identical errors
    // push the real second problem off the end of the list the model reads.
    const seen = new Set();

    for (const reference of referencesOf(node)) {
      const signature = `${reference.root}.${reference.first ?? ''}`;
      if (seen.has(signature)) continue;
      seen.add(signature);

      if (reference.root === 'each') {
        if (!iterationScopeOf(node.id)) {
          errors.push(
            `“${label}” reads {{ ${reference.path} }}, but it is not inside a loop, so there is ` +
              `no current item. Move it between a For Each step and its Collect step.`
          );
        }
        continue;
      }

      if (RUNTIME_ROOTS.has(reference.root)) continue;

      const target = byId.get(reference.root);
      if (!target) {
        errors.push(
          `“${label}” reads {{ ${reference.path} }}, but there is no step called “${reference.root}”. ` +
            `Steps in this workflow: ${nodes.map(n => n.id).join(', ')}.`
        );
        continue;
      }

      if (target.id === node.id) {
        errors.push(`“${label}” reads its own output in {{ ${reference.path} }}, which is empty while it runs.`);
        continue;
      }

      /*
       * Crossing a loop boundary.
       *
       * Reading a body node from outside is the dangerous direction: the value
       * is per-iteration, so what arrives is whichever pass finished last —
       * correct-looking with one item and wrong with two. `collect` is how
       * results are supposed to leave, so the error says so.
       */
      const targetRegion = bodyOf.get(target.id);
      const ownRegion = iterationScopeOf(node.id);
      if (targetRegion && targetRegion !== ownRegion) {
        errors.push(
          `“${label}” reads {{ ${reference.path} }} from “${target.id}”, which is inside a loop — ` +
            `that value only exists during one pass. Read “${targetRegion.collectId}” instead, ` +
            `which gathers every pass.`
        );
        continue;
      }

      if (!upstream.has(target.id)) {
        const runsLater = position ? (position.get(target.id) ?? 0) > (position.get(node.id) ?? 0) : true;
        if (runsLater) {
          errors.push(
            `“${label}” reads {{ ${reference.path} }} from “${target.id}”, which runs after it — ` +
              `that value is always empty. Connect “${target.id}” upstream or read something else.`
          );
        } else {
          warnings.push(
            `“${label}” reads {{ ${reference.path} }} from “${target.id}”, which is not connected to it. ` +
              `It happens to run first today, so this works until the graph is reordered.`
          );
        }
        continue;
      }

      // The first segment is the one the registry can rule on. No segment at
      // all — `{{ fetch }}` — is the whole output object, which is legal.
      const targetDef = getNodeDef(target.type);
      if (!targetDef || !reference.first) continue;

      const declared = targetDef.outputs.map(output => output.path.split('.')[0]);
      if (!declared.includes(reference.first)) {
        errors.push(
          `“${label}” reads {{ ${reference.path} }}, but ${targetDef.label} “${target.id}” has no “${reference.first}” output. ` +
            `It returns: ${declared.join(', ')}.`
        );
      }
    }
  }

  return { errors, warnings };
}

export default { analyzeReferences, referencesOf, parseReference };
