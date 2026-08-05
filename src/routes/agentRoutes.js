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
  resetWorkflowGraph,
  setRequirementCredential,
  startBuild,
  continueBuild,
  repairWorkflow,
  listBuilds,
  getBuild,
  streamBuild,
  cancelBuildHandler,
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
import { AgentWorkflow, AgentBuild } from '../models/index.js';

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

const CREDENTIAL_PROVIDERS = [
  'http',
  'openai',
  'anthropic',
  'slack',
  'discord',
  'telegram',
  'notion',
  'generic',
];

// ─── Credentials ────────────────────────────────────────────
router.get('/credentials', listCredentials);
router.post(
  '/credentials',
  [
    body('name').trim().notEmpty().isLength({ max: 80 }),
    body('value').isString().isLength({ min: 1, max: 4000 }),
    body('provider').optional().isIn(CREDENTIAL_PROVIDERS),
    body('scheme').optional().isIn(['bearer', 'header', 'query', 'raw']),
    body('paramName').optional().isString().isLength({ max: 80 }),
  ],
  validate,
  createCredential
);
router.delete('/credentials/:credentialId', [param('credentialId').isMongoId()], validate, deleteCredential);

// ─── Builds (addressed by build id, not workflow id) ────────
router.get('/builds/:buildId', [param('buildId').isMongoId()], validate, getBuild);
router.get('/builds/:buildId/stream', [param('buildId').isMongoId()], validate, streamBuild);
router.post('/builds/:buildId/cancel', [param('buildId').isMongoId()], validate, cancelBuildHandler);
router.post(
  '/builds/:buildId/continue',
  aiLimiter,
  requireCredits('agent.build'),
  [param('buildId').isMongoId(), body('message').trim().notEmpty().isLength({ max: 4000 })],
  validate,
  continueBuild
);

// ─── Runs (addressed by run id, not workflow id) ────────────
router.get('/runs/:runId', [param('runId').isMongoId()], validate, getRun);
router.get('/runs/:runId/stream', [param('runId').isMongoId()], validate, streamRun);
router.post('/runs/:runId/cancel', [param('runId').isMongoId()], validate, cancelRunHandler);

// ─── Workflows ──────────────────────────────────────────────
router.get('/', listWorkflows);

/**
 * Creating with a `prompt` starts an architect session in the same request, so
 * the credit gate has to be the build's, not the workflow's — otherwise an
 * empty account could open a build it can't pay for and watch it fail on its
 * first model call.
 */
router.post(
  '/',
  // Counted here rather than in the controller so the cap is enforced by the
  // same layer as every other plan rule, and so the 403 carries the standard
  // upgrade payload the UI already knows how to render.
  requireLimit('agentWorkflows', req =>
    AgentWorkflow.countDocuments({ user: req.user._id, archivedAt: null })
  ),
  requireCredits('agent.build'),
  [
    body('name').optional().isString().isLength({ max: 120 }),
    body('description').optional().isString().isLength({ max: 600 }),
    body('prompt').optional().isString().isLength({ max: 4000 }),
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
router.post('/:id/reset', [param('id').isMongoId()], validate, resetWorkflowGraph);

router.put(
  '/:id/requirements/:key',
  [
    param('id').isMongoId(),
    param('key').isString().isLength({ max: 60 }),
    body('credentialId').optional({ nullable: true }).isMongoId(),
  ],
  validate,
  setRequirementCredential
);

/**
 * The architect is a multi-step LLM session, so it is rate-limited and charged
 * like one. The gate only checks the account isn't empty; the real price
 * depends on how many steps the session took, which nobody knows until it is
 * over — the same after-the-fact settlement the chat pipeline uses.
 */
router.post(
  '/:id/build',
  aiLimiter,
  requireCredits('agent.build'),
  requireLimit('agentBuildsPerMonth', req =>
    AgentBuild.countDocuments({
      user: req.user._id,
      createdAt: { $gte: req.user.subscription?.periodStart || new Date(0) },
    })
  ),
  [
    param('id').isMongoId(),
    body('message').trim().notEmpty().isLength({ max: 4000 }),
  ],
  validate,
  startBuild
);

router.post(
  '/:id/repair',
  aiLimiter,
  requireCredits('agent.build'),
  [param('id').isMongoId(), body('runId').isMongoId()],
  validate,
  repairWorkflow
);

router.get('/:id/builds', [param('id').isMongoId()], validate, listBuilds);

/**
 * The gate only checks the account isn't empty. A run's real price depends on
 * which nodes executed, so the runner settles the exact amount after the fact.
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
