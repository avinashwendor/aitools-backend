/**
 * Chat / workflow controller.
 *
 * Thin transport layer over `ai/workflowEngine` — it owns HTTP concerns
 * (auth context, streaming, status codes, persistence of the turn) and nothing
 * about how a workflow is produced.
 *
 * Endpoints:
 *   POST   /api/chat            → JSON response
 *   POST   /api/chat/stream     → SSE with real pipeline progress
 *   POST   /api/chat/deep-dive  → regenerate one stage's playbook
 *   GET    /api/chat/history    → transcript for a session
 *   GET    /api/chat/sessions   → the user's recent sessions
 *   DELETE /api/chat/history    → forget a session
 */

import { handleMessage, deepDive, updateProfileFromTurn } from '../ai/workflowEngine.js';
import { syncStagePlaybook } from './taskController.js';
import {
  loadConversation,
  appendTurn,
  updateLastWorkflow,
  clearConversation,
  listConversations,
  updateProfileFacts,
  loadProfile,
} from '../ai/memory.js';
import { GuardrailError } from '../ai/guardrails.js';
import { LLMError, isLLMAvailable } from '../ai/llm.js';
import { getCatalog } from '../ai/catalog.js';
import { getStats } from '../ai/telemetry.js';
import { getCacheStats } from '../ai/cache.js';
import { withMetering } from '../billing/meterContext.js';
import { spend, recordFailure, balanceOf, allowanceOf, isUnmetered } from '../billing/credits.js';
import { creditCost, planAllows, FREE_ACTIONS, UNBILLED_ACTION } from '../billing/plans.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('chat');

/**
 * Decide what a completed turn should cost.
 *
 * The price can only be known after the fact: the router decides whether a
 * message is smalltalk, a question or a full workflow, and the cache decides
 * whether a workflow cost us eight model calls or none. Pricing on the
 * endpoint instead of the outcome would charge workflow rates for "thanks!"
 * and cache-miss rates for instant responses.
 *
 * Web search is billed as a surcharge on top, per call actually made, because
 * it's an independent paid API rather than part of the model spend.
 *
 * @returns {{action:string, cost:number, searchSurcharge:number}}
 */
function priceTurn(result, usage) {
  const intent = result?.intent;

  let action = 'chat.message';
  if (FREE_ACTIONS.has(intent)) action = null;
  else if (result?.workflow) {
    if (result.workflow.meta?.cached) action = 'workflow.cached';
    else action = intent === 'refine' ? 'workflow.refine' : 'workflow.generate';
  }

  const searchCalls = usage?.searchCalls || 0;
  const searchSurcharge = searchCalls * creditCost('search.web');

  // A free-intent turn that still triggered a paid search is charged for the
  // search alone — the surcharge is for the external API, not for the reply.
  if (!action) {
    return searchSurcharge
      ? { action: 'search.web', cost: searchSurcharge, searchSurcharge }
      // Still recorded, at zero credits. Intake turns burn two router calls
      // apiece; skipping the ledger row entirely would hide that spend from
      // the admin cost view and make the totals under-report by roughly the
      // cost of two model calls per workflow anyone ever generates.
      : { action: UNBILLED_ACTION, cost: 0, searchSurcharge: 0 };
  }

  return { action, cost: creditCost(action) + searchSurcharge, searchSurcharge };
}

/**
 * Charge for a delivered turn and return what the client should be told about
 * the user's remaining balance.
 *
 * Never throws: a billing write failing must not turn a successful workflow
 * into an error the user sees. Under-charging on a database blip is the
 * cheaper failure, and the ledger row that didn't get written is visible as a
 * gap in the admin view.
 */
async function chargeTurn({ user, result, usage, sessionId }) {
  const { action, cost, searchSurcharge } = priceTurn(result, usage);

  try {
    const outcome = await spend({
      user,
      action,
      cost,
      usage,
      sessionId,
      // Cost is settled after the work is done, so a user who could afford the
      // 1-credit minimum can land a 10-credit workflow. We deliver what they
      // already paid for in tokens and let the balance dip; the next request
      // is refused normally.
      allowOverdraft: true,
      meta: {
        intent: result?.intent,
        cached: Boolean(result?.workflow?.meta?.cached),
        stages: result?.workflow?.stages?.length,
        searchSurcharge: searchSurcharge || undefined,
      },
    });

    return {
      charged: outcome.charged,
      remaining: Math.max(0, outcome.balance),
      allowance: allowanceOf(user),
    };
  } catch (err) {
    log.error('Failed to charge for turn — delivering it anyway', {
      user: String(user._id),
      action,
      error: err.message,
    });
    return { charged: 0, remaining: Math.max(0, balanceOf(user)), allowance: allowanceOf(user) };
  }
}

/**
 * Resolve the "search beyond our catalog" opt-in, clamped by the plan.
 *
 * Clamped here rather than rejected at the route, because this is an optional
 * enhancement to a request the user is otherwise entitled to make. A 403 would
 * fail the whole message over a toggle they may have set months ago on a plan
 * they've since left; silently answering from the catalog is the right
 * degradation. The Settings screen is where the toggle explains itself.
 */
async function resolveAllowExternalTools(user, bodyValue) {
  if (!planAllows(user.subscription?.plan, 'webSearch') && !isUnmetered(user)) return false;
  if (typeof bodyValue === 'boolean') return bodyValue;
  const profile = await loadProfile(user._id).catch(() => null);
  return Boolean(profile?.allowExternalTools);
}

/** Maps engine/guardrail errors onto a client-safe HTTP response. */
function sendError(res, err, { streaming = false } = {}) {
  const isKnown = err instanceof GuardrailError || err instanceof LLMError;
  const status = isKnown ? err.status : 500;
  const message = isKnown
    ? err.userMessage || err.message
    : 'Something went wrong generating that. Please try again.';
  const code = isKnown ? err.code : 'INTERNAL';

  if (!isKnown) log.error('Unhandled chat error', { error: err.message, stack: err.stack });
  else log.warn('Chat request rejected', { code, status });

  if (streaming) {
    /**
     * A guardrail refusal (`status: 200`) is a considered assistant reply, not
     * a transport failure — and it has to look the same on both endpoints.
     *
     * Sent as `error` it surfaced in the studio as a red bar plus a generic
     * "I couldn't process that", so the one thing the refusal is for — telling
     * the user *why* and what to ask instead — never reached them. It also
     * never landed in the transcript, so the conversation showed the question
     * with no answer under it.
     */
    if (status === 200) {
      res.write(`event: result\ndata: ${JSON.stringify({
        message, workflow: null, intent: 'refused',
        clarifyingQuestions: null, readyToApprove: false,
      })}\n\n`);
      res.write(`event: done\ndata: ${JSON.stringify({ ok: true })}\n\n`);
      return res.end();
    }
    // Headers are already flushed on this route; the status line is only
    // settable if the failure beat `writeHead`.
    if (!res.headersSent) res.status(status);
    res.write(`event: error\ndata: ${JSON.stringify({ code, message, status })}\n\n`);
    return res.end();
  }

  // A guardrail refusal is a legitimate assistant reply, not a transport failure.
  if (status === 200) {
    return res.json({ success: true, data: { message, workflow: null, intent: 'refused' } });
  }

  return res.status(status).json({ success: false, code, message });
}

/** Persist the turn without ever failing the user's request over it. */
async function persistTurn(userId, sessionId, payload, { isFirstTurn = false } = {}) {
  const title =
    payload.title ||
    (isFirstTurn ? payload.userMessage?.trim().slice(0, 80) : undefined);

  try {
    await appendTurn(userId, sessionId, { ...payload, title });
  } catch (err) {
    log.warn('Failed to persist conversation turn', { error: err.message });
  }

  // Fire-and-forget: grows long-term memory, never blocks the response.
  updateProfileFromTurn({
    userId,
    userMessage: payload.userMessage,
    assistantMessage: payload.assistantMessage,
    intent: payload.intent,
  }).catch(() => {});

  // Note: generating a workflow deliberately does NOT create a task board.
  // Tracking every generated plan filled the dashboard with ideas nobody
  // committed to; a board is created only by an explicit "Add to tasks".
}

/**
 * A guardrail refusal is delivered as a normal assistant turn, so it has to be
 * written to the transcript like one.
 *
 * Without this the refusal only existed in the HTTP response: the client
 * rendered it, then the routine post-turn `invalidateQueries` refetched the
 * conversation from Mongo and it disappeared, leaving the user's question
 * sitting there unanswered. Worse, the next message would be planned against a
 * history in which the refusal never happened.
 *
 * Returns true when the error was a refusal and has been recorded.
 */
async function persistRefusalIfAny(err, { userId, sessionId, message, isFirstTurn }) {
  if (!(err instanceof GuardrailError) || err.status !== 200) return false;
  await persistTurn(userId, sessionId, {
    userMessage: message,
    assistantMessage: err.userMessage || err.message,
    intent: 'refused',
  }, { isFirstTurn }).catch(() => {});
  return true;
}

// ─────────────────────────────────────────────────────────────
// POST /api/chat
// ─────────────────────────────────────────────────────────────
export const sendMessage = async (req, res) => {
  const { message, sessionId = 'default', allowExternalTools, intakeAnswers, stageId } = req.body;
  const userId = req.user._id;
  let hadPriorMessages = true;

  try {
    // Everything inside this scope reports its token and search spend to the
    // same accumulator, however deep in the engine it happens.
    const { result, billing } = await withMetering(async usage => {
      const conversation = await loadConversation(userId, sessionId);
      hadPriorMessages = Boolean(conversation.messages?.length);
      const resolvedExternal = await resolveAllowExternalTools(req.user, allowExternalTools);
      if (typeof allowExternalTools === 'boolean') {
        updateProfileFacts(userId, { allowExternalTools }).catch(() => {});
      }

      let turn;
      try {
        turn = await handleMessage({
          message,
          conversation,
          userId,
          planId: req.user.subscription?.plan,
          allowExternalTools: resolvedExternal,
          intakeAnswers,
          stageId,
        });
      } catch (err) {
        // Failed work is free for the user but not for us — keep the spend visible.
        await recordFailure({
          user: req.user, action: 'chat.message', usage, sessionId, reason: err.code || err.message,
        }).catch(() => {});
        throw err;
      }

      const charged = await chargeTurn({ user: req.user, result: turn, usage, sessionId });

      const isFirstTurn = !hadPriorMessages;
      await persistTurn(userId, sessionId, {
        userMessage: message,
        assistantMessage: turn.message,
        toolSlugs: turn.toolSlugs || [],
        goal: turn.goal,
        brief: turn.brief,
        workflow: turn.workflow ?? undefined,
        workflowDiff: turn.workflowDiff ?? undefined,
        title: turn.title,
        intent: turn.intent,
      }, { isFirstTurn });

      return { result: turn, billing: charged };
    });

    res.json({
      success: true,
      data: {
        message: result.message,
        workflow: result.workflow,
        intent: result.intent,
        clarifyingQuestions: result.clarifyingQuestions || null,
        readyToApprove: result.readyToApprove || false,
        capturedPreferences: result.capturedPreferences || null,
        intakeBriefing: result.intakeBriefing || null,
        workflowDiff: result.workflowDiff || null,
        sessionId,
        // Lets the UI update the credit pill without a second round trip.
        billing,
      },
    });
  } catch (err) {
    await persistRefusalIfAny(err, {
      userId, sessionId, message, isFirstTurn: !hadPriorMessages,
    }).catch(() => {});
    sendError(res, err);
  }
};

// ─────────────────────────────────────────────────────────────
// POST /api/chat/stream — Server-Sent Events
// ─────────────────────────────────────────────────────────────
export const streamMessage = async (req, res) => {
  const { message, sessionId = 'default', allowExternalTools, intakeAnswers, stageId } = req.body;
  const userId = req.user._id;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Stops nginx from buffering the stream into uselessness.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const send = (event, data) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Keep intermediaries from dropping a slow connection.
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, 15000);

  let aborted = false;
  req.on('close', () => { aborted = true; clearInterval(heartbeat); });

  // Hoisted so the catch below can tell a first turn from a later one when it
  // records a refusal — the conversation itself is loaded inside the metering
  // scope, but "was this session empty" is needed on the failure path too.
  let hadPriorMessages = true;

  try {
    await withMetering(async usage => {
      const conversation = await loadConversation(userId, sessionId);
      hadPriorMessages = Boolean(conversation.messages?.length);
      const resolvedExternal = await resolveAllowExternalTools(req.user, allowExternalTools);
      if (typeof allowExternalTools === 'boolean') {
        updateProfileFacts(userId, { allowExternalTools }).catch(() => {});
      }

      let result;
      try {
        result = await handleMessage({
          message,
          conversation,
          userId,
          planId: req.user.subscription?.plan,
          allowExternalTools: resolvedExternal,
          intakeAnswers,
          stageId,
          // Progress events carrying real workflow data go out as `partial` so a
          // status-label consumer can never mistake a payload for a message.
          onProgress: event => {
            const { workflow, stage, ...status } = event;
            send('progress', status);
            if (workflow || stage) send('partial', { workflow, stage, stageId: event.stageId });
          },
        });
      } catch (err) {
        await recordFailure({
          user: req.user, action: 'chat.message', usage, sessionId, reason: err.code || err.message,
        }).catch(() => {});
        throw err;
      }

      // A client that hung up still cost us the full pipeline, so charge for
      // it — otherwise cancelling mid-generation is a free workflow, and the
      // work is already done by the time we get here.
      const billing = await chargeTurn({ user: req.user, result, usage, sessionId });

      const isFirstTurn = !hadPriorMessages;

      /**
       * Persist BEFORE deciding what to tell the socket, and unconditionally.
       *
       * This used to sit after an `if (aborted) return`, which meant closing
       * the tab (or pressing Stop) during the ~60s build charged the user for
       * a workflow that was then thrown away: the pipeline had already run,
       * the credits were already spent, and the only copy of the result was
       * the one we dropped on the floor. Whether the browser is still
       * listening has nothing to do with whether the work happened.
       */
      await persistTurn(userId, sessionId, {
        userMessage: message,
        assistantMessage: result.message,
        toolSlugs: result.toolSlugs || [],
        goal: result.goal,
        brief: result.brief,
        workflow: result.workflow ?? undefined,
        workflowDiff: result.workflowDiff ?? undefined,
        title: result.title,
        intent: result.intent,
      }, { isFirstTurn });

      if (aborted) {
        clearInterval(heartbeat);
        return;
      }

      send('result', {
        message: result.message,
        workflow: result.workflow,
        intent: result.intent,
        clarifyingQuestions: result.clarifyingQuestions || null,
        readyToApprove: result.readyToApprove || false,
        capturedPreferences: result.capturedPreferences || null,
        intakeBriefing: result.intakeBriefing || null,
        workflowDiff: result.workflowDiff || null,
        sessionId,
        billing,
      });
      send('done', { ok: true });
      clearInterval(heartbeat);
      res.end();
    });
  } catch (err) {
    clearInterval(heartbeat);
    await persistRefusalIfAny(err, {
      userId, sessionId, message, isFirstTurn: !hadPriorMessages,
    }).catch(() => {});
    if (!aborted) sendError(res, err, { streaming: true });
    else if (!res.writableEnded) res.end();
  }
};

// ─────────────────────────────────────────────────────────────
// POST /api/chat/deep-dive
// ─────────────────────────────────────────────────────────────
export const regenerateStage = async (req, res) => {
  const { sessionId = 'default', stageId } = req.body;

  try {
    const conversation = await loadConversation(req.user._id, sessionId);
    const workflow = conversation.lastWorkflow;

    if (!workflow) {
      return res.status(404).json({
        success: false,
        code: 'NO_WORKFLOW',
        message: 'No workflow found for this session.',
      });
    }

    const playbook = await withMetering(async usage => {
      let generated;
      try {
        generated = await deepDive({ goal: conversation.goal, workflow, stageId });
      } catch (err) {
        await recordFailure({
          user: req.user, action: 'workflow.deepdive', usage, sessionId,
          reason: err.code || err.message,
        }).catch(() => {});
        throw err;
      }

      await spend({
        user: req.user,
        action: 'workflow.deepdive',
        usage,
        sessionId,
        allowOverdraft: true,
        meta: { stageId },
      }).catch(err => log.warn('Deep-dive charge failed', { error: err.message }));

      return generated;
    });

    // `deepDive` accepts either a stage id or a tool slug; resolve to the real
    // id before writing, so both the workflow and the board update the same row.
    const target = workflow.stages.find(s => s.id === stageId || s.toolSlug === stageId);
    const resolvedStageId = target?.id || stageId;

    // Persist the rewritten steps. Without this the server keeps serving the
    // old playbook, so a page reload silently undid the rewrite the user just
    // asked for.
    const updatedStages = workflow.stages.map(s =>
      s.id === resolvedStageId ? { ...s, ...playbook } : s
    );
    await updateLastWorkflow(req.user._id, sessionId, { ...workflow, stages: updatedStages })
      .catch(err => log.warn('Failed to persist regenerated stage', { error: err.message }));

    // Fire-and-forget: keeps any task board built from this workflow in step.
    syncStagePlaybook({
      userId: req.user._id,
      sessionId,
      stageId: resolvedStageId,
      steps: playbook.steps,
    }).catch(() => {});

    res.json({ success: true, data: { stageId: resolvedStageId, ...playbook } });
  } catch (err) {
    sendError(res, err);
  }
};

// ─────────────────────────────────────────────────────────────
// POST /api/chat/stage-highlight
// ─────────────────────────────────────────────────────────────
/**
 * Pins a selected span to a stage so "what is X" doesn't just answer once
 * and vanish — the span itself gets marked in the playbook (see
 * StepDetailModal's `<HighlightedText>`), permanently, across reloads and
 * re-opens, with the question that was asked about it kept alongside.
 *
 * Deliberately not routed through `handleMessage`/`patchWorkflow`: this is
 * metadata about content that already exists, not a request to change the
 * workflow, so it skips the LLM (and its credit charge) entirely — the same
 * reasoning `updateLastWorkflow` documents for a stage-playbook rewrite that
 * isn't a conversational turn either.
 */
export const saveStageHighlight = async (req, res) => {
  const { sessionId = 'default', stageId, text, question } = req.body;

  try {
    const conversation = await loadConversation(req.user._id, sessionId);
    const workflow = conversation.lastWorkflow;
    const stage = workflow?.stages?.find(s => s.id === stageId);

    if (!stage) {
      return res.status(404).json({
        success: false,
        code: 'NO_STAGE',
        message: 'That stage is no longer part of this workflow.',
      });
    }

    const highlight = {
      id: `hl_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      text: String(text).slice(0, 400),
      question: String(question || '').slice(0, 500),
      createdAt: new Date().toISOString(),
    };

    // Capped rather than unbounded — a stage someone keeps interrogating
    // should still read as a playbook, not accrue an infinite margin of notes.
    const highlights = [...(stage.highlights || []), highlight].slice(-40);

    const updatedStages = workflow.stages.map(s =>
      s.id === stageId ? { ...s, highlights } : s
    );
    await updateLastWorkflow(req.user._id, sessionId, { ...workflow, stages: updatedStages });

    res.json({ success: true, data: { stageId, highlight } });
  } catch (err) {
    sendError(res, err);
  }
};

// ─────────────────────────────────────────────────────────────
// History
// ─────────────────────────────────────────────────────────────
export const getHistory = async (req, res) => {
  try {
    const conversation = await loadConversation(req.user._id, req.query.sessionId || 'default');

    const clarify = conversation.clarificationState;

    /**
     * The diff from the most recent turn that produced one.
     *
     * `patchWorkflow` records exactly which stages a refine changed, which it
     * preserved and which tools it swapped — and the studio shows that as the
     * "what changed" summary after a refine. Without replaying it here the
     * summary survived only until the page reloaded, so anyone who refined,
     * got interrupted and came back had a silently rewritten plan and no way
     * to see what had moved.
     *
     * Read from the tail backwards: only the newest diff describes the
     * workflow currently on the canvas.
     */
    const messages = conversation.messages || [];
    let lastWorkflowDiff = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role !== 'assistant') continue;
      if (messages[i].workflowDiff) lastWorkflowDiff = messages[i].workflowDiff;
      // The newest assistant turn decides: if it produced a workflow without a
      // diff (a fresh generation), there is nothing to report as "changed".
      if (messages[i].workflow || messages[i].workflowDiff) break;
    }

    res.json({
      success: true,
      data: {
        messages: messages.map(m => ({
          role: m.role,
          content: m.content,
          createdAt: m.createdAt,
        })),
        workflow: conversation.lastWorkflow || null,
        workflowDiff: lastWorkflowDiff,
        goal: conversation.goal || '',
        title: conversation.title || '',
        clarifyingQuestions:
          clarify?.phase === 'asking' ? clarify.questions || [] : null,
        readyToApprove: clarify?.phase === 'awaiting_approval',
        capturedPreferences:
          clarify?.phase === 'awaiting_approval' ? clarify.answers || null : null,
        intakeBriefing:
          clarify?.phase === 'asking' || clarify?.phase === 'awaiting_approval'
            ? {
                alreadyKnow: clarify.alreadyKnow || [],
                stillNeed: clarify.stillNeed || [],
              }
            : null,
      },
    });
  } catch (err) {
    sendError(res, err);
  }
};

export const getSessions = async (req, res) => {
  try {
    const sessions = await listConversations(req.user._id);
    res.json({ success: true, data: { sessions } });
  } catch (err) {
    sendError(res, err);
  }
};

export const clearHistory = async (req, res) => {
  try {
    await clearConversation(req.user._id, req.body.sessionId || 'default');
    res.json({ success: true, message: 'Conversation cleared' });
  } catch (err) {
    sendError(res, err);
  }
};

// ─────────────────────────────────────────────────────────────
// GET /api/chat/export — n8n JSON or markdown (feature-gated)
// ─────────────────────────────────────────────────────────────
export const exportWorkflow = async (req, res) => {
  try {
    const sessionId = req.query.sessionId || 'default';
    const format = String(req.query.format || 'n8n').toLowerCase();

    const validFormats = ['n8n', 'markdown', 'md', 'make', 'mermaid', 'script', 'js'];
    if (!validFormats.includes(format)) {
      return res.status(400).json({
        success: false,
        message: `format must be one of: ${validFormats.join(', ')}`,
      });
    }

    const conversation = await loadConversation(req.user._id, sessionId);
    const workflow = conversation.lastWorkflow;

    if (!workflow?.stages?.length) {
      return res.status(404).json({
        success: false,
        message: 'No workflow to export in this session',
      });
    }

    const source = {
      workflowId: workflow.id || null,
      title: workflow.title || '',
      sessionId,
    };

    const { exportWorkflow: doExport } = await import('../ai/exporters/index.js');
    const result = doExport(workflow, format);

    return res.json({
      success: true,
      data: {
        format,
        filename: result.filename,
        content: result.content,
        mimeType: result.mimeType,
        // Legacy compatibility fields
        workflow: format === 'n8n' ? JSON.parse(result.content) : undefined,
        markdown: ['markdown', 'md'].includes(format) ? result.content : undefined,
        source,
      },
    });
  } catch (err) {
    sendError(res, err);
  }
};

// ─────────────────────────────────────────────────────────────
// GET /api/chat/status — operational visibility
// ─────────────────────────────────────────────────────────────
export const getStatus = async (req, res) => {
  try {
    const [catalog, cacheStats, llmStats] = await Promise.all([
      getCatalog(),
      getCacheStats(),
      getStats(),
    ]);
    res.json({
      success: true,
      data: {
        aiEnabled: isLLMAvailable(),
        catalog: {
          tools: catalog.tools.length,
          categories: catalog.categories.length,
          indexedTerms: catalog.index?.size ?? 0,
          loadedAt: new Date(catalog.loadedAt).toISOString(),
        },
        cache: cacheStats,
        llm: llmStats,
      },
    });
  } catch (err) {
    sendError(res, err);
  }
};
