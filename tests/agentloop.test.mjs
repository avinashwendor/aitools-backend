/**
 * Agent harness tests.
 *
 * The model is canned, which is the only way to test a loop whose behaviour is
 * defined by what it does *between* model calls. Everything asserted here is a
 * way agent loops fail in production and never fail in a demo: a tool that
 * throws taking the whole session with it, a model repeating a failed call
 * forever, a hung fetch holding the loop open, and a build cut off one call
 * before it would have handed over its work.
 *
 *   npm test
 */

import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

/** Queue of canned model turns; each `complete` shifts one off. */
let turns = [];
/** Every transcript the loop sent, so the tests can assert what it was told. */
let sent = [];

/** A canned turn that calls tools. */
const calls = (...specs) => ({
  content: null,
  toolCalls: specs.map(([name, args], i) => ({
    id: `call_${i}`,
    name,
    arguments: args,
    raw: { id: `call_${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } },
  })),
});

/** A canned turn that answers in prose. */
const says = content => ({ content, toolCalls: [] });

mock.module('../src/ai/llm.js', {
  namedExports: {
    LLMError: class LLMError extends Error {},
    complete: async ({ messages }) => {
      sent.push(messages);
      const next = turns.shift();
      if (next === undefined) throw new Error('The loop made more model calls than the test queued.');
      return {
        content: next.content ?? null,
        toolCalls: next.toolCalls ?? [],
        finishReason: 'stop',
        model: 'mock',
        provider: 'mock',
        usage: { prompt_tokens: 10, completion_tokens: 5 },
        ms: 1,
      };
    },
  },
});

const { runAgentLoop, defineTool } = await import('../src/ai/agentLoop.js');

const reset = (...queued) => { turns = [...queued]; sent = []; };

/** The text of every message the loop has ever sent, as one string. */
const everythingSaid = () => JSON.stringify(sent);

const finishTool = defineTool({
  description: 'End the session.',
  properties: { summary: { type: 'string' } },
  terminal: true,
  run: async ({ summary }) => ({ summary }),
});

// ─────────────────────────────────────────────────────────────
describe('finishing', () => {
  test('a terminal tool ends the loop and hands back its result', async () => {
    reset(calls(['finish', { summary: 'done' }]));
    const out = await runAgentLoop({ system: 's', tools: { finish: finishTool }, maxSteps: 5 });

    assert.equal(out.finished, true);
    assert.equal(out.finishReason, 'finished');
    assert.deepEqual(out.result, { summary: 'done' });
    assert.equal(out.steps, 1);
  });

  test('token usage is aggregated across rounds, since the caller bills once', async () => {
    reset(calls(['peek', {}]), calls(['finish', { summary: 'x' }]));
    const out = await runAgentLoop({
      system: 's',
      tools: { finish: finishTool, peek: defineTool({ description: 'p', run: async () => 'ok' }) },
      maxSteps: 5,
    });
    assert.equal(out.usage.calls, 2);
    assert.equal(out.usage.promptTokens, 20);
  });

  test('a loop with no terminal tool may legitimately answer in prose', async () => {
    reset(says('here is your answer'));
    const out = await runAgentLoop({
      system: 's',
      tools: { peek: defineTool({ description: 'p', run: async () => 'ok' }) },
      maxSteps: 5,
    });
    assert.equal(out.finishReason, 'answered');
    assert.equal(out.text, 'here is your answer');
  });

  /**
   * The recovery that matters most: the model wrote the summary it meant to
   * hand over and simply did not make the call. Accepting that silently loses
   * the structured result and every gate that hangs off the terminal tool —
   * for the architect, that is the check refusing an invalid graph.
   */
  test('prose instead of the terminal call is nudged once, and recovers', async () => {
    reset(says('I built it, all good'), calls(['finish', { summary: 'I built it, all good' }]));
    const out = await runAgentLoop({ system: 's', tools: { finish: finishTool }, maxSteps: 5 });

    assert.equal(out.finishReason, 'finished');
    assert.match(everythingSaid(), /without calling `finish`/);
  });

  test('a model that ignores the nudge is not nudged forever', async () => {
    reset(says('no'), says('still no'));
    const out = await runAgentLoop({ system: 's', tools: { finish: finishTool }, maxSteps: 5 });

    assert.equal(out.finishReason, 'answered');
    assert.equal(out.steps, 2, 'it should give up after one nudge, not spend the budget');
  });
});

// ─────────────────────────────────────────────────────────────
describe('tool failure', () => {
  test('a tool that throws is reported to the model, not fatal to the loop', async () => {
    reset(calls(['broken', {}]), calls(['finish', { summary: 'recovered' }]));
    const out = await runAgentLoop({
      system: 's',
      maxSteps: 5,
      tools: {
        finish: finishTool,
        broken: defineTool({
          description: 'b',
          run: async () => { throw new Error('404 — that endpoint does not exist'); },
        }),
      },
    });

    assert.equal(out.finishReason, 'finished');
    // Phrased as something to act on. A stack trace tells the model nothing
    // about what to do differently.
    assert.match(everythingSaid(), /404 — that endpoint does not exist/);
    assert.match(everythingSaid(), /take a different approach/);
  });

  test('a call to a tool that does not exist lists the ones that do', async () => {
    reset(calls(['imaginary', {}]), calls(['finish', { summary: 'ok' }]));
    await runAgentLoop({ system: 's', tools: { finish: finishTool }, maxSteps: 5 });
    assert.match(everythingSaid(), /No tool named/);
    assert.match(everythingSaid(), /Available: finish/);
  });

  test('parallel calls really do run in parallel', async () => {
    let running = 0;
    let peak = 0;
    const slow = defineTool({
      description: 's',
      run: async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise(resolve => setTimeout(resolve, 30));
        running -= 1;
        return 'ok';
      },
    });

    reset(calls(['slow', { n: 1 }], ['slow', { n: 2 }], ['slow', { n: 3 }]), calls(['finish', { summary: 'x' }]));
    await runAgentLoop({ system: 's', tools: { finish: finishTool, slow }, maxSteps: 5 });

    assert.equal(peak, 3, 'three searches run serially triple the wait the user is watching');
  });
});

// ─────────────────────────────────────────────────────────────
/**
 * The loop that eats a build: told an endpoint 404s, the model calls it again
 * with identical arguments, gets the identical failure, and reacts identically.
 */
describe('repeated calls', () => {
  test('an identical call is answered rather than re-run', async () => {
    let ran = 0;
    const probe = defineTool({
      description: 'p',
      run: async () => { ran += 1; throw new Error('404'); },
    });

    reset(
      calls(['probe', { url: 'https://x.test/a' }]),
      calls(['probe', { url: 'https://x.test/a' }]),
      calls(['finish', { summary: 'gave up on that endpoint' }])
    );
    await runAgentLoop({ system: 's', tools: { finish: finishTool, probe }, maxSteps: 6 });

    assert.equal(ran, 1, 'the second identical call should not have reached the tool');
    assert.match(everythingSaid(), /already called probe with exactly these arguments/);
  });

  test('different arguments are not a repeat', async () => {
    let ran = 0;
    const probe = defineTool({ description: 'p', run: async () => { ran += 1; return 'ok'; } });

    reset(
      calls(['probe', { url: 'https://x.test/a' }]),
      calls(['probe', { url: 'https://x.test/b' }]),
      calls(['finish', { summary: 'x' }])
    );
    await runAgentLoop({ system: 's', tools: { finish: finishTool, probe }, maxSteps: 6 });

    assert.equal(ran, 2);
  });

  /**
   * Compaction tells the model an old result was dropped and to call again if
   * it still needs it. Blocking that repeat would be telling it to do something
   * and then refusing to let it.
   */
  test('a repeat is allowed again once the earlier result has left the context', async () => {
    let ran = 0;
    const probe = defineTool({ description: 'p', run: async () => { ran += 1; return 'ok'; } });
    const spin = defineTool({ description: 's', run: async () => 'tick' });

    reset(
      calls(['probe', { url: 'u' }]),
      calls(['spin', { i: 1 }]),
      calls(['spin', { i: 2 }]),
      calls(['spin', { i: 3 }]),
      calls(['probe', { url: 'u' }]),
      calls(['finish', { summary: 'x' }])
    );
    await runAgentLoop({ system: 's', tools: { finish: finishTool, probe, spin }, maxSteps: 8 });

    assert.equal(ran, 2, 'the model was told to call again if it still needed it');
  });

  test('the terminal tool may be called again after being refused', async () => {
    let attempts = 0;
    const strictFinish = defineTool({
      description: 'end',
      properties: { summary: { type: 'string' } },
      terminal: true,
      run: async ({ summary }) => {
        attempts += 1;
        if (attempts === 1) throw new Error('The workflow is not valid yet — fix node "a".');
        return { summary };
      },
    });

    // Identical arguments both times: a refused `finish` re-called after a fix
    // is the intended path out, not thrash.
    reset(calls(['finish', { summary: 'done' }]), calls(['finish', { summary: 'done' }]));
    const out = await runAgentLoop({ system: 's', tools: { finish: strictFinish }, maxSteps: 5 });

    assert.equal(attempts, 2);
    assert.equal(out.finishReason, 'finished');
  });
});

// ─────────────────────────────────────────────────────────────
describe('budget', () => {
  /**
   * The most expensive bad ending: fifteen calls of real research, cut off one
   * call before the summary that would have made any of it usable. The model
   * cannot see the counter, so it paces as if the budget were unlimited.
   */
  test('the model is told to land before the budget runs out', async () => {
    reset(calls(['spin', {}]), calls(['spin', {}]), calls(['finish', { summary: 'wrapped up early' }]));
    const out = await runAgentLoop({
      system: 's',
      maxSteps: 4,
      tools: { finish: finishTool, spin: defineTool({ description: 's', run: async () => 'tick' }) },
    });

    assert.equal(out.finishReason, 'finished');
    assert.match(everythingSaid(), /model calls? left in this session/);
    assert.match(everythingSaid(), /call `finish` now/);
  });

  test('no landing warning when there is nothing to land on', async () => {
    reset(calls(['spin', {}]), says('done'));
    await runAgentLoop({
      system: 's',
      maxSteps: 2,
      tools: { spin: defineTool({ description: 's', run: async () => 'tick' }) },
    });
    assert.doesNotMatch(everythingSaid(), /left in this session/);
  });

  test('exhausting the budget is reported rather than looking like success', async () => {
    reset(calls(['spin', {}]), calls(['spin', {}]));
    const out = await runAgentLoop({
      system: 's',
      maxSteps: 2,
      tools: { finish: finishTool, spin: defineTool({ description: 's', run: async () => 'tick' }) },
    });
    assert.equal(out.finished, false);
    assert.equal(out.finishReason, 'budget');
  });
});

// ─────────────────────────────────────────────────────────────
describe('tool deadlines', () => {
  test('a hung tool becomes an error the model can act on, not a hung build', async () => {
    const hangs = defineTool({ description: 'h', run: () => new Promise(() => {}) });

    reset(calls(['hangs', {}]), calls(['finish', { summary: 'moved on' }]));
    const out = await runAgentLoop({
      system: 's',
      maxSteps: 4,
      toolTimeoutMs: 50,
      tools: { finish: finishTool, hangs },
    });

    assert.equal(out.finishReason, 'finished');
    assert.match(everythingSaid(), /took longer than/);
  });
});

// ─────────────────────────────────────────────────────────────
describe('context management', () => {
  test('an old tool result is replaced by a marker that says it can be re-fetched', async () => {
    const big = defineTool({ description: 'b', run: async () => 'x'.repeat(5000) });

    reset(
      calls(['big', { i: 1 }]),
      calls(['big', { i: 2 }]),
      calls(['big', { i: 3 }]),
      calls(['big', { i: 4 }]),
      calls(['finish', { summary: 'x' }])
    );
    await runAgentLoop({ system: 's', tools: { finish: finishTool, big }, maxSteps: 6 });

    const last = JSON.stringify(sent[sent.length - 1]);
    assert.match(last, /dropped from context to save room/);
    assert.match(last, /Call it again if you still need it/);
  });

  test('the caller still receives every result, even the ones the model stopped seeing', async () => {
    const big = defineTool({ description: 'b', run: async () => 'x'.repeat(5000) });

    reset(
      calls(['big', { i: 1 }]),
      calls(['big', { i: 2 }]),
      calls(['big', { i: 3 }]),
      calls(['big', { i: 4 }]),
      calls(['finish', { summary: 'x' }])
    );
    const out = await runAgentLoop({ system: 's', tools: { finish: finishTool, big }, maxSteps: 6 });

    // The run console has to show the whole history — trimming is for the wire.
    assert.equal(out.toolCalls.filter(c => c.name === 'big' && c.ok).length, 4);
    assert.ok(out.toolCalls.every(c => c.name !== 'big' || c.content.length > 1000));
  });
});
