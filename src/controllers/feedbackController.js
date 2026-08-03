import { recordFeedback } from '../ai/feedbackLearning.js';
import { loadConversation } from '../ai/memory.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('chat:feedback');

/**
 * POST /api/chat/feedback
 * Body: { sessionId, rating: 'like'|'dislike', reason?, messageExcerpt? }
 */
export const submitFeedback = async (req, res) => {
  try {
    const {
      sessionId = 'default', rating, reason = '', messageExcerpt = '', rejectedToolSlugs = [],
    } = req.body;
    const userId = req.user._id;

    if (!['like', 'dislike'].includes(rating)) {
      return res.status(400).json({ success: false, message: 'rating must be "like" or "dislike"' });
    }

    if (rating === 'dislike' && !String(reason).trim()) {
      return res.status(400).json({
        success: false,
        message: 'Please tell us what went wrong so we can improve next time.',
      });
    }

    const conversation = await loadConversation(userId, sessionId);

    await recordFeedback({
      userId,
      sessionId,
      rating,
      reason,
      intent: conversation.lastWorkflow ? 'workflow' : 'chat',
      workflow: conversation.lastWorkflow,
      messageExcerpt,
      rejectedToolSlugs,
    });

    res.json({ success: true, message: "Thanks — we'll use this to personalise your next workflow." });
  } catch (err) {
    log.error('Feedback failed', { error: err.message });
    res.status(500).json({ success: false, message: 'Could not save feedback.' });
  }
};

export default { submitFeedback };
