/**
 * Graph edits, expressed as operations.
 *
 * The architect never emits a finished graph. It emits *operations* — add this
 * node, connect these two, change that field — and they are applied to the
 * graph that already exists.
 *
 * The alternative, having the model return the whole graph, is what most tools
 * do and it degrades badly the moment anyone edits anything. "Also email me the
 * result" makes the model regenerate everything: node ids get reshuffled, every
 * `{{ }}` reference the user hand-tuned breaks, and the canvas layout they
 * arranged is gone. They asked for one node and got a new workflow that
 * resembles theirs.
 *
 * Operations also make a create and an edit the same code path — a create is
 * just an edit against an empty graph — and they fail individually. A five-op
 * edit where op three names a node type that doesn't exist still applies the
 * other four and reports what it couldn't do, which matters most in exactly the
 * situation the model is trying hardest: a long, ambitious request.
 *
 * Every op is validated against the registry before it touches anything, so the
 * model can neither invent a node type nor write a value into a field that
 * doesn't exist.
 */

import { getNodeDef, isKnownType } from './registry.js';
import { suggestNodeId, findOrphans, validateGraph } from './graph.js';
import { safeMessage } from './safety.js';
import config from '../config/index.js';

export const OPS = ['addNode', 'updateNode', 'deleteNode', 'connect', 'disconnect', 'rename'];

/**
 * Apply operations to a graph, returning a new one.
 *
 * @param {{nodes:Array, edges:Array}} graph
 * @param {Array} operations
 * @returns {{graph, name, applied, rejected}}
 */
export function applyOperations(graph, operations = []) {
  const nodes = graph.nodes.map(n => ({
    ...n,
    data: { ...n.data, values: { ...n.data?.values } },
  }));
  const edges = [...graph.edges];
  const rejected = [];
  const applied = [];
  let name = null;
  const maxNodes = config.agentic?.maxNodes || 60;

  const findNode = id => nodes.find(n => n.id === id);

  // New nodes land on a simple downward grid. Anything cleverer is wasted: the
  // user drags them where they want them the moment they see the canvas, and a
  // layout algorithm would fight those manual positions on the next edit.
  const nextPosition = () => ({ x: 300, y: 90 + nodes.length * 140 });

  for (const op of operations) {
    try {
      switch (op.op) {
        case 'addNode': {
          if (!isKnownType(op.type)) {
            rejected.push(`"${op.type}" isn’t an available node type.`);
            break;
          }
          if (nodes.length >= maxNodes) {
            rejected.push(
              `A workflow can have at most ${maxNodes} nodes. Delete orphans before adding more.`
            );
            break;
          }
          const def = getNodeDef(op.type);

          if (def.kind === 'trigger') {
            const existing = nodes.find(n => getNodeDef(n.type)?.kind === 'trigger');
            if (existing) {
              rejected.push(
                `Only one trigger is allowed — "${existing.id}" already exists. ` +
                `Update or delete it instead of adding another ${op.type}.`
              );
              break;
            }
          }

          // Honour the model's id when it's usable, and generate one when it is
          // missing or already taken — a collision would silently shadow an
          // existing node in every `{{ }}` reference pointing at it.
          const requested = op.id ? String(op.id).slice(0, 60) : '';
          const id =
            requested && !findNode(requested)
              ? requested
              : suggestNodeId(op.type, nodes.map(n => n.id));

          // Only keys the registry declares, and defaults for the rest. A model
          // that invents a field name would otherwise write dead data into the
          // graph that the inspector can't show and the user can't delete.
          const values = {};
          for (const field of def.fields) {
            if (op.values?.[field.key] !== undefined) values[field.key] = op.values[field.key];
            else if (field.default !== undefined) values[field.key] = field.default;
          }

          nodes.push({
            id,
            type: op.type,
            position: op.position || nextPosition(),
            data: {
              title: safeMessage(op.title, 120) || def.label,
              values,
              note: safeMessage(op.note, 500) || '',
            },
          });
          applied.push({ op: 'addNode', id, type: op.type });
          break;
        }

        case 'updateNode': {
          const node = findNode(op.id);
          if (!node) {
            rejected.push(`Can’t update "${op.id}" — no such node.`);
            break;
          }
          const def = getNodeDef(node.type);
          const changed = [];
          for (const field of def.fields) {
            if (op.values?.[field.key] !== undefined) {
              node.data.values[field.key] = op.values[field.key];
              changed.push(field.key);
            }
          }
          if (op.title) node.data.title = safeMessage(op.title, 120);
          if (op.note !== undefined) node.data.note = safeMessage(op.note, 500);
          applied.push({ op: 'updateNode', id: op.id, fields: changed });
          break;
        }

        case 'deleteNode': {
          const index = nodes.findIndex(n => n.id === op.id);
          if (index === -1) {
            rejected.push(`Can’t delete "${op.id}" — no such node.`);
            break;
          }
          nodes.splice(index, 1);
          // Edges touching a deleted node go with it. Leaving them would make
          // the graph fail validation for a reason the user didn't cause.
          for (let i = edges.length - 1; i >= 0; i--) {
            if (edges[i].source === op.id || edges[i].target === op.id) edges.splice(i, 1);
          }
          applied.push({ op: 'deleteNode', id: op.id });
          break;
        }

        case 'connect': {
          const source = findNode(op.from);
          if (!source || !findNode(op.to)) {
            rejected.push(`Can’t connect ${op.from} → ${op.to} — one of them doesn’t exist.`);
            break;
          }
          const handle = op.handle || 'main';
          const sourceDef = getNodeDef(source.type);
          if (!sourceDef.handles.out.includes(handle)) {
            rejected.push(
              `"${op.from}" has no "${handle}" output. It offers: ${sourceDef.handles.out.join(', ')}.`
            );
            break;
          }
          const exists = edges.some(
            e => e.source === op.from && e.target === op.to && (e.sourceHandle || 'main') === handle
          );
          if (!exists) {
            edges.push({
              id: `${op.from}-${handle}-${op.to}`,
              source: op.from,
              target: op.to,
              sourceHandle: handle,
              targetHandle: 'in',
            });
            applied.push({ op: 'connect', from: op.from, to: op.to, handle });
          }
          break;
        }

        case 'disconnect': {
          let removed = 0;
          for (let i = edges.length - 1; i >= 0; i--) {
            if (edges[i].source === op.from && edges[i].target === op.to) {
              edges.splice(i, 1);
              removed += 1;
            }
          }
          if (removed) applied.push({ op: 'disconnect', from: op.from, to: op.to });
          break;
        }

        case 'rename':
          name = safeMessage(op.name, 120);
          applied.push({ op: 'rename', name });
          break;

        default:
          rejected.push(`Unknown operation "${op.op}". Use one of: ${OPS.join(', ')}.`);
      }
    } catch (err) {
      rejected.push(`"${op.op}" failed: ${safeMessage(err.message, 160)}`);
    }
  }

  return { graph: { nodes, edges }, name, applied, rejected };
}

/** Render a graph compactly, the way the architect reads it back. */
export function describeGraph(graph) {
  if (!graph.nodes.length) return 'The graph is empty.';

  const nodes = graph.nodes
    .map(node => {
      const values = Object.entries(node.data?.values || {})
        .filter(([, v]) => v !== '' && v !== undefined && v !== null)
        .map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 140)}`)
        .join(' ');
      const title = node.data?.title ? ` "${node.data.title}"` : '';
      return `  ${node.id} (${node.type})${title}${values ? `\n      ${values}` : ''}`;
    })
    .join('\n');

  const edges = graph.edges.length
    ? graph.edges
        .map(e => {
          const handle = e.sourceHandle && e.sourceHandle !== 'main' ? `(${e.sourceHandle})` : '';
          return `  ${e.source} -${handle}-> ${e.target}`;
        })
        .join('\n')
    : '  (none)';

  const triggers = graph.nodes.filter(n => getNodeDef(n.type)?.kind === 'trigger');
  const orphans = findOrphans(graph.nodes, graph.edges);
  const diagnostics = [];
  if (triggers.length !== 1) {
    diagnostics.push(
      `TRIGGERS: ${triggers.length} (${triggers.map(t => t.id).join(', ') || 'none'}) — must be exactly 1`
    );
  }
  if (orphans.length) {
    diagnostics.push(
      `ORPHANS (${orphans.length}): ${orphans.map(n => n.id).slice(0, 20).join(', ')}` +
        (orphans.length > 20 ? '…' : '') +
        ' — connect or deleteNode'
    );
  }

  const check = validateGraph(graph, { mode: 'architect', requirements: [] });
  if (check.errors.length) {
    diagnostics.push(`ERRORS:\n${check.errors.map(e => `  - ${e}`).join('\n')}`);
  }
  if (check.warnings.length) {
    diagnostics.push(`WARNINGS:\n${check.warnings.map(w => `  - ${w}`).join('\n')}`);
  }

  return (
    `NODES:\n${nodes}\n\nCONNECTIONS:\n${edges}` +
    (diagnostics.length ? `\n\nDIAGNOSTICS:\n${diagnostics.join('\n')}` : '')
  );
}

export default { applyOperations, describeGraph, OPS };
