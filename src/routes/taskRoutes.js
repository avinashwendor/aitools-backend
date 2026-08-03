/**
 * Task board routes — the execution half of the product. All require auth.
 *
 * Replaces the old `/api/workflows` tracking routes, which shadowed a board
 * that was created automatically on every generated workflow.
 */

import { Router } from 'express';
import { body, param } from 'express-validator';
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
} from '../controllers/taskController.js';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

const router = Router();

router.use(authenticate);

const scheduleValidation = [
  body('targetDate').optional({ nullable: true }).isISO8601(),
  body('weeklyHours').optional({ nullable: true }).isInt({ min: 1, max: 80 }),
];

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

// Declared before `/:boardId` so the literal path isn't captured as an id.
router.get('/today', getToday);
router.get('/by-session/:sessionId', getBoardBySession);

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
