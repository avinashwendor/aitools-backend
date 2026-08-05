/**
 * Chat / workflow routes. All require authentication.
 */

import { Router } from 'express';
import { body } from 'express-validator';
import {
  sendMessage,
  streamMessage,
  regenerateStage,
  saveStageHighlight,
  getHistory,
  getSessions,
  clearHistory,
  exportWorkflow,
  getStatus,
} from '../controllers/chatController.js';
import { submitFeedback } from '../controllers/feedbackController.js';
import {
  getPreferences,
  updatePreferences,
  resetPreferences,
} from '../controllers/preferencesController.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  withCurrentPeriod,
  requireCredits,
  requireFeature,
  planRateLimit,
} from '../middleware/entitlements.js';

const router = Router();

const messageValidation = [
  body('message')
    .trim()
    .notEmpty().withMessage('Message is required')
    .isLength({ max: 2000 }).withMessage('Message cannot exceed 2000 characters'),
  body('sessionId')
    .optional()
    .isString().withMessage('Session ID must be a string')
    .isLength({ max: 120 }).withMessage('Session ID is too long'),
  // Structured answers to the intake questions, keyed by question id. Read
  // directly rather than re-inferred from the prose the user sees.
  body('intakeAnswers')
    .optional({ nullable: true })
    .isObject().withMessage('intakeAnswers must be an object')
    .custom(value => Object.keys(value).length <= 10)
    .withMessage('Too many intake answers'),
  // The workflow stage a question is anchored to — set when the user asked
  // about a specific node instead of typing a bare chat message.
  body('stageId')
    .optional({ nullable: true })
    .isString().withMessage('stageId must be a string')
    .isLength({ max: 80 }).withMessage('stageId is too long'),
];

/**
 * AI calls cost money and time — cap them per user, not per IP, at the rate
 * their plan pays for.
 */
const aiLimiter = planRateLimit();

router.use(authenticate);
// Every route below reads or spends the allowance, so the period has to be
// current before any of them run — including the read-only ones.
router.use(withCurrentPeriod);

/**
 * A chat turn's real price isn't known until the router has classified the
 * message, so the gate only checks the account isn't empty; the controller
 * charges the true amount once the work is done.
 */
router.post(
  '/',
  aiLimiter,
  requireCredits('chat.message', { estimate: 'minimum' }),
  messageValidation,
  validate,
  sendMessage
);
router.post(
  '/stream',
  aiLimiter,
  requireCredits('chat.message', { estimate: 'minimum' }),
  messageValidation,
  validate,
  streamMessage
);

router.post(
  '/deep-dive',
  aiLimiter,
  requireCredits('workflow.deepdive'),
  [body('stageId').trim().notEmpty().withMessage('stageId is required')],
  validate,
  regenerateStage
);

// No AI call and nothing metered — this pins an already-generated span to
// the stage, it doesn't ask the model for anything new.
router.post(
  '/stage-highlight',
  [
    body('stageId').trim().notEmpty().withMessage('stageId is required'),
    body('text').trim().notEmpty().isLength({ max: 400 }).withMessage('text is required'),
    body('question').optional().isString().isLength({ max: 500 }),
    body('sessionId').optional().isString().isLength({ max: 120 }),
  ],
  validate,
  saveStageHighlight
);

router.get('/history', getHistory);
router.get('/sessions', getSessions);
router.get('/export', requireFeature('exportWorkflow'), exportWorkflow);
router.get('/preferences', getPreferences);
router.put(
  '/preferences',
  [
    body('skillLevel').optional({ nullable: true }).isIn(['beginner', 'intermediate', 'advanced']),
    body('pricingPreference').optional({ nullable: true }).isIn(['free', 'paid', 'any']),
    body('industry').optional({ nullable: true }).isString().isLength({ max: 80 }),
    body('allowExternalTools').optional().isBoolean(),
    body('dismissOnboarding').optional().isBoolean(),
    // Lists arrive whole — removing an entry means sending what's left.
    body(['toolsAlreadyUsing', 'preferredTools', 'rejectedTools', 'notes'])
      .optional()
      .isArray({ max: 30 }),
  ],
  validate,
  updatePreferences
);
router.delete('/preferences', resetPreferences);

router.delete('/history', clearHistory);

router.post(
  '/feedback',
  [
    body('rating').isIn(['like', 'dislike']).withMessage('rating must be like or dislike'),
    body('reason').optional().isString().isLength({ max: 500 }),
    body('sessionId').optional().isString().isLength({ max: 120 }),
    // Which stage tools didn't fit — asked directly, because matching slugs
    // against free-text prose missed most complaints.
    body('rejectedToolSlugs').optional({ nullable: true }).isArray({ max: 8 }),
    body('rejectedToolSlugs.*').isString().isLength({ max: 80 }),
  ],
  validate,
  submitFeedback
);

router.get('/status', requireAdmin, getStatus);

export default router;
