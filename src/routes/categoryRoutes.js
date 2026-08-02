import { Router } from 'express';
import {
  getCategories,
} from '../controllers/categoryController.js';

const router = Router();

// Public routes
router.get('/', getCategories);

export default router;
