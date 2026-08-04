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
    if (!res.headersSent) res.status(status);
    res.write(`event: error\ndata: ${JSON.stringify({ code, message })}\n\n`);
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

// ─────────────────────────────────────────────────────────────
// POST /api/chat
// ─────────────────────────────────────────────────────────────
export const sendMessage = async (req, res) => {
  const { message, sessionId = 'default', allowExternalTools, intakeAnswers } = req.body;
  const userId = req.user._id;

  try {
    // Everything inside this scope reports its token and search spend to the
    // same accumulator, however deep in the engine it happens.
    const { result, billing } = await withMetering(async usage => {
      const conversation = await loadConversation(userId, sessionId);
      const resolvedExternal = await resolveAllowExternalTools(req.user, allowExternalTools);
      if (typeof allowExternalTools === 'boolean') {
        updateProfileFacts(userId, { allowExternalTools }).catch(() => {});
      }

      let turn;
      try {
        turn = await handleMessage({
          message, conversation, userId, allowExternalTools: resolvedExternal, intakeAnswers,
        });
      } catch (err) {
        // Failed work is free for the user but not for us — keep the spend visible.
        await recordFailure({
          user: req.user, action: 'chat.message', usage, sessionId, reason: err.code || err.message,
        }).catch(() => {});
        throw err;
      }

      const charged = await chargeTurn({ user: req.user, result: turn, usage, sessionId });

      const isFirstTurn = !(conversation.messages?.length);
      await persistTurn(userId, sessionId, {
        userMessage: message,
        assistantMessage: turn.message,
        toolSlugs: turn.toolSlugs || [],
        goal: turn.goal,
        workflow: turn.workflow ?? undefined,
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
        workflowDiff: result.workflowDiff || null,
        sessionId,
        // Lets the UI update the credit pill without a second round trip.
        billing,
      },
    });
  } catch (err) {
    sendError(res, err);
  }
};

// ─────────────────────────────────────────────────────────────
// POST /api/chat/stream — Server-Sent Events
// ─────────────────────────────────────────────────────────────
export const streamMessage = async (req, res) => {
  const { message, sessionId = 'default', allowExternalTools, intakeAnswers } = req.body;
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

  try {
    await withMetering(async usage => {
      const conversation = await loadConversation(userId, sessionId);
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
          allowExternalTools: resolvedExternal,
          intakeAnswers,
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

      if (aborted) return;

      send('result', {
        message: result.message,
        workflow: result.workflow,
        intent: result.intent,
        clarifyingQuestions: result.clarifyingQuestions || null,
        readyToApprove: result.readyToApprove || false,
        capturedPreferences: result.capturedPreferences || null,
        workflowDiff: result.workflowDiff || null,
        sessionId,
        billing,
      });
      send('done', { ok: true });
      clearInterval(heartbeat);
      res.end();

      const isFirstTurn = !(conversation.messages?.length);

      await persistTurn(userId, sessionId, {
        userMessage: message,
        assistantMessage: result.message,
        toolSlugs: result.toolSlugs || [],
        goal: result.goal,
        workflow: result.workflow ?? undefined,
        title: result.title,
        intent: result.intent,
      }, { isFirstTurn });
    });
  } catch (err) {
    clearInterval(heartbeat);
    if (!aborted) sendError(res, err, { streaming: true });
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
// History
// ─────────────────────────────────────────────────────────────
export const getHistory = async (req, res) => {
  try {
    const conversation = await loadConversation(req.user._id, req.query.sessionId || 'default');

    const clarify = conversation.clarificationState;

    res.json({
      success: true,
      data: {
        messages: (conversation.messages || []).map(m => ({
          role: m.role,
          content: m.content,
          createdAt: m.createdAt,
        })),
        workflow: conversation.lastWorkflow || null,
        goal: conversation.goal || '',
        title: conversation.title || '',
        clarifyingQuestions:
          clarify?.phase === 'asking' ? clarify.questions || [] : null,
        readyToApprove: clarify?.phase === 'awaiting_approval',
        capturedPreferences:
          clarify?.phase === 'awaiting_approval' ? clarify.answers || null : null,
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
