/**
 * The agent harness.
 *
 * One loop: give a model a goal and a set of tools, let it call them, feed the
 * results back, repeat until it says it is done or runs out of budget. Both the
 * `core.agent` workflow node and the workflow architect run on this — they
 * differ only in which tools they are handed.
 *
 * Four decisions here are load-bearing, and each of them is the fix for a way
 * agent loops normally fail:
 *
 * 1. **A tool that throws is not a loop that fails.** The error comes back to
 *    the model as the tool's result, phrased as something it can act on. That
 *    is the entire self-correction mechanism: an agent told "404 — that
 *    endpoint doesn't exist" tries a different one, whereas an agent whose loop
 *    aborted tells the user it couldn't do it. Only an aborted signal and a
 *    dead model provider actually stop the loop.
 *
 * 2. **Parallel calls run in parallel.** Models routinely emit three searches
 *    at once, and running them serially triples the wall-clock of the one part
 *    of a run the user is watching.
 *
 * 3. **Tool results are capped, and old ones are dropped first.** A page fetch
 *    is tens of thousands of characters and the model needs it once. Left in
 *    the transcript it is re-sent on every subsequent round, so a ten-step run
 *    pays for the same page ten times and eventually overflows the window.
 *    Older results are replaced by a placeholder rather than removed, so the
 *    model can still see that it already looked.
 *
 * 4. **Finishing is a tool call.** A model that answers in prose has no way to
 *    say *how* it finished or hand back a structured result; making `finish`
 *    (or whatever the caller marks terminal) an explicit call means the loop's
 *    exit is a decision with arguments rather than an inference from silence.
 *
 * 5. **The transcript is summarised before it overflows.** Dropping old tool
 *    results (3) buys a lot of room but not unbounded room: the assistant's own
 *    reasoning accumulates too, and a fifteen-step build hits the context limit
 *    with no warning and no partial result. Past a threshold the older half of
 *    the conversation is replaced by a written brief of what happened, so the
 *    loop can run as long as the work takes.
 */

import { complete, LLMError } from './llm.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('ai:agent');

/** Default per-tool-result ceiling, in characters, before it is truncated. */
const MAX_RESULT_CHARS = 6000;

/** Tool results older than this many rounds are collapsed to a placeholder. */
const KEEP_FULL_RESULTS_FOR_ROUNDS = 3;

/**
 * Transcript size that triggers summarisation, in estimated tokens.
 *
 * Set well below any current model's window. The threshold is not about fitting
 * — it is about cost: every round re-sends the whole transcript, so a loop that
 * lets it grow to 100k pays 100k of input tokens on every subsequent step. Two
 * summarisation calls are cheaper than five oversized rounds.
 */
const SUMMARIZE_AT_TOKENS = 24_000;

/** Messages kept verbatim at the tail when summarising. */
const KEEP_LAST_MESSAGES = 12;

/** Rough token count. Four characters per token is close enough to decide with. */
export function estimateTokens(messages) {
  let chars = 0;
  for (const message of messages) {
    chars += (message.content || '').length;
    // Tool calls carry their arguments outside `content`, and a graph edit's
    // arguments are frequently the largest thing in the transcript.
    if (message.tool_calls) chars += JSON.stringify(message.tool_calls).length;
  }
  return Math.round(chars / 4);
}

/**
 * Render our tool objects as OpenAI function-tool definitions.
 *
 * Kept as a mapping rather than storing the wire format directly so a tool is
 * declared once, with its handler next to its schema — the two drifting apart
 * is how an agent ends up calling a parameter the handler never reads.
 */
function toWireTools(tools) {
  return Object.entries(tools).map(([name, tool]) => ({
    type: 'function',
    function: {
      name,
      description: tool.description,
      parameters: tool.parameters || { type: 'object', properties: {} },
    },
  }));
}

function stringifyResult(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(text, limit) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…[truncated — ${text.length} characters total]`;
}

/**
 * Collapse tool results the model has already had a chance to use.
 *
 * Only the transcript sent to the provider is trimmed; the caller's copy of
 * what happened is untouched, because the run console has to show the whole
 * history even when the model no longer sees it.
 */
function compact(messages, currentRound) {
  return messages.map(message => {
    if (message.role !== 'tool') return message;
    if (currentRound - (message._round ?? 0) < KEEP_FULL_RESULTS_FOR_ROUNDS) return message;
    if (message.content.length < 400) return message;
    return {
      ...message,
      content: `[result from ${message.name} — ${message.content.length} characters, dropped from context to save room. Call it again if you still need it.]`,
    };
  });
}

/**
 * Where the transcript can be cut without orphaning a tool result.
 *
 * The wire format requires every `tool` message to follow the assistant turn
 * whose `tool_calls` produced it. Cut in the middle of that pair and the
 * provider rejects the whole request with a 400 that names a `tool_call_id` —
 * which is a confusing way to discover your compaction is wrong, and it happens
 * only on long runs, i.e. the ones you least want to lose.
 *
 * So the boundary is walked forward until the first retained message is not a
 * tool result. Anything skipped that way joins the summarised head, where its
 * assistant turn already is.
 *
 * @returns {number} index of the first message to keep verbatim
 */
export function safeCutPoint(messages, desired) {
  let cut = Math.max(1, Math.min(desired, messages.length));
  while (cut < messages.length && messages[cut].role === 'tool') cut += 1;
  return cut;
}

/**
 * Replace the older half of the transcript with a written account of it.
 *
 * Written by the `fast` model, because this is a summarisation of text that is
 * already in front of it — the cheapest capable model does it as well as the
 * expensive one, and using the expensive one would mean the act of saving
 * tokens is itself one of the larger token costs in the loop.
 *
 * On failure the original transcript is returned unchanged. A summarisation
 * that throws must not end a build: the next round may still fit, and if it
 * doesn't, an overflow error from the provider is a better outcome than losing
 * the work to a helper call.
 */
async function summarizeHistory({ transcript, task, signal, onEvent }) {
  const cut = safeCutPoint(transcript, transcript.length - KEEP_LAST_MESSAGES);
  // Nothing meaningful to fold up — leave it alone rather than paying a call to
  // summarise three messages.
  if (cut <= 2) return transcript;

  const system = transcript[0];
  const head = transcript.slice(1, cut);
  const tail = transcript.slice(cut);

  const rendered = head
    .map(message => {
      if (message.role === 'tool') return `[${message.name} returned] ${message.content}`;
      if (message.tool_calls?.length) {
        const calls = message.tool_calls
          .map(call => `${call.function?.name}(${String(call.function?.arguments || '').slice(0, 400)})`)
          .join(', ');
        return `[called] ${calls}${message.content ? `\n${message.content}` : ''}`;
      }
      return `[${message.role}] ${message.content}`;
    })
    .join('\n\n')
    .slice(0, 60_000);

  try {
    const { content } = await complete({
      role: 'fast',
      task: `${task}:summarize`,
      temperature: 0,
      maxTokens: 1500,
      messages: [
        {
          role: 'system',
          content:
            'You compress an AI agent\'s working transcript so it can keep going with less ' +
            'context. Write a dense brief in the third person covering, in this order:\n' +
            '1. What has been established as fact, with the specifics — exact URLs, endpoints, ' +
            'auth schemes, field names, IDs. These are the details the agent will otherwise ' +
            're-fetch or, worse, invent.\n' +
            '2. What has already been built or changed.\n' +
            '3. What was tried and failed, and why — so it is not tried again.\n' +
            '4. What remains to be done.\n\n' +
            'Keep every concrete identifier. Drop narration, pleasantries and reasoning that ' +
            'led nowhere. No preamble, no headings.',
        },
        { role: 'user', content: rendered },
      ],
      signal,
    });

    if (!content?.trim()) return transcript;

    onEvent({ type: 'compacted', droppedMessages: head.length });
    log.debug('Transcript summarised', { task, dropped: head.length, kept: tail.length });

    return [
      system,
      // A user turn rather than a system one: providers weight a second system
      // message unpredictably, and some reject one that isn't first. Framed as
      // the record of prior work so the model reads it as established fact.
      {
        role: 'user',
        content:
          `[Summary of earlier work in this session — ${head.length} messages compacted. ` +
          `Treat everything here as already done and already known.]\n\n${content.trim()}`,
      },
      ...tail,
    ];
  } catch (err) {
    log.warn('Transcript summarisation failed — continuing uncompacted', {
      task,
      error: err.message,
    });
    return transcript;
  }
}

/**
 * Run the loop.
 *
 * @param {object} opts
 * @param {string} opts.system                 system prompt
 * @param {Array}  opts.messages               conversation so far (user/assistant turns)
 * @param {Record<string, {description, parameters, run, terminal?}>} opts.tools
 * @param {number} [opts.maxSteps]             hard ceiling on model calls
 * @param {string} [opts.role]                 'fast' | 'planner' | 'reasoning'
 * @param {string} [opts.task]                 telemetry label
 * @param {number} [opts.temperature]
 * @param {number} [opts.maxResultChars]       per-tool-result ceiling
 * @param {number} [opts.summarizeAtTokens]    transcript size that triggers compaction
 * @param {(event:object)=>void} [opts.onEvent]
 * @param {AbortSignal} [opts.signal]
 * @param {object} [opts.context]              passed to every tool handler
 * @returns {Promise<{finished, finishReason, result, text, steps, transcript, toolCalls, usage}>}
 */
export async function runAgentLoop({
  system,
  messages = [],
  tools = {},
  maxSteps = 10,
  role = 'planner',
  task = 'agent',
  temperature = 0.2,
  maxResultChars = MAX_RESULT_CHARS,
  summarizeAtTokens = SUMMARIZE_AT_TOKENS,
  onEvent = () => {},
  signal,
  context = {},
}) {
  const wireTools = toWireTools(tools);
  let transcript = [
    { role: 'system', content: system },
    ...messages,
  ];

  /** Everything that happened, for the caller and the UI. */
  const toolCalls = [];
  let steps = 0;
  let text = '';
  let finished = false;
  let finishReason = 'budget';
  let result = null;

  /**
   * Tokens across every round.
   *
   * Aggregated here rather than read back off the ledger because the caller
   * charges for the loop as one unit, and a loop that made nine model calls has
   * nine ledger rows that nothing else knows belong together. The ledger stays
   * the record of provider spend; this is what the credit charge is computed
   * from.
   */
  const usage = { promptTokens: 0, completionTokens: 0, calls: 0, models: [] };

  while (steps < maxSteps) {
    if (signal?.aborted) {
      finishReason = 'aborted';
      break;
    }

    steps += 1;
    onEvent({ type: 'step', step: steps, of: maxSteps });

    // Before the call, not after: the point is to make *this* round cheaper.
    if (estimateTokens(transcript) > summarizeAtTokens) {
      transcript = await summarizeHistory({ transcript, task, signal, onEvent });
    }

    let response;
    try {
      response = await complete({
        messages: compact(transcript, steps),
        tools: wireTools,
        role,
        task,
        temperature,
        signal,
      });
    } catch (err) {
      // A dead provider is not something the model can reason its way out of,
      // so unlike a tool failure this ends the loop.
      if (err instanceof LLMError) {
        finishReason = 'llm_error';
        onEvent({ type: 'error', message: err.message });
        throw err;
      }
      throw err;
    }

    usage.promptTokens += response.usage?.prompt_tokens ?? 0;
    usage.completionTokens += response.usage?.completion_tokens ?? 0;
    usage.calls += 1;
    const usedModel = `${response.provider}/${response.model}`;
    if (!usage.models.includes(usedModel)) usage.models.push(usedModel);

    if (response.content) {
      text = response.content;
      onEvent({ type: 'thinking', text: response.content });
    }

    if (!response.toolCalls.length) {
      // The model answered directly. That is a legitimate finish for a loop
      // whose tools are all optional, and a soft failure for one that was
      // supposed to call `finish` — the caller decides which by looking at
      // `finishReason`.
      finishReason = 'answered';
      finished = true;
      break;
    }

    // The assistant turn has to go into the transcript exactly as the provider
    // sent it, tool_calls and all: the follow-up `tool` messages are only valid
    // if their `tool_call_id` refers to a call the provider can see.
    transcript.push({
      role: 'assistant',
      content: response.content || null,
      tool_calls: response.toolCalls.map(call => call.raw),
    });

    const outcomes = await Promise.all(
      response.toolCalls.map(call =>
        invokeTool({ call, tools, context, signal, onEvent, maxResultChars })
      )
    );

    for (const outcome of outcomes) {
      toolCalls.push(outcome);
      transcript.push({
        role: 'tool',
        tool_call_id: outcome.id,
        name: outcome.name,
        content: outcome.content,
        _round: steps,
      });
    }

    const terminal = outcomes.find(outcome => outcome.terminal && outcome.ok);
    if (terminal) {
      finished = true;
      finishReason = 'finished';
      result = terminal.result;
      break;
    }
  }

  if (!finished && finishReason === 'budget') {
    onEvent({ type: 'budget_exhausted', steps });
  }

  onEvent({ type: 'done', finishReason, steps });

  log.debug('Agent loop complete', {
    task, steps, finishReason, tools: toolCalls.length,
    tokens: usage.promptTokens + usage.completionTokens,
  });

  return { finished, finishReason, result, text, steps, transcript, toolCalls, usage };
}

/** Call one tool, turning every failure into something the model can read. */
async function invokeTool({ call, tools, context, signal, onEvent, maxResultChars = MAX_RESULT_CHARS }) {
  const tool = tools[call.name];
  const startedAt = Date.now();

  onEvent({ type: 'tool.start', id: call.id, name: call.name, args: call.arguments });

  if (!tool) {
    const message = `No tool named "${call.name}". Available: ${Object.keys(tools).join(', ')}.`;
    onEvent({ type: 'tool.end', id: call.id, name: call.name, ok: false, error: message, ms: 0 });
    return { id: call.id, name: call.name, args: call.arguments, ok: false, content: message, ms: 0 };
  }

  try {
    const value = await tool.run(call.arguments || {}, { ...context, signal });
    const ms = Date.now() - startedAt;
    const content = truncate(stringifyResult(value), maxResultChars);

    onEvent({
      type: 'tool.end',
      id: call.id,
      name: call.name,
      ok: true,
      result: value,
      ms,
    });

    return {
      id: call.id,
      name: call.name,
      args: call.arguments,
      ok: true,
      result: value,
      content,
      ms,
      terminal: Boolean(tool.terminal),
    };
  } catch (err) {
    const ms = Date.now() - startedAt;
    // Phrased as an instruction, not a stack trace. "Failed: ECONNREFUSED"
    // tells the model nothing about what to do next; naming the tool and the
    // problem and inviting a different approach is what produces a retry that
    // isn't identical to the call that just failed.
    const content = `${call.name} failed: ${err.message}. Fix the arguments and try again, or take a different approach.`;

    onEvent({ type: 'tool.end', id: call.id, name: call.name, ok: false, error: err.message, ms });

    return {
      id: call.id,
      name: call.name,
      args: call.arguments,
      ok: false,
      error: err.message,
      content,
      ms,
    };
  }
}

/** Shorthand for declaring a tool without repeating the JSON-schema boilerplate. */
export function defineTool({ description, properties = {}, required = [], run, terminal = false }) {
  return {
    description,
    parameters: {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    },
    run,
    terminal,
  };
}

export default { runAgentLoop, defineTool };
