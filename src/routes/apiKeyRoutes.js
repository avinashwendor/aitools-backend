import { Router } from 'express';
import { body, param } from 'express-validator';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { withCurrentPeriod, requireFeature } from '../middleware/entitlements.js';
import { listApiKeys, createApiKey, revokeApiKey } from '../controllers/apiKeyController.js';

const router = Router();

router.use(authenticate);
router.use(withCurrentPeriod);
router.use(requireFeature('apiAccess'));

router.get('/', listApiKeys);
router.post(
  '/',
  [body('name').optional().isString().isLength({ max: 80 })],
  validate,
  createApiKey
);
router.delete(
  '/:id',
  [param('id').isMongoId()],
  validate,
  revokeApiKey
);

export default router;
