import Integration from '../models/Integration.js';
import { getProvider, listProviders } from '../integrations/index.js';
import { verifyOAuthState } from '../integrations/crypto.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('integrations');

export const listIntegrations = async (req, res, next) => {
  try {
    const connected = await Integration.find({
      user: req.user._id,
      status: { $ne: 'revoked' },
    })
      .select('provider email status scopes createdAt updatedAt meta')
      .lean();

    res.json({
      success: true,
      data: {
        providers: listProviders(),
        connected,
      },
    });
  } catch (err) {
    next(err);
  }
};

export const startConnect = async (req, res, next) => {
  try {
    const provider = getProvider(req.params.provider);
    if (!provider) {
      return res.status(404).json({ success: false, message: 'Unknown provider' });
    }
    const { url } = provider.connect({ userId: req.user._id });
    res.json({ success: true, data: { url } });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ success: false, message: err.message });
    }
    next(err);
  }
};

export const oauthCallback = async (req, res, next) => {
  try {
    const providerId = req.params.provider;
    const provider = getProvider(providerId);
    if (!provider) {
      return res.status(404).send('Unknown provider');
    }

    const { code, state, error } = req.query;
    if (error) {
      return res.redirect(`${frontendBase()}/settings?tab=integrations&integrations=error`);
    }
    if (!code) {
      return res.status(400).send('Missing code');
    }

    const verified = verifyOAuthState(state);
    if (!verified?.userId) {
      return res.redirect(`${frontendBase()}/settings?tab=integrations&integrations=error`);
    }

    await provider.handleCallback({ code, userId: verified.userId });
    res.redirect(`${frontendBase()}/settings?tab=integrations&integrations=connected`);
  } catch (err) {
    log.error('OAuth callback failed', { error: err.message });
    res.redirect(`${frontendBase()}/settings?tab=integrations&integrations=error`);
  }
};

export const disconnect = async (req, res, next) => {
  try {
    const updated = await Integration.findOneAndUpdate(
      { user: req.user._id, provider: req.params.provider },
      {
        $set: {
          status: 'revoked',
          accessTokenEnc: null,
          refreshTokenEnc: null,
        },
      },
      { new: true }
    );
    if (!updated) {
      return res.status(404).json({ success: false, message: 'Integration not found' });
    }
    res.json({ success: true, message: 'Disconnected' });
  } catch (err) {
    next(err);
  }
};

export const pushBoardToCalendar = async (req, res, next) => {
  try {
    const TaskBoard = (await import('../models/TaskBoard.js')).default;
    const board = await TaskBoard.findOne({
      _id: req.params.boardId,
      user: req.user._id,
    });
    if (!board) {
      return res.status(404).json({ success: false, message: 'Board not found' });
    }

    const integration = await Integration.findOne({
      user: req.user._id,
      provider: 'google',
      status: 'connected',
    });
    if (!integration) {
      return res.status(404).json({
        success: false,
        message: 'Connect Google in Settings → Integrations first.',
      });
    }

    const boardKey = String(board._id);
    const existingEventIds = { ...(integration.meta?.eventIds?.[boardKey] || {}) };

    const provider = getProvider('google');
    const results = await provider.push(board, existingEventIds);

    const eventIds = { ...existingEventIds };
    for (const r of results) {
      if (r.eventId) eventIds[r.taskId] = r.eventId;
    }

    await Integration.updateOne(
      { _id: integration._id },
      { $set: { [`meta.eventIds.${boardKey}`]: eventIds } }
    );

    res.json({
      success: true,
      data: {
        results,
        pushed: results.length,
        updated: results.filter(r => r.updated).length,
      },
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ success: false, message: err.message });
    }
    next(err);
  }
};

function frontendBase() {
  const origins = process.env.CORS_ORIGINS || 'http://localhost:5173';
  return origins.split(',')[0].trim();
}
