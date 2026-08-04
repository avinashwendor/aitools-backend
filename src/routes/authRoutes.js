import { Router } from 'express';
import { body } from 'express-validator';
import {
  signup,
  signin,
  getMe,
  updateMe,
  changePassword,
} from '../controllers/authController.js';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { rateLimit } from '../middleware/rateLimit.js';

const router = Router();

const authIpLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  keyGenerator: req => req.ip,
  message: 'Too many auth attempts from this network. Try again in an hour.',
});

const signupLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 8,
  keyGenerator: req => req.ip,
  message: 'Too many signups from this network. Try again later.',
});

// Validation rules
const signupValidation = [
  body('name')
    .trim()
    .notEmpty()
    .withMessage('Name is required')
    .isLength({ min: 2, max: 50 })
    .withMessage('Name must be between 2 and 50 characters'),
  body('email')
    .trim()
    .notEmpty()
    .withMessage('Email is required')
    .isEmail()
    .withMessage('Please provide a valid email')
    .normalizeEmail(),
  body('password')
    .notEmpty()
    .withMessage('Password is required')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters'),
];

const signinValidation = [
  body('email')
    .trim()
    .notEmpty()
    .withMessage('Email is required')
    .isEmail()
    .withMessage('Please provide a valid email')
    .normalizeEmail(),
  body('password')
    .notEmpty()
    .withMessage('Password is required'),
];

const updateProfileValidation = [
  body('name')
    .optional()
    .trim()
    .isLength({ min: 2, max: 50 })
    .withMessage('Name must be between 2 and 50 characters'),
  body('bio')
    .optional()
    .isLength({ max: 500 })
    .withMessage('Bio cannot exceed 500 characters'),
  body('reminders').optional().isObject(),
  body('reminders.emailDigest').optional().isBoolean(),
  body('reminders.staleNudge').optional().isBoolean(),
  body('reminders.weeklySummary').optional().isBoolean(),
];

const changePasswordValidation = [
  body('currentPassword')
    .notEmpty()
    .withMessage('Current password is required'),
  body('newPassword')
    .notEmpty()
    .withMessage('New password is required')
    .isLength({ min: 8 })
    .withMessage('New password must be at least 8 characters'),
];

// Public routes
router.post('/signup', signupLimit, signupValidation, validate, signup);
router.post('/signin', authIpLimit, signinValidation, validate, signin);

// Protected routes
router.get('/me', authenticate, getMe);
router.put('/me', authenticate, updateProfileValidation, validate, updateMe);
router.put('/password', authenticate, changePasswordValidation, validate, changePassword);

export default router;
