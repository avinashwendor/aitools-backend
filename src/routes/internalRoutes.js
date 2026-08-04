/**
 * Internal endpoints for ops / n8n reminder runners.
 * Auth: `Authorization: Bearer <INTERNAL_API_SECRET>` or `X-Internal-Secret`.
 */

import { Router } from 'express';
import config from '../config/index.js';
import { listDueBoards, runReminderScan } from '../jobs/reminders.js';

const router = Router();

function requireInternalSecret(req, res, next) {
  const secret = config.internalApiSecret;
  if (!secret) {
    return res.status(503).json({
      success: false,
      message: 'INTERNAL_API_SECRET is not configured',
    });
  }

  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const alt = req.headers['x-internal-secret'];
  if (bearer !== secret && alt !== secret) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  next();
}

router.use(requireInternalSecret);

router.get('/due-boards', async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 200);
    const boards = await listDueBoards({ limit });
    res.json({ success: true, data: { boards, count: boards.length } });
  } catch (err) {
    next(err);
  }
});

router.post('/reminders/run', async (req, res, next) => {
  try {
    const result = await runReminderScan();
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

export default router;
