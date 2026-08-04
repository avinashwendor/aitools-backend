/**
 * MCP tool implementations — thin adapters over retriever, workflowEngine,
 * and task boards. Callers (HTTP MCP transport) must attach `user` and run
 * metering around plan_workflow.
 */

import { retrieve } from '../ai/retriever.js';
import { handleMessage } from '../ai/workflowEngine.js';
import { loadConversation, appendTurn, updateLastWorkflow } from '../ai/memory.js';
import { withMetering } from '../billing/meterContext.js';
import { spend, recordFailure } from '../billing/credits.js';
import { creditCost, FREE_ACTIONS, UNBILLED_ACTION } from '../billing/plans.js';
import TaskBoard from '../models/TaskBoard.js';
import { commitWorkflowToBoard } from '../tasks/commitBoard.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('mcp:tools');

function textResult(payload) {
  return {
    content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }],
  };
}

function errorResult(message) {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

export async function searchTools({ query, limit = 8, pricing = 'any' }) {
  const { candidates, cards } = await retrieve({
    queries: [query],
    pricing,
    limit: Math.min(Number(limit) || 8, 24),
  });
  return textResult({
    count: candidates.length,
    tools: cards.length
      ? cards
      : candidates.map(t => ({
          slug: t.slug,
          name: t.name,
          tagline: t.tagline,
          pricing: t.pricing,
          category: t.category,
          websiteUrl: t.websiteUrl,
        })),
  });
}

export async function compareTools({ slugs = [], query }) {
  let tools = [];
  if (Array.isArray(slugs) && slugs.length) {
    const { candidates } = await retrieve({
      queries: [query || slugs.join(' ')],
      limit: 32,
    });
    const wanted = new Set(slugs.map(s => String(s).toLowerCase()));
    tools = candidates.filter(t => wanted.has(t.slug));
    // Fill gaps by slug from the retrieve slate if missing
    if (tools.length < slugs.length) {
      const { getCatalog } = await import('../ai/catalog.js');
      const catalog = await getCatalog();
      for (const slug of slugs) {
        if (tools.some(t => t.slug === slug)) continue;
        const hit = catalog.tools.find(t => t.slug === slug);
        if (hit) tools.push(hit);
      }
    }
  } else if (query) {
    const { candidates } = await retrieve({ queries: [query], limit: 6 });
    tools = candidates;
  }

  return textResult({
    tools: tools.map(t => ({
      slug: t.slug,
      name: t.name,
      tagline: t.tagline,
      pricing: t.pricing,
      features: t.features?.slice?.(0, 8) || t.features,
      websiteUrl: t.websiteUrl,
      rating: t.rating,
    })),
  });
}

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

  if (!action) {
    return searchSurcharge
      ? { action: 'search.web', cost: searchSurcharge }
      : { action: UNBILLED_ACTION, cost: 0 };
  }

  return { action, cost: creditCost(action) + searchSurcharge };
}

export async function planWorkflow({ user, message, sessionId = 'mcp-default' }) {
  if (!message?.trim()) return errorResult('message is required');

  try {
    const conversation = await loadConversation(user._id, sessionId);

    const result = await withMetering(async usage => {
      const out = await handleMessage({
        message: message.trim(),
        conversation,
        userId: user._id,
      });

      const { action, cost } = priceTurn(out, usage);
      try {
        await spend({
          user,
          action,
          cost,
          usage,
          sessionId,
          meta: { surface: 'mcp' },
        });
      } catch (err) {
        log.warn('MCP spend failed', { error: err.message });
      }

      return out;
    });

    if (result?.message) {
      await appendTurn(user._id, sessionId, {
        userMessage: message.trim(),
        assistantMessage: result.message,
      }).catch(() => {});
    }
    if (result?.workflow) {
      await updateLastWorkflow(user._id, sessionId, result.workflow).catch(() => {});
    }

    return textResult({
      sessionId,
      intent: result.intent,
      message: result.message,
      workflow: result.workflow
        ? {
            id: result.workflow.id,
            title: result.workflow.title,
            outcome: result.workflow.outcome,
            stages: (result.workflow.stages || []).map(s => ({
              id: s.id,
              title: s.title,
              toolSlug: s.toolSlug,
              toolName: s.tool?.name,
              timeMinutes: s.timeMinutes,
              steps: s.steps,
            })),
          }
        : null,
      clarifyingQuestions: result.clarifyingQuestions || null,
    });
  } catch (err) {
    await recordFailure({ user, action: 'workflow.generate', error: err }).catch(() => {});
    return errorResult(err.message || 'plan_workflow failed');
  }
}

export async function getPlaybook({ user, sessionId = 'mcp-default', stageId }) {
  const conversation = await loadConversation(user._id, sessionId);
  const workflow = conversation.lastWorkflow;
  if (!workflow?.stages?.length) return errorResult('No workflow in that session');

  const stage = stageId
    ? workflow.stages.find(s => s.id === stageId || s.toolSlug === stageId)
    : workflow.stages[0];

  if (!stage) return errorResult(`Stage not found: ${stageId}`);

  return textResult({
    stageId: stage.id,
    title: stage.title,
    toolSlug: stage.toolSlug,
    steps: stage.steps,
    prompt: stage.prompt,
    settings: stage.settings,
    pitfall: stage.pitfall,
    checkpoint: stage.checkpoint,
  });
}

export async function createTaskBoard({ user, sessionId = 'mcp-default', weeklyHours, targetDate }) {
  try {
    const { board, created } = await commitWorkflowToBoard({
      user,
      sessionId,
      weeklyHours,
      targetDate,
    });
    return textResult({
      created,
      board: board.summary(),
    });
  } catch (err) {
    return errorResult(err.message || 'create_task_board failed');
  }
}

export async function getBoardStatus({ user, boardId }) {
  if (!boardId) return errorResult('boardId is required');
  const board = await TaskBoard.findOne({ _id: boardId, user: user._id });
  if (!board) return errorResult('Board not found');
  return textResult(board.summary());
}
