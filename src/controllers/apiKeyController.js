/**
 * API key management for Enterprise `apiAccess` (MCP + public API).
 */

import ApiKey, { generateApiKeySecret } from '../models/ApiKey.js';
import { planAllows } from '../billing/plans.js';
import { isUnmetered } from '../billing/credits.js';

function requireApiAccess(user) {
  return isUnmetered(user) || planAllows(user.subscription?.plan, 'apiAccess');
}

export const listApiKeys = async (req, res, next) => {
  try {
    if (!requireApiAccess(req.user)) {
      return res.status(403).json({
        success: false,
        code: 'FEATURE_NOT_IN_PLAN',
        message: 'API access is not included in your plan.',
        data: { feature: 'apiAccess' },
      });
    }

    const keys = await ApiKey.find({ user: req.user._id, revokedAt: null })
      .select('name keyPrefix scopes lastUsedAt createdAt')
      .sort('-createdAt')
      .lean();

    res.json({ success: true, data: { keys } });
  } catch (err) {
    next(err);
  }
};

export const createApiKey = async (req, res, next) => {
  try {
    if (!requireApiAccess(req.user)) {
      return res.status(403).json({
        success: false,
        code: 'FEATURE_NOT_IN_PLAN',
        message: 'API access is not included in your plan.',
        data: { feature: 'apiAccess' },
      });
    }

    const name = String(req.body.name || 'Default').trim().slice(0, 80);
    const { raw, keyHash, keyPrefix } = generateApiKeySecret();

    const record = await ApiKey.create({
      user: req.user._id,
      name,
      keyHash,
      keyPrefix,
      scopes: ['mcp'],
    });

    res.status(201).json({
      success: true,
      data: {
        key: {
          id: record._id,
          name: record.name,
          keyPrefix: record.keyPrefix,
          scopes: record.scopes,
          createdAt: record.createdAt,
        },
        // Shown once — never stored or returned again.
        secret: raw,
      },
    });
  } catch (err) {
    next(err);
  }
};

export const revokeApiKey = async (req, res, next) => {
  try {
    const key = await ApiKey.findOne({
      _id: req.params.id,
      user: req.user._id,
      revokedAt: null,
    });

    if (!key) {
      return res.status(404).json({ success: false, message: 'API key not found' });
    }

    key.revokedAt = new Date();
    await key.save();

    res.json({ success: true, message: 'API key revoked' });
  } catch (err) {
    next(err);
  }
};
