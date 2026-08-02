import { Router } from 'express';
import { body } from 'express-validator';
import {
    getStats,
    getAllTools,
    getToolById,
    createTool,
    updateTool,
    deleteTool,
    permanentDeleteTool,
    restoreTool,
    toggleFeatured,
    getAllUsers,
    updateUserRole,
    getAllTags,
    getSuggestedTools,
    updateSuggestedTool,
    approveSuggestedTool,
    rejectSuggestedTool,
} from '../controllers/adminController.js';
import {
    getAdminCategories,
    createCategory,
    updateCategory,
    deleteCategory,
} from '../controllers/categoryController.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

const router = Router();

// All admin routes require authentication and admin role
router.use(authenticate);
router.use(requireAdmin);

// Validation rules
const createToolValidation = [
    body('name')
        .trim()
        .notEmpty()
        .withMessage('Tool name is required')
        .isLength({ max: 100 })
        .withMessage('Name cannot exceed 100 characters'),
    body('tagline')
        .trim()
        .notEmpty()
        .withMessage('Tagline is required')
        .isLength({ max: 200 })
        .withMessage('Tagline cannot exceed 200 characters'),
    body('description')
        .trim()
        .notEmpty()
        .withMessage('Description is required')
        .isLength({ max: 5000 })
        .withMessage('Description cannot exceed 5000 characters'),
    body('websiteUrl')
        .trim()
        .notEmpty()
        .withMessage('Website URL is required')
        .isURL()
        .withMessage('Please provide a valid URL'),
    body('category')
        .trim()
        .notEmpty()
        .withMessage('Category is required'),
    body('pricing')
        .optional()
        .isIn(['free', 'freemium', 'paid', 'contact'])
        .withMessage('Invalid pricing type'),
];

const updateToolValidation = [
    body('name')
        .optional()
        .trim()
        .isLength({ max: 100 })
        .withMessage('Name cannot exceed 100 characters'),
    body('tagline')
        .optional()
        .trim()
        .isLength({ max: 200 })
        .withMessage('Tagline cannot exceed 200 characters'),
    body('description')
        .optional()
        .trim()
        .isLength({ max: 5000 })
        .withMessage('Description cannot exceed 5000 characters'),
    body('websiteUrl')
        .optional()
        .trim()
        .isURL()
        .withMessage('Please provide a valid URL'),
    body('category')
        .optional()
        .trim(),
    body('pricing')
        .optional()
        .isIn(['free', 'freemium', 'paid', 'contact'])
        .withMessage('Invalid pricing type'),
];

// Dashboard stats
router.get('/stats', getStats);

// Tags management
router.get('/tags', getAllTags);

// Category management
router.get('/categories', getAdminCategories);
router.post('/categories', createCategory);
router.put('/categories/:id', updateCategory);
router.delete('/categories/:id', deleteCategory);

// Tools management
router.get('/tools', getAllTools);
router.get('/tools/:id', getToolById);
router.post('/tools', createToolValidation, validate, createTool);
router.put('/tools/:id', updateToolValidation, validate, updateTool);
router.delete('/tools/:id', deleteTool);
router.delete('/tools/:id/permanent', permanentDeleteTool);
router.put('/tools/:id/restore', restoreTool);
router.put('/tools/:id/feature', toggleFeatured);

// Users management
router.get('/users', getAllUsers);
router.put('/users/:id/role', updateUserRole);

// Web-discovered tool suggestions — reviewed here before ever touching the live catalog
router.get('/suggested-tools', getSuggestedTools);
router.put('/suggested-tools/:id', updateSuggestedTool);
router.post('/suggested-tools/:id/approve', approveSuggestedTool);
router.post('/suggested-tools/:id/reject', rejectSuggestedTool);

export default router;

