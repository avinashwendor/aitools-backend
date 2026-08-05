/**
 * The acceptance check.
 *
 * The architect's `finish` gate already refuses a graph the validator rejects,
 * which stops it handing over something that cannot run. It cannot stop it
 * handing over something that runs and is not what was asked for — a workflow
 * that fetches the right data and emails it to nobody, or that was asked to run
 * every Friday and got a manual trigger, is structurally perfect and useless.
 * Nothing in the loop notices, because the model that built it is the same
 * model being asked whether it is done, twelve steps into wanting to be.
 *
 * So a second model reads the goal and the finished graph cold, with no
 * investment in the answer. It is a cheap model on purpose: this is reading
 * comprehension over a page of text, not reasoning about APIs, and paying
 * frontier prices to check the frontier model's homework would cost more than
 * the mistakes it catches.
 *
 * Two rules keep it from becoming a nuisance:
 *
 * • **It only reports what would make the user unhappy.** A reviewer invited to
 *   comment freely on someone else's design always finds something, and a gate
 *   that fires on style forces a rebuild of a workflow that was fine.
 *
 * • **It cannot block twice.** Its verdict is advice, and advice that can
 *   deadlock a build is worse than no advice: the user paid for the work either
 *   way, and a session that spins on an unsatisfiable objection ends with
 *   nothing at all. One refusal, then the build proceeds with the objection
 *   written into the summary where the user can judge it themselves.
 */

import { completeJson } from '../../ai/llm.js';
import { describeGraph } from '../operations.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('agentic:review');

/**
 * Does this graph do what was asked?
 *
 * @param {object} opts
 * @param {string} opts.goal      what the user asked for, in their words
 * @param {object} opts.graph     the finished graph
 * @param {string[]} opts.tested  ids of nodes that were actually executed
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ok: boolean, issues: string[]}>} `ok` on any failure to
 *   reach the model — an unavailable reviewer must never block a finished build.
 */
export async function reviewBuild({ goal, graph, tested = [], signal }) {
  try {
    const { data } = await completeJson({
      role: 'planner',
      task: 'agentic:architect:review',
      temperature: 0,
      maxTokens: 700,
      signal,
      messages: [
        {
          role: 'system',
          content:
            'You are reviewing an automation someone built for a user, before it is handed over. ' +
            'You did not build it. Judge only one thing: if the user pressed Run, would they get ' +
            'what they asked for?\n\n' +
            'Report a problem ONLY when it means the user does not get what they asked for:\n' +
            '- something the goal explicitly asks for that no step does\n' +
            '- the result is produced but never delivered anywhere the user can see it\n' +
            '- the trigger contradicts the goal (asked for a schedule, runs manually)\n' +
            '- a step is wired so it cannot receive what it needs\n' +
            // The two mistakes that look completely fine on a canvas and are
            // obvious the moment the thing actually runs.
            '- the goal says the work happens per item ("each", "every", a plural) but there is ' +
            'no For Each loop — one step handed a list of twenty produces one blurred result, ' +
            'not twenty\n' +
            '- it runs on a schedule and reads a list from somewhere, but has no Only New Items ' +
            'step — it will re-deliver the same items on every single run, forever\n\n' +
            'Do NOT report: style, node naming, ordering you would have done differently, ' +
            'missing error handling, credentials the user has not filled in yet (that is by ' +
            'design and happens after the build), or anything the summary already flags as ' +
            'unverified. A workflow that does the job in an unusual way is fine.\n\n' +
            'Most builds are correct. Returning an empty list is the expected outcome — say so ' +
            'rather than inventing something to justify the review.\n\n' +
            'Reply as JSON: {"ok": boolean, "issues": ["one sentence each, naming the step"]}',
        },
        {
          role: 'user',
          content:
            `WHAT THE USER ASKED FOR:\n${String(goal).slice(0, 3000)}\n\n` +
            `THE WORKFLOW AS BUILT:\n${JSON.stringify(describeGraph(graph), null, 2).slice(0, 12_000)}\n\n` +
            `STEPS THAT WERE ACTUALLY TEST-RUN AND WORKED: ${tested.length ? tested.join(', ') : 'none'}`,
        },
      ],
    });

    const issues = Array.isArray(data?.issues)
      ? data.issues.filter(issue => typeof issue === 'string' && issue.trim()).slice(0, 5)
      : [];

    // `ok` and a non-empty list is a contradiction the model produces often
    // enough to handle: the issues are the substance, so they decide.
    return { ok: issues.length === 0, issues };
  } catch (err) {
    log.warn('Acceptance review unavailable — passing the build', { error: err.message });
    return { ok: true, issues: [] };
  }
}

export default { reviewBuild };
