import { recordFeedback } from '../ai/feedbackLearning.js';
import { loadProfile } from '../ai/memory.js';
import { loadConversation } from '../ai/memory.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('chat:feedback');

/**
 * POST /api/chat/feedback
 * Body: { sessionId, rating: 'like'|'dislike', reason?, messageExcerpt? }
 */
export const submitFeedback = async (req, res) => {
  try {
    const { sessionId = 'default', rating, reason = '', messageExcerpt = '' } = req.body;
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
    });

    res.json({ success: true, message: "Thanks — we'll use this to personalise your next workflow." });
  } catch (err) {
    log.error('Feedback failed', { error: err.message });
    res.status(500).json({ success: false, message: 'Could not save feedback.' });
  }
};

/**
 * GET /api/chat/preferences
 * Returns the user's learned profile for the UI (external tools toggle, etc.)
 */
export const getPreferences = async (req, res) => {
  try {
    const profile = await loadProfile(req.user._id);
    res.json({
      success: true,
      data: {
        allowExternalTools: profile?.allowExternalTools ?? false,
        skillLevel: profile?.skillLevel || null,
        pricingPreference: profile?.pricingPreference || null,
        toolsAlreadyUsing: profile?.toolsAlreadyUsing || [],
        preferredTools: profile?.preferredTools || [],
        rejectedTools: profile?.rejectedTools || [],
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Could not load preferences.' });
  }
};

export default { submitFeedback, getPreferences };
