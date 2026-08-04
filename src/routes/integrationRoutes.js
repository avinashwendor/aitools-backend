import { Router } from 'express';
import { param } from 'express-validator';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  listIntegrations,
  startConnect,
  oauthCallback,
  disconnect,
  pushBoardToCalendar,
} from '../controllers/integrationController.js';

const router = Router();

/** OAuth callback — browser redirect, no JWT (state carries user id). */
router.get(
  '/:provider/callback',
  [param('provider').isIn(['google'])],
  validate,
  oauthCallback
);

router.use(authenticate);

router.get('/', listIntegrations);
router.get(
  '/:provider/connect',
  [param('provider').isIn(['google'])],
  validate,
  startConnect
);
router.delete(
  '/:provider',
  [param('provider').isIn(['google'])],
  validate,
  disconnect
);
router.post(
  '/google/push/:boardId',
  [param('boardId').isMongoId()],
  validate,
  pushBoardToCalendar
);

export default router;
