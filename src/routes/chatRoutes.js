/**
 * Chat / workflow routes. All require authentication.
 */

import { Router } from 'express';
import { body } from 'express-validator';
import {
  sendMessage,
  streamMessage,
  regenerateStage,
  getHistory,
  getSessions,
  clearHistory,
  getStatus,
} from '../controllers/chatController.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { rateLimit } from '../middleware/rateLimit.js';
import config from '../config/index.js';

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
];

/** AI calls cost money and time — cap them per user, not per IP. */
const aiLimiter = rateLimit({
  windowMs: config.ai.rateLimitWindowMs,
  max: config.ai.rateLimitMax,
  message: "You're sending requests faster than the assistant can think. Give it a few seconds.",
});

router.use(authenticate);

router.post('/', aiLimiter, messageValidation, validate, sendMessage);
router.post('/stream', aiLimiter, messageValidation, validate, streamMessage);

router.post(
  '/deep-dive',
  aiLimiter,
  [body('stageId').trim().notEmpty().withMessage('stageId is required')],
  validate,
  regenerateStage
);

router.get('/history', getHistory);
router.get('/sessions', getSessions);
router.delete('/history', clearHistory);

router.get('/status', requireAdmin, getStatus);

export default router;
