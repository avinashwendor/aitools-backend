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
import { upsertWorkflowRun } from './workflowController.js';
import {
  loadConversation,
  appendTurn,
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
import { createLogger } from '../utils/logger.js';

const log = createLogger('chat');

async function resolveAllowExternalTools(userId, bodyValue) {
  if (typeof bodyValue === 'boolean') return bodyValue;
  const profile = await loadProfile(userId).catch(() => null);
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
async function persistTurn(userId, sessionId, payload) {
  try {
    await appendTurn(userId, sessionId, payload);
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

  // Fire-and-forget: keeps server-persisted task tracking in step with the latest workflow.
  if (payload.workflow) {
    upsertWorkflowRun({ userId, sessionId, workflow: payload.workflow }).catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────
// POST /api/chat
// ─────────────────────────────────────────────────────────────
export const sendMessage = async (req, res) => {
  const { message, sessionId = 'default', allowExternalTools } = req.body;
  const userId = req.user._id;

  try {
    const conversation = await loadConversation(userId, sessionId);
    const resolvedExternal = await resolveAllowExternalTools(userId, allowExternalTools);
    if (typeof allowExternalTools === 'boolean') {
      updateProfileFacts(userId, { allowExternalTools }).catch(() => {});
    }

    const result = await handleMessage({ message, conversation, userId, allowExternalTools: resolvedExternal });

    await persistTurn(userId, sessionId, {
      userMessage: message,
      assistantMessage: result.message,
      toolSlugs: result.toolSlugs || [],
      goal: result.goal,
      workflow: result.workflow ?? undefined,
      title: result.title,
      intent: result.intent,
    });

    res.json({
      success: true,
      data: {
        message: result.message,
        workflow: result.workflow,
        intent: result.intent,
        clarifyingQuestions: result.clarifyingQuestions || null,
        readyToApprove: result.readyToApprove || false,
        workflowDiff: result.workflowDiff || null,
        sessionId,
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
  const { message, sessionId = 'default', allowExternalTools } = req.body;
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
    const conversation = await loadConversation(userId, sessionId);
    const resolvedExternal = await resolveAllowExternalTools(userId, allowExternalTools);
    if (typeof allowExternalTools === 'boolean') {
      updateProfileFacts(userId, { allowExternalTools }).catch(() => {});
    }

    const result = await handleMessage({
      message,
      conversation,
      userId,
      allowExternalTools: resolvedExternal,
      onProgress: event => send('progress', event),
    });

    if (aborted) return;

    send('result', {
      message: result.message,
      workflow: result.workflow,
      intent: result.intent,
      clarifyingQuestions: result.clarifyingQuestions || null,
      readyToApprove: result.readyToApprove || false,
      workflowDiff: result.workflowDiff || null,
      sessionId,
    });
    send('done', { ok: true });
    clearInterval(heartbeat);
    res.end();

    await persistTurn(userId, sessionId, {
      userMessage: message,
      assistantMessage: result.message,
      toolSlugs: result.toolSlugs || [],
      goal: result.goal,
      workflow: result.workflow ?? undefined,
      title: result.title,
      intent: result.intent,
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

    const playbook = await deepDive({ goal: conversation.goal, workflow, stageId });

    res.json({ success: true, data: { stageId, ...playbook } });
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
