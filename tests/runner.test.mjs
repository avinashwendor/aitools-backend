/**
 * Runner tests — the walk itself, with the database and the ledger mocked out
 * but the executors real.
 *
 * The executors are deliberately *not* stubbed. The runner's contract with them
 * is the thing most likely to be subtly wrong — what a loop opener returns, how
 * a branch reports which arm survived, what a failure looks like — and a test
 * that fakes both sides of that contract proves only that the fake agrees with
 * itself. Everything here therefore uses node types whose real executors are
 * pure: Template, If, For Each, Collect. The one model call is mocked at the
 * provider, not at the node.
 *
 * These matter because the runner is the one place being wrong is expensive
 * twice: it spends the user's credits and it does things to the outside world.
 *
 *   npm test
 */

import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

let runDoc;
let workflowDoc;
/** What `spend` was asked to charge, so the bill can be checked against reality. */
let charged = null;
/** Model calls, for asserting a loop body really ran N times. */
let llmCalls = 0;
/** Stands in for the AgentMemory collection: `workflow|scope|keyHash`. */
const memoryStore = new Set();

const makeRun = () => ({
  _id: 'run1',
  workflow: 'wf1',
  user: 'u1',
  status: 'queued',
  trigger: { type: 'manual', payload: {} },
  steps: [],
  logs: [],
  credits: {},
  cost: {},
  tokens: {},
  save: async () => {},
});

mock.module('../src/models/index.js', {
  namedExports: {
    AgentRun: { findById: async () => runDoc, updateOne: async () => ({}) },
    AgentWorkflow: { findById: async () => workflowDoc, updateOne: async () => ({}) },
    /**
     * A real store, not a stub that always says "never seen it".
     *
     * The whole value of dedupe is what the *second* run does, so a mock that
     * forgets between runs would assert the one behaviour that already worked.
     */
    AgentMemory: {
      find: query => ({
        select: () => ({
          lean: async () =>
            [...memoryStore]
              .filter(row => {
                const [workflow, scope, keyHash] = row.split('|');
                return (
                  String(workflow) === String(query.workflow) &&
                  scope === query.scope &&
                  query.keyHash.$in.includes(keyHash)
                );
              })
              .map(row => ({ keyHash: row.split('|')[2] })),
        }),
      }),
      insertMany: async rows => {
        for (const row of rows) memoryStore.add(`${row.workflow}|${row.scope}|${row.keyHash}`);
        return rows;
      },
    },
    AgentCredential: { findOne: () => ({ select: async () => null }) },
  },
});

// The whole surface, not just what the runner calls: modules the runner pulls
// in transitively import the recorders, and a partial mock fails at import time
// with an error that names the wrong file.
mock.module('../src/billing/meterContext.js', {
  namedExports: {
    withMetering: fn => fn({ llmPaise: 0, searchPaise: 0, promptTokens: 0, completionTokens: 0 }),
    summarize: () => ({
      cost: { llmPaise: 0, searchPaise: 0, totalPaise: 0 },
      tokens: { prompt: 0, completion: 0 },
    }),
    currentUsage: () => null,
    recordLlmUsage: () => {},
    recordSearchUsage: () => {},
  },
});

mock.module('../src/billing/credits.js', {
  namedExports: {
    spend: async ({ cost }) => { charged = cost; return { ledgerId: null }; },
    recordFailure: async () => ({}),
  },
});

mock.module('../src/ai/llm.js', {
  namedExports: {
    LLMError: class LLMError extends Error {},
    complete: async ({ messages }) => {
      llmCalls += 1;
      return { content: `summary of ${messages[messages.length - 1].content}`, model: 'mock', usage: {}, ms: 1 };
    },
    completeJson: async () => ({ data: {}, raw: '{}', model: 'mock', usage: {} }),
  },
});

const { executeRun } = await import('../src/agentic/runner.js');

const node = (id, type, values = {}) => ({
  id, type, position: { x: 0, y: 0 }, data: { title: '', values, note: '' },
});
const edge = (source, target, sourceHandle = 'main') => ({
  id: `${source}-${target}`, source, target, sourceHandle, targetHandle: 'in',
});

async function runGraph(graph, triggerPayload = {}) {
  charged = null;
  llmCalls = 0;
  runDoc = makeRun();
  runDoc.trigger = { type: 'manual', payload: triggerPayload };
  workflowDoc = { _id: 'wf1', name: 'test', graph, toEditorJSON: () => ({}) };
  return executeRun({ runId: 'run1', user: { _id: 'u1' } });
}

const stepFor = (run, id) => run.steps.find(s => s.nodeId === id);

// ─────────────────────────────────────────────────────────────
describe('the walk', () => {
  test('runs steps in dependency order and threads outputs forward', async () => {
    const run = await runGraph({
      nodes: [
        node('t', 'trigger.manual'),
        node('a', 'core.template', { value: 'x' }),
        node('b', 'core.template', { value: '{{ a.value }}!' }),
      ],
      edges: [edge('t', 'a'), edge('a', 'b')],
    });

    assert.equal(run.status, 'succeeded');
    assert.equal(stepFor(run, 'b').output.value, 'x!');
  });

  /**
   * The reason the runner tracks liveness at all: topologically sorting and then
   * running everything means the "false" arm's side effects happen anyway.
   */
  test('only the branch that matched runs', async () => {
    const run = await runGraph({
      nodes: [
        node('t', 'trigger.manual'),
        node('cond', 'core.condition', { left: 'go', operator: 'equals', right: 'go' }),
        node('yes', 'core.template', { value: 'yes' }),
        node('no', 'core.template', { value: 'no' }),
      ],
      edges: [edge('t', 'cond'), edge('cond', 'yes', 'true'), edge('cond', 'no', 'false')],
    });

    assert.equal(stepFor(run, 'yes').status, 'done');
    assert.equal(stepFor(run, 'no').status, 'skipped');
    assert.equal(stepFor(run, 'no').output, undefined, 'the false arm must not have executed');
  });

  test('a failed step stops the run and names itself', async () => {
    const run = await runGraph({
      nodes: [
        node('t', 'trigger.manual'),
        node('boom', 'core.template', { value: 'not json', parseJson: true }),
        node('after', 'core.template', { value: 'x' }),
      ],
      edges: [edge('t', 'boom'), edge('boom', 'after')],
    });

    assert.equal(run.status, 'failed');
    assert.equal(run.failedNodeId, 'boom');
    assert.equal(stepFor(run, 'after').status, 'pending');
  });

  test('an unresolved reference is a warning on a step that still succeeds', async () => {
    const run = await runGraph({
      nodes: [node('t', 'trigger.manual'), node('a', 'core.template', { value: 'Hi {{ trigger.name }}' })],
      edges: [edge('t', 'a')],
    });

    assert.equal(stepFor(run, 'a').status, 'done');
    assert.equal(stepFor(run, 'a').warnings.length, 1);
    assert.match(stepFor(run, 'a').warnings[0], /empty at run time/);
  });
});

// ─────────────────────────────────────────────────────────────
/**
 * Iteration. Before this existed, "summarise each of the twenty articles" was
 * not expressible: a Code node could map a list, but nothing could make twenty
 * model calls, and those are the steps the work is actually made of.
 */
describe('loops', () => {
  /** trigger → forEach(list) → template → collect → template */
  const loopGraph = ({ forEach = {}, collect = {}, body = { value: 'did {{ each.item.name }}' } } = {}) => ({
    nodes: [
      node('t', 'trigger.manual'),
      node('loop', 'core.forEach', { items: '{{ trigger.list }}', ...forEach }),
      node('work', 'core.template', body),
      node('gather', 'core.collect', { value: '{{ work.value }}', ...collect }),
      node('out', 'core.template', { value: '{{ gather.count }} done' }),
    ],
    edges: [edge('t', 'loop'), edge('loop', 'work'), edge('work', 'gather'), edge('gather', 'out')],
  });

  const three = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];

  test('the body runs once per item, with that item in scope', async () => {
    const run = await runGraph(loopGraph(), { list: three });

    assert.equal(run.status, 'succeeded');
    assert.deepEqual(stepFor(run, 'gather').output.items, ['did a', 'did b', 'did c']);
  });

  test('collect gathers one result per pass and hands the list downstream', async () => {
    const run = await runGraph(loopGraph(), { list: three });

    assert.equal(stepFor(run, 'gather').output.count, 3);
    assert.equal(stepFor(run, 'out').output.value, '3 done');
  });

  test('the body is one console row carrying its iteration count', async () => {
    // Twenty-five rows per node would bury the shape of a run under its volume.
    const run = await runGraph(loopGraph(), { list: three });

    assert.equal(run.steps.filter(s => s.nodeId === 'work').length, 1);
    assert.equal(stepFor(run, 'work').iterations, 3);
  });

  test('a model step inside a loop really is called once per item', async () => {
    const graph = loopGraph();
    graph.nodes.find(n => n.id === 'work').type = 'core.llm';
    graph.nodes.find(n => n.id === 'work').data.values = { prompt: 'Summarise {{ each.item.name }}' };
    graph.nodes.find(n => n.id === 'gather').data.values.value = '{{ work.text }}';

    const run = await runGraph(graph, { list: three });

    assert.equal(run.status, 'succeeded');
    assert.equal(llmCalls, 3, 'this is the whole point of the feature');
  });

  test('credits are charged per pass, not per node', async () => {
    // Three passes over an AI Step costs three model calls, and a bill that says
    // otherwise will not match the provider invoice.
    const graph = loopGraph();
    graph.nodes.find(n => n.id === 'work').type = 'core.llm';
    graph.nodes.find(n => n.id === 'work').data.values = { prompt: 'x {{ each.item.name }}' };
    graph.nodes.find(n => n.id === 'gather').data.values.value = '{{ work.text }}';

    const run = await runGraph(graph, { list: three });

    assert.equal(stepFor(run, 'work').credits, 12, 'core.llm is 4 credits × 3 passes');
    assert.ok(charged >= 12);
  });

  test('one bad item does not throw away the passes that worked', async () => {
    const run = await runGraph(
      loopGraph({ body: { value: '{{ each.item.json }}', parseJson: true } }),
      { list: [{ json: '{"ok":1}' }, { json: 'not json at all' }, { json: '{"ok":3}' }] }
    );

    assert.equal(run.status, 'succeeded');
    assert.equal(stepFor(run, 'gather').output.count, 2);
    assert.equal(stepFor(run, 'gather').output.failed, 1);
    assert.match(stepFor(run, 'gather').warnings[0], /1 of 3/);
  });

  test('but every item failing is a broken workflow, not awkward data', async () => {
    // Tolerating partial failure quietly would otherwise turn a wrong endpoint
    // or a bad credential into an empty list and a green run.
    const run = await runGraph(
      loopGraph({ body: { value: '{{ each.item.json }}', parseJson: true } }),
      { list: [{ json: 'nope' }, { json: 'also nope' }] }
    );

    assert.equal(run.status, 'failed');
    assert.match(run.error, /Every item failed/);
  });

  test('the item cap is what stops a 4,000-entry feed spending a month of credits', async () => {
    const run = await runGraph(loopGraph({ forEach: { maxItems: 2 } }), { list: three });

    assert.equal(stepFor(run, 'work').iterations, 2);
    assert.equal(stepFor(run, 'gather').output.count, 2);
  });

  test('an empty list runs the body zero times and still finishes', async () => {
    const run = await runGraph(loopGraph(), { list: [] });

    assert.equal(run.status, 'succeeded');
    assert.equal(stepFor(run, 'work').status, 'skipped');
    assert.deepEqual(stepFor(run, 'gather').output.items, []);
  });

  test('a list that arrived as JSON text is still a list', async () => {
    // A text field holding a reference to an array renders as the JSON string
    // the interpolator produced. Refusing that rejects a value that plainly is
    // a list.
    const run = await runGraph(loopGraph(), { list: JSON.stringify(three) });

    assert.equal(run.status, 'succeeded');
    assert.equal(stepFor(run, 'gather').output.count, 3);
  });

  test('pointing a loop at something that is not a list says so plainly', async () => {
    const run = await runGraph(loopGraph(), { list: 'just a sentence' });

    assert.equal(run.status, 'failed');
    assert.match(run.error, /must be a list/);
  });

  test('a branch inside a loop is decided per pass', async () => {
    const graph = {
      nodes: [
        node('t', 'trigger.manual'),
        node('loop', 'core.forEach', { items: '{{ trigger.list }}' }),
        node('cond', 'core.condition', { left: '{{ each.item.keep }}', operator: 'equals', right: 'yes' }),
        node('work', 'core.template', { value: 'kept {{ each.item.name }}' }),
        node('gather', 'core.collect', { value: '{{ work.value }}' }),
      ],
      edges: [
        edge('t', 'loop'), edge('loop', 'cond'),
        edge('cond', 'work', 'true'), edge('work', 'gather'), edge('cond', 'gather', 'false'),
      ],
    };

    const run = await runGraph(graph, {
      list: [{ name: 'a', keep: 'yes' }, { name: 'b', keep: 'no' }, { name: 'c', keep: 'yes' }],
    });

    assert.equal(run.status, 'succeeded');
    assert.equal(stepFor(run, 'work').iterations, 2, 'the middle item took the false arm');
    assert.deepEqual(stepFor(run, 'gather').output.items, ['kept a', 'kept c']);
  });

  test('iterations do not leak into each other when run concurrently', async () => {
    // The bug this guards against — pass 3 emailing pass 5's summary — is both
    // intermittent and invisible in a run log, which is the worst combination.
    const run = await runGraph(
      loopGraph({ forEach: { concurrency: 3 } }),
      { list: [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }, { name: 'e' }] }
    );

    assert.equal(run.status, 'succeeded');
    assert.deepEqual(
      [...stepFor(run, 'gather').output.items].sort(),
      ['did a', 'did b', 'did c', 'did d', 'did e']
    );
  });

  test('a malformed loop is refused before anything is charged for', async () => {
    const run = await runGraph({
      nodes: [
        node('t', 'trigger.manual'),
        node('loop', 'core.forEach', { items: '{{ trigger.list }}' }),
        node('work', 'core.template', { value: 'x' }),
      ],
      edges: [edge('t', 'loop'), edge('loop', 'work')],
    }, { list: three });

    assert.equal(run.status, 'failed');
    assert.match(run.error, /never ends/);
    // The step list is still seeded — the console shows what it *would* have
    // run — but not one of them executed, which is the part that costs money.
    assert.ok(run.steps.every(step => step.status === 'pending'), 'nothing should have executed');
  });
});

// ─────────────────────────────────────────────────────────────
/**
 * Memory between runs.
 *
 * Every assertion here is about the *second* run. A scheduled workflow with no
 * memory re-delivers the same items on every tick — the same ten articles,
 * hourly, forever — which is the schedule trigger being useless for the one
 * thing schedules are for. No amount of graph-building skill works around it,
 * because the missing piece is state rather than structure.
 */
describe('only new items', () => {
  const digest = ({ dedupe = {} } = {}) => ({
    nodes: [
      node('t', 'trigger.schedule', { every: 'day' }),
      node('fresh', 'core.dedupe', { items: '{{ trigger.feed }}', key: 'id', ...dedupe }),
      node('out', 'core.template', { value: '{{ fresh.count }} new' }),
    ],
    edges: [edge('t', 'fresh'), edge('fresh', 'out')],
  });

  const posts = n => Array.from({ length: n }, (_, i) => ({ id: `post-${i + 1}`, title: `Post ${i + 1}` }));

  test('everything is new the first time', async () => {
    memoryStore.clear();
    const run = await runGraph(digest(), { feed: posts(3) });

    assert.equal(run.status, 'succeeded');
    assert.equal(stepFor(run, 'fresh').output.count, 3);
    assert.equal(stepFor(run, 'fresh').output.skipped, 0);
  });

  test('and nothing is new the second time — this is the whole point', async () => {
    memoryStore.clear();
    await runGraph(digest(), { feed: posts(3) });
    const second = await runGraph(digest(), { feed: posts(3) });

    assert.equal(stepFor(second, 'fresh').output.count, 0);
    assert.equal(stepFor(second, 'fresh').output.skipped, 3);
    assert.equal(stepFor(second, 'out').output.value, '0 new');
  });

  test('an item added since the last run comes through on its own', async () => {
    memoryStore.clear();
    await runGraph(digest(), { feed: posts(3) });
    const second = await runGraph(digest(), { feed: [...posts(3), { id: 'post-4', title: 'Post 4' }] });

    assert.equal(stepFor(second, 'fresh').output.count, 1);
    assert.deepEqual(stepFor(second, 'fresh').output.items.map(i => i.id), ['post-4']);
  });

  test('an edited title is not a new item, because the key is the id', async () => {
    // The failure mode of keying on a title: a typo fix re-delivers the post.
    memoryStore.clear();
    await runGraph(digest(), { feed: [{ id: 'a', title: 'Original' }] });
    const second = await runGraph(digest(), { feed: [{ id: 'a', title: 'Original (corrected)' }] });

    assert.equal(stepFor(second, 'fresh').output.count, 0);
  });

  test('a list that repeats an item within itself only yields it once', async () => {
    memoryStore.clear();
    const run = await runGraph(digest(), { feed: [{ id: 'x' }, { id: 'x' }, { id: 'y' }] });

    assert.equal(stepFor(run, 'fresh').output.count, 2);
  });

  test('preview mode reports what is new without consuming it', async () => {
    // So a workflow can be tested without burning through the backlog.
    memoryStore.clear();
    await runGraph(digest({ dedupe: { markOnly: true } }), { feed: posts(2) });
    const second = await runGraph(digest({ dedupe: { markOnly: true } }), { feed: posts(2) });

    assert.equal(stepFor(second, 'fresh').output.count, 2, 'preview must not have recorded anything');
  });

  test('two steps can keep separate memories in one workflow', async () => {
    memoryStore.clear();
    const graph = {
      nodes: [
        node('t', 'trigger.schedule', { every: 'day' }),
        node('a', 'core.dedupe', { items: '{{ trigger.feed }}', key: 'id', scope: 'this step' }),
        node('b', 'core.dedupe', { items: '{{ trigger.feed }}', key: 'id', scope: 'this step' }),
      ],
      edges: [edge('t', 'a'), edge('a', 'b')],
    };
    const run = await runGraph(graph, { feed: posts(2) });

    // `b` reads the same feed but has its own memory, so `a` recording the
    // items must not mask them from `b`.
    assert.equal(stepFor(run, 'a').output.count, 2);
    assert.equal(stepFor(run, 'b').output.count, 2);
  });

  test('the two patterns compose: poll, filter to new, then work on each', async () => {
    // The workflow that was unbuildable before either piece existed.
    memoryStore.clear();
    const graph = {
      nodes: [
        node('t', 'trigger.schedule', { every: 'day' }),
        node('fresh', 'core.dedupe', { items: '{{ trigger.feed }}', key: 'id' }),
        node('loop', 'core.forEach', { items: '{{ fresh.items }}' }),
        node('sum', 'core.llm', { prompt: 'Summarise {{ each.item.title }}' }),
        node('gather', 'core.collect', { value: '{{ sum.text }}' }),
        node('digest', 'core.template', { value: '{{ gather.count }} summaries' }),
      ],
      edges: [
        edge('t', 'fresh'), edge('fresh', 'loop'), edge('loop', 'sum'),
        edge('sum', 'gather'), edge('gather', 'digest'),
      ],
    };

    const first = await runGraph(graph, { feed: posts(3) });
    assert.equal(first.status, 'succeeded');
    assert.equal(llmCalls, 3, 'three new posts, three summaries');
    assert.equal(stepFor(first, 'digest').output.value, '3 summaries');

    const second = await runGraph(graph, { feed: posts(3) });
    assert.equal(second.status, 'succeeded');
    assert.equal(llmCalls, 0, 'nothing new, so nothing was paid for');
    assert.equal(stepFor(second, 'digest').output.value, '0 summaries');
  });
});

// ─────────────────────────────────────────────────────────────
describe('memory is not consumed by building', () => {
  test('a dedupe step with no workflow passes everything through untracked', async () => {
    /*
     * This is the architect's path: it test-runs steps while building, with no
     * workflow id. If that recorded, the entire existing backlog would be
     * marked seen before the workflow ever ran, and the user's first real run
     * would find nothing new — the thing they just paid to build appearing to
     * do nothing at all.
     */
    memoryStore.clear();
    const { getExecutor } = await import('../src/agentic/executors.js');
    const dedupe = getExecutor('core.dedupe');

    const out = await dedupe({
      values: { items: [{ id: 'a' }, { id: 'b' }], key: 'id' },
      nodeId: 'fresh',
      workflowId: null,
    });

    assert.equal(out.count, 2);
    assert.equal(memoryStore.size, 0, 'a build must never consume the backlog');
    assert.match(out.note, /test run/);
  });
});

// ─────────────────────────────────────────────────────────────
describe('a loop on a branch that was not taken', () => {
  const graph = {
    nodes: [
      node('t', 'trigger.manual'),
      node('cond', 'core.condition', { left: 'no', operator: 'equals', right: 'yes' }),
      node('loop', 'core.forEach', { items: '{{ trigger.list }}' }),
      node('work', 'core.template', { value: '{{ each.item }}' }),
      node('gather', 'core.collect', {}),
      node('after', 'core.template', { value: '{{ gather.count }}' }),
    ],
    edges: [
      edge('t', 'cond'), edge('cond', 'loop', 'true'), edge('loop', 'work'),
      edge('work', 'gather'), edge('gather', 'after'),
    ],
  };

  test('the whole loop reports as skipped, not left sitting at pending', async () => {
    // Body and Collect are driven by the opener rather than by the walk, so
    // when the opener never becomes live nothing else would ever touch their
    // rows — and a finished run showing three steps still spinning reads as a
    // run that hung.
    const run = await runGraph(graph, { list: [{ a: 1 }] });

    assert.equal(run.status, 'succeeded');
    for (const id of ['loop', 'work', 'gather', 'after']) {
      assert.equal(stepFor(run, id).status, 'skipped', `${id} should be skipped`);
    }
  });
});
