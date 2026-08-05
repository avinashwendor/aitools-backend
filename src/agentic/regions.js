/**
 * Loop regions — the part of a graph that runs more than once.
 *
 * Until now every node in a workflow executed exactly once, which quietly ruled
 * out most of what people actually want to automate. "Summarise each of the
 * twenty articles" is not expressible as a DAG walked top to bottom: a Code
 * node can map over a list, but it cannot make twenty HTTP calls or twenty
 * model calls, and those are the steps the work is made of. Every request that
 * contains the word "each" was unbuildable.
 *
 * A region is the answer, and it is deliberately not a loop in the general
 * sense. `core.forEach` opens it, `core.collect` closes it, and every node on a
 * path between the two runs once per item with `{{ each.item }}` in scope. The
 * results gather at the collect node.
 *
 * Why a bounded region rather than a back-edge from the end of the body to the
 * start, which is how most canvas tools express this:
 *
 * • **The graph stays acyclic.** Ordering, validation, reachability, the cycle
 *   error that names its members — all of it is built on a DAG, and a back-edge
 *   makes every one of those a special case. The region carries the repetition
 *   in the *interpretation* of the graph rather than in its shape.
 *
 * • **The cost is knowable before it is spent.** `items × body` is an
 *   arithmetic the user can be shown and the runner can cap. A general loop's
 *   termination is a question you can only answer by running it, and this is a
 *   product where running it charges someone money.
 *
 * • **The boundary is where the scope changes.** Inside, values are
 *   per-iteration and gone when the iteration ends. Outside, they are not
 *   visible at all — the only thing that crosses is what `collect` gathered.
 *   Two explicit nodes make that boundary something the author sees.
 *
 * Nesting is rejected rather than supported. A region inside a region is a
 * multiplication of cost the user cannot see coming, and the honest version of
 * that feature needs a cost preview that does not exist yet.
 */

import { getNodeDef } from './registry.js';
import { topoSort } from './graph.js';

export const FOR_EACH = 'core.forEach';
export const COLLECT = 'core.collect';

/** Everything reachable downstream of `from`, transitively. */
function descendants(edges, from) {
  const out = new Map();
  for (const edge of edges) {
    if (!out.has(edge.source)) out.set(edge.source, []);
    out.get(edge.source).push(edge.target);
  }
  const seen = new Set();
  const stack = [...(out.get(from) || [])];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(out.get(id) || []));
  }
  return seen;
}

/** Everything upstream of `to`, transitively. */
function forebears(edges, to) {
  const incoming = new Map();
  for (const edge of edges) {
    if (!incoming.has(edge.target)) incoming.set(edge.target, []);
    incoming.get(edge.target).push(edge.source);
  }
  const seen = new Set();
  const stack = [...(incoming.get(to) || [])];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(incoming.get(id) || []));
  }
  return seen;
}

/**
 * Find every region in a graph, with whatever is wrong with each.
 *
 * Returns regions even when they are malformed, because the validator needs to
 * describe the problem and the runner needs to refuse the graph — both are
 * better served by "here is the broken region" than by an empty list.
 *
 * @returns {{regions: Array, errors: string[]}}
 *   region = { forEachId, collectId, body: string[], order: string[] }
 */
export function findRegions({ nodes = [], edges = [] } = {}) {
  const errors = [];
  const regions = [];

  const starts = nodes.filter(node => node.type === FOR_EACH);
  const ends = nodes.filter(node => node.type === COLLECT);

  if (!starts.length) {
    for (const end of ends) {
      errors.push(
        `“${end.id}” collects loop results, but nothing upstream starts a loop. ` +
          `Add a For Each step, or delete this one.`
      );
    }
    return { regions, errors };
  }

  // Order is needed to lay the body out for execution, and a graph with a cycle
  // has already reported that as its own error — reporting consequences of it
  // as well buries the one that has to be fixed first.
  let position;
  try {
    position = new Map(topoSort(nodes, edges).map((node, index) => [node.id, index]));
  } catch {
    return { regions, errors };
  }

  /*
   * Nesting is checked before anything else, and that ordering is the whole
   * point of doing it separately.
   *
   * A loop inside a loop trips several later rules on its way past — the outer
   * opener sees two Collects downstream, so it reports an ambiguous ending —
   * and every one of those messages describes a symptom. The author reading
   * "this loop has 2 Collect steps" goes and deletes one, which is not the fix.
   * Naming the nesting first means the first error is the real one.
   */
  const nestedStarts = new Set();
  for (const outer of starts) {
    const downstream = descendants(edges, outer.id);
    for (const inner of starts) {
      if (inner.id === outer.id || !downstream.has(inner.id)) continue;
      nestedStarts.add(outer.id);
      nestedStarts.add(inner.id);
      errors.push(
        `“${inner.id}” starts a loop inside the one “${outer.id}” starts. Nested loops multiply ` +
          `what a run costs in a way nobody can see coming, so they are not allowed — flatten ` +
          `the list with a Code step first, or split this into two workflows.`
      );
    }
  }

  const claimed = new Set();

  for (const start of starts) {
    if (nestedStarts.has(start.id)) continue;

    const downstream = descendants(edges, start.id);
    const matches = ends.filter(end => downstream.has(end.id));

    if (!matches.length) {
      errors.push(
        `“${start.id}” starts a loop that never ends. Add a Collect step after the steps ` +
          `that should repeat, and connect the last one to it.`
      );
      continue;
    }
    if (matches.length > 1) {
      errors.push(
        `“${start.id}” has ${matches.length} Collect steps downstream (${matches.map(m => m.id).join(', ')}). ` +
          `A loop must end at exactly one.`
      );
      continue;
    }

    const end = matches[0];
    const body = [...downstream].filter(id => forebears(edges, end.id).has(id));

    if (!body.length) {
      errors.push(
        `“${start.id}” loops over nothing — there are no steps between it and “${end.id}”. ` +
          `Put the work that should repeat between them.`
      );
      continue;
    }

    // A body node shared between two regions would run under two different
    // per-iteration scopes at once, and "which one is `each`?" has no answer.
    const overlap = body.filter(id => claimed.has(id));
    if (overlap.length) {
      errors.push(`“${overlap[0]}” is inside two loops at once. Loops cannot overlap.`);
      continue;
    }

    /*
     * Nothing may enter or leave the body except through the two ends.
     *
     * An edge from outside into the middle of a body would run that node once
     * per iteration on the strength of a value produced once; an edge out would
     * hand a downstream node whichever iteration happened to finish last. Both
     * are the kind of bug that works in testing with one item.
     */
    const bodySet = new Set(body);
    for (const edge of edges) {
      const intoBody = bodySet.has(edge.target) && !bodySet.has(edge.source) && edge.source !== start.id;
      const outOfBody = bodySet.has(edge.source) && !bodySet.has(edge.target) && edge.target !== end.id;
      if (intoBody) {
        errors.push(
          `“${edge.source}” connects into the middle of the loop at “${edge.target}”. ` +
            `Everything entering a loop must go through “${start.id}”.`
        );
      }
      if (outOfBody) {
        errors.push(
          `“${edge.source}” is inside the loop but connects out to “${edge.target}”. ` +
            `Results leave a loop through “${end.id}”, which gathers them.`
        );
      }
    }

    body.forEach(id => claimed.add(id));
    regions.push({
      forEachId: start.id,
      collectId: end.id,
      body,
      order: [...body].sort((a, b) => position.get(a) - position.get(b)),
    });
  }

  return { regions, errors };
}

/**
 * `nodeId → the region it is inside`, for callers that ask per node.
 *
 * The forEach and collect nodes themselves are not "inside" — they are the
 * boundary, they run once, and `{{ each.* }}` means nothing at either of them.
 */
export function regionByNode(regions) {
  const map = new Map();
  for (const region of regions) {
    for (const id of region.body) map.set(id, region);
  }
  return map;
}

/** Is this node type one that opens or closes a region? */
export function isRegionBoundary(type) {
  return type === FOR_EACH || type === COLLECT;
}

/** Whatever the author pointed at, as a list the runner can walk. */
export function coerceItems(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined || value === '') return [];

  // A JSON field arrives substituted-then-parsed, but a text field carrying a
  // reference to an array arrives as the JSON *string* the interpolator
  // rendered. Recovering the array here is the difference between a working
  // loop and "expected a list, got a string" on a value that plainly is one.
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return [];
    if (text.startsWith('[')) {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) return parsed;
      } catch {
        /* fall through to the error below */
      }
    }
  }

  const err = new Error(
    `Items must be a list. Got ${Array.isArray(value) ? 'a list' : typeof value}` +
      `${typeof value === 'string' ? ` starting "${value.slice(0, 40)}"` : ''}. ` +
      `Point this at a step output that is an array, like {{ fetch.data.items }}.`
  );
  err.code = 'NOT_A_LIST';
  throw err;
}

/** Nodes whose type the registry does not know cannot be region-analysed. */
export function hasUnknownTypes(nodes) {
  return nodes.some(node => !getNodeDef(node.type));
}

export default { findRegions, regionByNode, isRegionBoundary, coerceItems, FOR_EACH, COLLECT };
