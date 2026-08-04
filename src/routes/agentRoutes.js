/**
 * Agentic workflow routes.
 *
 * Every entitlement decision is made here rather than in the controller, so the
 * answer to "who can do this?" is readable in one screen instead of scattered
 * across handlers. The layering is deliberate and ordered:
 *
 *   authenticate      → who are you
 *   withCurrentPeriod → roll the billing period before anything reads a balance
 *   requireFeature    → does your plan include this at all          (403)
 *   requireLimit      → have you used up your allocation of it      (403)
 *   requireCredits    → can you afford the next one                 (402)
 *   planRateLimit     → are you going too fast                      (429)
 *
 * The webhook route is mounted *before* `authenticate` because an inbound
 * webhook has no bearer token by definition — it authenticates with the token
 * in its path and re-derives every check from the workflow's owner.
 */

import { Router } from 'express';
import { body, param } from 'express-validator';
import {
  getRegistry,
  listWorkflows,
  createWorkflow,
  getWorkflow,
  updateWorkflow,
  deleteWorkflow,
  composeWorkflow,
  runWorkflow,
  listRuns,
  getRun,
  streamRun,
  cancelRunHandler,
  webhookTrigger,
  listCredentials,
  createCredential,
  deleteCredential,
} from '../controllers/agentController.js';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  withCurrentPeriod,
  requireFeature,
  requireCredits,
  requireLimit,
  planRateLimit,
} from '../middleware/entitlements.js';
import { AgentWorkflow } from '../models/index.js';

const router = Router();

// ─── Public: webhook trigger ────────────────────────────────
// No `authenticate`. The path token is the credential.
router.all(
  '/:id/webhook/:token',
  [param('id').isMongoId(), param('token').isString().isLength({ min: 20, max: 80 })],
  validate,
  webhookTrigger
);

router.use(authenticate);
router.use(withCurrentPeriod);

/**
 * The registry is readable by everyone signed in, including Hobby accounts.
 *
 * Gating it would mean the upgrade prompt in the editor couldn't show what the
 * user would be getting — "upgrade to unlock" with nothing behind it converts
 * far worse than a greyed-out palette they can read.
 */
router.get('/registry', getRegistry);

// Everything past here is the paid feature itself.
router.use(requireFeature('agenticWorkflows'));

const aiLimiter = planRateLimit();

// ─── Credentials ────────────────────────────────────────────
router.get('/credentials', listCredentials);
router.post(
  '/credentials',
  [
    body('name').trim().notEmpty().isLength({ max: 80 }),
    body('value').isString().isLength({ min: 1, max: 4000 }),
    body('provider').optional().isIn(['http', 'openai', 'anthropic', 'slack', 'discord', 'generic']),
    body('scheme').optional().isIn(['bearer', 'header', 'query', 'raw']),
    body('paramName').optional().isString().isLength({ max: 80 }),
  ],
  validate,
  createCredential
);
router.delete('/credentials/:credentialId', [param('credentialId').isMongoId()], validate, deleteCredential);

// ─── Runs (addressed by run id, not workflow id) ────────────
router.get('/runs/:runId', [param('runId').isMongoId()], validate, getRun);
router.get('/runs/:runId/stream', [param('runId').isMongoId()], validate, streamRun);
router.post('/runs/:runId/cancel', [param('runId').isMongoId()], validate, cancelRunHandler);

// ─── Workflows ──────────────────────────────────────────────
router.get('/', listWorkflows);

router.post(
  '/',
  // Counted here rather than in the controller so the cap is enforced by the
  // same layer as every other plan rule, and so the 403 carries the standard
  // upgrade payload the UI already knows how to render.
  requireLimit('agentWorkflows', req =>
    AgentWorkflow.countDocuments({ user: req.user._id, archivedAt: null })
  ),
  [
    body('name').optional().isString().isLength({ max: 120 }),
    body('surface').optional().isIn(['flow', 'browser']),
    body('description').optional().isString().isLength({ max: 600 }),
    body('prompt').optional().isString().isLength({ max: 2000 }),
  ],
  validate,
  createWorkflow
);

router.get('/:id', [param('id').isMongoId()], validate, getWorkflow);

router.patch(
  '/:id',
  [
    param('id').isMongoId(),
    body('name').optional().isString().isLength({ max: 120 }),
    body('description').optional().isString().isLength({ max: 600 }),
    body('status').optional().isIn(['draft', 'active', 'paused']),
    body('graph').optional().isObject(),
    body('graph.nodes').optional().isArray({ max: 200 }),
    body('graph.edges').optional().isArray({ max: 400 }),
    body('schedule').optional().isObject(),
  ],
  validate,
  updateWorkflow
);

router.delete('/:id', [param('id').isMongoId()], validate, deleteWorkflow);

/**
 * Composing is an LLM call, so it is rate-limited and charged like one — it is
 * a chat turn that happens to answer in graph operations rather than prose,
 * and pricing it at zero would make "rebuild this five different ways" free
 * while the equivalent question in the chat costs credits.
 */
router.post(
  '/:id/compose',
  aiLimiter,
  requireCredits('chat.message'),
  [
    param('id').isMongoId(),
    body('message').trim().notEmpty().isLength({ max: 2000 }),
    body('history').optional().isArray({ max: 20 }),
  ],
  validate,
  composeWorkflow
);

/**
 * The gate only checks the account isn't empty. A run's real price depends on
 * which nodes executed and how long a browser stayed open, so the runner
 * settles the exact amount after the fact — the same pattern the chat pipeline
 * uses, for the same reason.
 */
router.post(
  '/:id/run',
  aiLimiter,
  requireCredits('agent.run'),
  [param('id').isMongoId(), body('input').optional().isObject()],
  validate,
  runWorkflow
);

router.get('/:id/runs', [param('id').isMongoId()], validate, listRuns);

export default router;
