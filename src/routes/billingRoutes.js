/**
 * Billing routes for the account holder.
 *
 * `/plans` is public — the pricing page has to render for logged-out visitors,
 * and it's the same catalog the enforcement layer reads. Everything else needs
 * a session, and runs behind `withCurrentPeriod` so a dormant account's
 * allowance is rolled forward before any number is reported.
 */

import { Router } from 'express';
import { body } from 'express-validator';
import {
  getPlans,
  getMyBilling,
  getActivity,
  getHistory,
  requestUpgrade,
  cancelUpgradeRequest,
  getEntitlements,
  updateOnDemand,
} from '../controllers/billingController.js';
import { authenticate } from '../middleware/auth.js';
import { withCurrentPeriod } from '../middleware/entitlements.js';
import { validate } from '../middleware/validate.js';
import { rateLimit } from '../middleware/rateLimit.js';

const router = Router();

// Public.
router.get('/plans', getPlans);

// Authenticated.
router.use(authenticate);
router.use(withCurrentPeriod);

router.get('/me', getMyBilling);
router.get('/entitlements', getEntitlements);
router.get('/activity', getActivity);
router.get('/history', getHistory);

router.put(
  '/on-demand',
  [
    body('enabled').isBoolean().withMessage('Say whether on-demand is on or off.'),
    // Capped at a number rather than left open: the field exists to *limit*
    // exposure, and a typo that turns 2,000 into 200,000 should be rejected by
    // the form, not discovered on a statement.
    body('capCredits').optional().isInt({ min: 0, max: 1_000_000 }),
  ],
  validate,
  updateOnDemand
);

router.post(
  '/upgrade',
  // Upgrade requests land in a human queue, so the ceiling is about keeping
  // that queue readable rather than protecting any expensive resource.
  rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    message: 'You have already sent us a few requests — we will be in touch shortly.',
  }),
  [
    body('plan').isString().notEmpty().withMessage('Pick a plan.'),
    body('billingCycle').optional().isIn(['monthly', 'yearly']),
    body('note').optional().isString().isLength({ max: 1000 }),
    body('company').optional().isString().isLength({ max: 120 }),
    body('trigger').optional().isString(),
  ],
  validate,
  requestUpgrade
);

router.delete('/upgrade', cancelUpgradeRequest);

export default router;
