/**
 * Apply like/dislike signals to the user's long-term profile so future
 * workflows feel architected for them, not generic.
 */

import MessageFeedback from '../models/MessageFeedback.js';
import { updateProfileFacts } from './memory.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('ai:feedback');

export async function recordFeedback({
  userId,
  sessionId,
  rating,
  reason = '',
  intent = '',
  workflow = null,
  messageExcerpt = '',
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
    // If they name a tool in the reason, steer away from it next time.
    const rejected = toolSlugs.filter(slug =>
      reasonText.toLowerCase().includes(slug.replace(/-/g, ' '))
    );
    if (rejected.length) facts.rejectedTools = rejected;
  }

  if (Object.keys(facts).length) {
    await updateProfileFacts(userId, facts);
  }

  log.info('Feedback recorded', { userId, rating, intent, tools: toolSlugs.length });
}

export default { recordFeedback };
