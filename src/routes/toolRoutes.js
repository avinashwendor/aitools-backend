import { Router } from 'express';
import {
  getTools,
  getFeaturedTools,
  getToolBySlug,
  incrementViews,
  toggleLike,
  toggleSave,
  getCategories,
} from '../controllers/toolController.js';
import {
  getComments,
  createComment,
} from '../controllers/commentController.js';
import { authenticate, optionalAuth } from '../middleware/auth.js';
import { body } from 'express-validator';
import { validate } from '../middleware/validate.js';

const router = Router();

// Validation rules
const commentValidation = [
  body('content')
    .trim()
    .notEmpty()
    .withMessage('Comment content is required')
    .isLength({ max: 2000 })
    .withMessage('Comment cannot exceed 2000 characters'),
  body('rating')
    .optional()
    .isInt({ min: 1, max: 5 })
    .withMessage('Rating must be between 1 and 5'),
];

// Public routes
router.get('/', optionalAuth, getTools);
router.get('/featured', getFeaturedTools);
router.get('/categories', getCategories);
router.get('/:slug', optionalAuth, getToolBySlug);
router.post('/:slug/view', incrementViews);
router.get('/:slug/comments', getComments);

// Protected routes
router.post('/:slug/like', authenticate, toggleLike);
router.post('/:slug/save', authenticate, toggleSave);
router.post('/:slug/comments', authenticate, commentValidation, validate, createComment);

export default router;

