/**
 * Authenticate via `Authorization: Bearer ait_…` API key.
 *
 * Requires the user's plan to include `apiAccess`. Attaches `req.user` and
 * `req.apiKey` the same way JWT auth attaches a user, so metering middleware
 * can run unchanged downstream.
 */

import ApiKey, { hashApiKey } from '../models/ApiKey.js';
import { User } from '../models/index.js';
import { planAllows } from '../billing/plans.js';
import { isUnmetered } from '../billing/credits.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('apiKeyAuth');

export async function authenticateApiKey(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'Access denied. API key required.',
      });
    }

    const raw = authHeader.slice('Bearer '.length).trim();
    if (!raw.startsWith('ait_')) {
      return res.status(401).json({
        success: false,
        message: 'Invalid API key format.',
      });
    }

    const keyHash = hashApiKey(raw);
    const record = await ApiKey.findOne({ keyHash, revokedAt: null });
    if (!record) {
      return res.status(401).json({
        success: false,
        message: 'Invalid or revoked API key.',
      });
    }

    const user = await User.findById(record.user).select('-password');
    if (!user || !user.isActive) {
      return res.status(401).json({
        success: false,
        message: 'User not found or inactive.',
      });
    }

    const planId = user.subscription?.plan;
    if (!isUnmetered(user) && !planAllows(planId, 'apiAccess')) {
      return res.status(403).json({
        success: false,
        code: 'FEATURE_NOT_IN_PLAN',
        message: 'API access is not included in your plan.',
        data: { feature: 'apiAccess', currentPlan: planId },
      });
    }

    record.lastUsedAt = new Date();
    record.save().catch(err => log.warn('Failed to stamp lastUsedAt', { error: err.message }));

    req.user = user;
    req.apiKey = record;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Accept either a JWT or an API key. Used on dual-auth routes.
 * Prefer API key when the bearer looks like `ait_…`.
 */
export async function authenticateJwtOrApiKey(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (token.startsWith('ait_')) {
    return authenticateApiKey(req, res, next);
  }
  const { authenticate } = await import('./auth.js');
  return authenticate(req, res, next);
}
