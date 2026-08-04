/**
 * Task board routes — the execution half of the product.
 */

import { Router } from 'express';
import { body, param, query } from 'express-validator';
import {
  createBoard,
  listBoards,
  getToday,
  getBoard,
  getBoardBySession,
  updateBoard,
  toggleSubtask,
  updateTask,
  previewSchedule,
  deleteBoard,
  getCalendarFeedLink,
  downloadCalendarIcs,
} from '../controllers/taskController.js';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { withCurrentPeriod, requireFeature } from '../middleware/entitlements.js';

const router = Router();

const scheduleValidation = [
  body('targetDate').optional({ nullable: true }).isISO8601(),
  body('weeklyHours').optional({ nullable: true }).isInt({ min: 1, max: 80 }),
];

/** Public ICS feed — signed token, no session cookie. */
router.get(
  '/calendar.ics',
  [query('token').isString().isLength({ min: 10, max: 500 })],
  validate,
  downloadCalendarIcs
);

router.use(authenticate);
router.use(withCurrentPeriod);

router.post(
  '/',
  [body('sessionId').trim().notEmpty().isLength({ max: 120 }), ...scheduleValidation],
  validate,
  createBoard
);

router.post(
  '/preview',
  [body('sessionId').trim().notEmpty().isLength({ max: 120 }), ...scheduleValidation],
  validate,
  previewSchedule
);

router.get('/', listBoards);
router.get('/today', getToday);
router.get('/by-session/:sessionId', getBoardBySession);

router.get(
  '/:boardId/calendar-link',
  requireFeature('exportWorkflow'),
  [param('boardId').isMongoId()],
  validate,
  getCalendarFeedLink
);

router.get('/:boardId', [param('boardId').isMongoId()], validate, getBoard);

router.patch(
  '/:boardId',
  [
    param('boardId').isMongoId(),
    ...scheduleValidation,
    body('status').optional().isIn(['active', 'done', 'archived']),
  ],
  validate,
  updateBoard
);

router.patch(
  '/:boardId/tasks/:taskId',
  [
    param('boardId').isMongoId(),
    body('dueDate').optional({ nullable: true }).isISO8601(),
    body('actualMinutes').optional({ nullable: true }).isInt({ min: 1, max: 2000 }),
  ],
  validate,
  updateTask
);

router.patch(
  '/:boardId/tasks/:taskId/subtasks/:index',
  [
    param('boardId').isMongoId(),
    param('index').isInt({ min: 0, max: 50 }),
    body('done').isBoolean(),
  ],
  validate,
  toggleSubtask
);

router.delete('/:boardId', [param('boardId').isMongoId()], validate, deleteBoard);

export default router;
