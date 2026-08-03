/**
 * Apply like/dislike signals to the user's long-term profile so future
 * workflows feel architected for them, not generic.
 */

import MessageFeedback from '../models/MessageFeedback.js';
import { updateProfileFacts } from './memory.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('ai:feedback');

/**
 * Best-effort recovery of which tool a free-text complaint is about.
 *
 * Only a fallback — the UI now asks directly (`rejectedToolSlugs`), because
 * matching prose was never reliable: "the video tool was overkill" names no
 * slug at all, and matching on the slug alone missed every complaint that used
 * the tool's actual display name.
 */
function inferRejectedTools(reasonText, workflow) {
  const text = String(reasonText).toLowerCase();
  if (!text.trim()) return [];

  return (workflow?.stages || [])
    .filter(stage => {
      const slug = String(stage.toolSlug || '');
      if (!slug) return false;
      const name = String(stage.tool?.name || '').toLowerCase();
      return (
        text.includes(slug.replace(/-/g, ' ')) ||
        text.includes(slug) ||
        (name.length > 2 && text.includes(name))
      );
    })
    .map(stage => stage.toolSlug);
}

export async function recordFeedback({
  userId,
  sessionId,
  rating,
  reason = '',
  intent = '',
  workflow = null,
  messageExcerpt = '',
  rejectedToolSlugs = [],
}) {
  const toolSlugs = workflow?.stages?.map(s => s.toolSlug).filter(Boolean) || [];

  await MessageFeedback.create({
    user: userId,
    sessionId,
    rating,
    reason: String(reason).slice(0, 500),
    intent,
    workflowId: workflow?.id || '',
    toolSlugs,
    messageExcerpt: String(messageExcerpt).slice(0, 400),
  });

  const facts = {};

  if (rating === 'like') {
    if (toolSlugs.length) {
      facts.preferredTools = toolSlugs;
    }
    if (workflow?.title) {
      facts.note = `Liked workflow style: "${workflow.title}" — ${workflow.summary || workflow.outcome || ''}`.slice(0, 240);
    } else if (messageExcerpt) {
      facts.note = `Liked assistant reply about: ${messageExcerpt.slice(0, 120)}`;
    }
  } else if (rating === 'dislike') {
    const reasonText = String(reason).trim();
    if (reasonText) {
      facts.note = `Avoid in future responses: ${reasonText}`.slice(0, 240);
    }

    // Prefer what the user explicitly picked; fall back to reading the prose.
    // Only slugs that were actually in this workflow are accepted, so a
    // crafted request can't poison the profile with arbitrary values.
    const inWorkflow = new Set(toolSlugs);
    const explicit = (Array.isArray(rejectedToolSlugs) ? rejectedToolSlugs : [])
      .map(String)
      .filter(slug => inWorkflow.has(slug));

    const rejected = explicit.length ? explicit : inferRejectedTools(reasonText, workflow);
    if (rejected.length) facts.rejectedTools = rejected;
  }

  if (Object.keys(facts).length) {
    await updateProfileFacts(userId, facts, 'inferred');
  }

  log.info('Feedback recorded', {
    userId,
    rating,
    intent,
    tools: toolSlugs.length,
    rejected: facts.rejectedTools?.length || 0,
  });
}

export default { recordFeedback };
