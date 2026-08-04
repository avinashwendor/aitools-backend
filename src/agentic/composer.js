/**
 * Build and edit a workflow graph from a chat message.
 *
 * This is the "just tell it what you want" half of the studio, and the design
 * question it answers is: what exactly should the model emit?
 *
 * The obvious answer — have it emit the finished graph — is what most tools do
 * and it degrades badly on edits. "Also email me the result" makes the model
 * regenerate the whole graph, which reshuffles node ids, breaks every `{{ }}`
 * reference the user hand-tuned, and loses their canvas layout. The user asked
 * for one node and got a new workflow that happens to resemble theirs.
 *
 * So the model emits **operations** — add this node, connect these two, change
 * that field, delete this one — and we apply them to the graph we already have.
 * A create is just an edit against an empty graph, which means one prompt, one
 * validator, and one code path for both. Ids the user sees stay stable, layout
 * survives, and a malformed op is rejected individually instead of taking the
 * whole edit with it.
 *
 * The model never gets to write a URL into a credential field or invent a node
 * type: every op is validated against the registry before it touches anything.
 */

import { completeJson } from '../ai/llm.js';
import { NODE_LIST, getNodeDef, typesForSurface } from './registry.js';
import { validateGraph, suggestNodeId } from './graph.js';
import { safeMessage } from './safety.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('agentic:composer');

const OPS = ['addNode', 'updateNode', 'deleteNode', 'connect', 'disconnect', 'rename'];

/**
 * The registry, rendered for the prompt.
 *
 * Generated from the same object the executors use rather than written out, so
 * a node added next month is immediately composable without anyone remembering
 * to update a prompt. Fields are listed with their types and requiredness
 * because the single most common composer failure is a node that looks right
 * and is missing the one field that makes it run.
 */
function describeNodes(surface) {
  const allowed = new Set(typesForSurface(surface));
  return NODE_LIST.filter(node => allowed.has(node.type))
    .map(node => {
      const fields = node.fields
        .map(f => `${f.key}${f.required ? '*' : ''}:${f.type}`)
        .join(', ') || 'none';
      const outputs = node.outputs.map(o => o.path).join(', ') || 'none';
      return `- ${node.type} — ${node.description}\n    fields: ${fields}\n    outputs: ${outputs}`;
    })
    .join('\n');
}

function systemPrompt(surface) {
  return `You design automation workflows as a directed graph of nodes.

You emit OPERATIONS against the user's existing graph — never a whole new graph.
If the graph already has nodes, change what the user asked about and leave the
rest alone. Reusing an existing node is always better than adding a second one
that does the same thing.

AVAILABLE NODE TYPES (fields marked * are required):
${describeNodes(surface)}

RULES

1. Exactly one trigger node, always. Add one only if the graph has none.
2. Node ids are short, lowercase, and meaningful — "open_1", "extract_price",
   "email_out". They are what the user types inside {{ }}, so they must read well.
3. Reference an earlier node's output with {{ nodeId.path }}, using only the
   output paths listed above. Never reference a node that runs later.
4. Fill every required field. A node missing one will not run.
5. Credential fields take an id the user selects in the editor — leave them
   empty and mention it in your reply.
6. Connect every node you add. An unconnected node never executes.
7. Prefer the fewest nodes that do the job. Every node costs the user credits.

RESPONSE FORMAT — JSON only:
{
  "reply": "<one short paragraph, plain language, addressed to the user>",
  "operations": [
    { "op": "addNode", "id": "open_1", "type": "browser.open",
      "title": "Open the listing", "values": { "url": "https://…" } },
    { "op": "connect", "from": "start_1", "to": "open_1", "handle": "main" },
    { "op": "updateNode", "id": "llm_1", "values": { "prompt": "…" } },
    { "op": "deleteNode", "id": "old_2" },
    { "op": "disconnect", "from": "a", "to": "b" },
    { "op": "rename", "name": "Daily price watch" }
  ]
}

Return an empty operations array if the request isn't about changing the
workflow, and answer in "reply" instead.`;
}

/** Render the current graph compactly for the prompt. */
function describeGraph(graph) {
  if (!graph.nodes.length) return 'The graph is empty.';

  const nodes = graph.nodes
    .map(n => {
      const values = Object.entries(n.data?.values || {})
        .filter(([, v]) => v !== '' && v !== undefined && v !== null)
        .map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 120)}`)
        .join(' ');
      return `  ${n.id} (${n.type})${n.data?.title ? ` "${n.data.title}"` : ''}${values ? ` — ${values}` : ''}`;
    })
    .join('\n');

  const edges = graph.edges.length
    ? graph.edges
        .map(e => `  ${e.source} -${e.sourceHandle && e.sourceHandle !== 'main' ? `(${e.sourceHandle})` : ''}-> ${e.target}`)
        .join('\n')
    : '  (none)';

  return `NODES:\n${nodes}\n\nCONNECTIONS:\n${edges}`;
}

function validateResponse(value) {
  if (!value || typeof value !== 'object') return 'Expected a JSON object.';
  if (typeof value.reply !== 'string') return '"reply" must be a string.';
  if (!Array.isArray(value.operations)) return '"operations" must be an array.';
  for (const op of value.operations) {
    if (!OPS.includes(op?.op)) return `Unknown operation "${op?.op}". Use one of: ${OPS.join(', ')}.`;
  }
  return null;
}

/**
 * Apply the model's operations to a graph.
 *
 * Every op is checked against the registry here, and a rejected op is collected
 * into `rejected` rather than thrown. The reason: a five-op edit where op three
 * names a node type that doesn't exist should still apply the other four and
 * tell the user what it couldn't do. Aborting the whole edit over one bad op
 * makes the composer feel brittle in exactly the situation where it is trying
 * hardest — a long, ambitious request.
 */
export function applyOperations(graph, operations, { surface = 'flow' } = {}) {
  const nodes = graph.nodes.map(n => ({ ...n, data: { ...n.data, values: { ...n.data?.values } } }));
  const edges = [...graph.edges];
  const rejected = [];
  let name = null;

  const allowed = new Set(typesForSurface(surface));
  const findNode = id => nodes.find(n => n.id === id);

  // New nodes land on a simple downward grid. Anything cleverer is wasted:
  // the user drags them where they want them the moment they see the canvas,
  // and a layout algorithm would fight those manual positions on the next edit.
  const nextPosition = () => ({
    x: 260,
    y: 80 + nodes.length * 130,
  });

  for (const op of operations) {
    try {
      switch (op.op) {
        case 'addNode': {
          if (!allowed.has(op.type)) {
            rejected.push(`"${op.type}" isn’t an available node type.`);
            break;
          }
          const def = getNodeDef(op.type);
          // Honour the model's id when it's usable, and generate one when it
          // is missing or already taken — a collision would silently shadow an
          // existing node in every `{{ }}` reference pointing at it.
          const requested = op.id ? String(op.id).slice(0, 60) : '';
          const id =
            requested && !findNode(requested)
              ? requested
              : suggestNodeId(op.type, nodes.map(n => n.id));

          // Only keys the registry declares. A model that invents a field name
          // would otherwise write dead data into the graph that the inspector
          // can't show and the user can't delete.
          const values = {};
          for (const field of def.fields) {
            if (op.values?.[field.key] !== undefined) values[field.key] = op.values[field.key];
          }

          nodes.push({
            id,
            type: op.type,
            position: op.position || nextPosition(),
            data: { title: safeMessage(op.title, 120) || def.label, values, note: '' },
          });
          break;
        }

        case 'updateNode': {
          const node = findNode(op.id);
          if (!node) {
            rejected.push(`Can’t update "${op.id}" — no such node.`);
            break;
          }
          const def = getNodeDef(node.type);
          for (const field of def.fields) {
            if (op.values?.[field.key] !== undefined) {
              node.data.values[field.key] = op.values[field.key];
            }
          }
          if (op.title) node.data.title = safeMessage(op.title, 120);
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
          break;
        }

        case 'connect': {
          if (!findNode(op.from) || !findNode(op.to)) {
            rejected.push(`Can’t connect ${op.from} → ${op.to} — one of them doesn’t exist.`);
            break;
          }
          const handle = op.handle || 'main';
          const sourceDef = getNodeDef(findNode(op.from).type);
          if (!sourceDef.handles.out.includes(handle)) {
            rejected.push(`"${op.from}" has no "${handle}" output.`);
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
          }
          break;
        }

        case 'disconnect': {
          for (let i = edges.length - 1; i >= 0; i--) {
            if (edges[i].source === op.from && edges[i].target === op.to) edges.splice(i, 1);
          }
          break;
        }

        case 'rename':
          name = safeMessage(op.name, 120);
          break;

        default:
          rejected.push(`Unknown operation "${op.op}".`);
      }
    } catch (err) {
      rejected.push(`"${op.op}" failed: ${safeMessage(err.message, 120)}`);
    }
  }

  return { graph: { nodes, edges }, name, rejected };
}

/**
 * One composer turn.
 *
 * @param {object} opts
 * @param {object} opts.graph     the graph as it stands
 * @param {string} opts.message   what the user just asked for
 * @param {string} opts.surface   'flow' | 'browser'
 * @param {Array}  opts.history   prior composer turns, newest last
 * @returns {Promise<{reply, graph, name, rejected, validation, operations}>}
 */
export async function compose({ graph, message, surface = 'flow', history = [], name = '' }) {
  const messages = [
    { role: 'system', content: systemPrompt(surface) },
    // Only the last few turns. The graph description below already carries the
    // full state, so older turns add tokens without adding information — and
    // they actively hurt, because a model reading its own earlier plan tends to
    // re-propose it.
    ...history.slice(-6).map(turn => ({
      role: turn.role === 'user' ? 'user' : 'assistant',
      content: String(turn.content).slice(0, 1500),
    })),
    {
      role: 'user',
      content:
        `CURRENT WORKFLOW${name ? ` — "${name}"` : ''} (${surface}):\n${describeGraph(graph)}\n\n` +
        `REQUEST: ${message}`,
    },
  ];

  const { data, model } = await completeJson({
    messages,
    role: 'planner',
    task: 'agentic:compose',
    temperature: 0.25,
    validate: validateResponse,
  });

  const applied = applyOperations(graph, data.operations, { surface });
  const validation = validateGraph(applied.graph, { surface });

  log.debug('Composer turn', {
    surface,
    operations: data.operations.length,
    rejected: applied.rejected.length,
    errors: validation.errors.length,
  });

  return {
    reply: safeMessage(data.reply, 1200),
    operations: data.operations,
    graph: applied.graph,
    name: applied.name,
    rejected: applied.rejected,
    validation,
    model,
  };
}

export default { compose, applyOperations };
