import { Router } from 'express';
import { body, param, query } from 'express-validator';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  shareWorkflow,
  unshareWorkflow,
  getPublicWorkflow,
  getMyShare,
} from '../controllers/shareController.js';

const router = Router();

/** Public read — no auth. */
router.get(
  '/public/w/:slug',
  [param('slug').isString().isLength({ min: 3, max: 120 })],
  validate,
  getPublicWorkflow
);

router.get(
  '/workflow/share',
  authenticate,
  [query('sessionId').isString().isLength({ max: 120 })],
  validate,
  getMyShare
);

router.post(
  '/workflow/:sessionId/share',
  authenticate,
  [
    param('sessionId').isString().isLength({ max: 120 }),
    body('visibility').optional().isIn(['public', 'unlisted']),
  ],
  validate,
  shareWorkflow
);

router.delete(
  '/workflow/share/:slug',
  authenticate,
  [param('slug').isString().isLength({ min: 3, max: 120 })],
  validate,
  unshareWorkflow
);

export default router;
