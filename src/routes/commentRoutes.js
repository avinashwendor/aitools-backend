import { Router } from 'express';
import { body } from 'express-validator';
import {
  updateComment,
  deleteComment,
  likeComment,
} from '../controllers/commentController.js';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

const router = Router();

// Validation rules
const updateCommentValidation = [
  body('content')
    .trim()
    .notEmpty()
    .withMessage('Comment content is required')
    .isLength({ max: 2000 })
    .withMessage('Comment cannot exceed 2000 characters'),
];

// All routes require authentication
router.put('/:id', authenticate, updateCommentValidation, validate, updateComment);
router.delete('/:id', authenticate, deleteComment);
router.post('/:id/like', authenticate, likeComment);

export default router;

