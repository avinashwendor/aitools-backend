/**
 * Workflow task-tracking routes. All require authentication.
 */

import { Router } from 'express';
import { getMyWorkflows, getWorkflowRun, toggleStep } from '../controllers/workflowController.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

router.use(authenticate);

router.get('/', getMyWorkflows);
router.get('/:sessionId', getWorkflowRun);
router.patch('/:sessionId/steps/:stageId/:stepIndex', toggleStep);

export default router;
