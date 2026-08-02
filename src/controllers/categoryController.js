import { Category, Tool } from '../models/index.js';
import { ApiError } from '../middleware/errorHandler.js';

/**
 * Get all categories with tool counts
 * GET /api/categories
 */
export const getCategories = async (req, res, next) => {
  try {
    const { includeEmpty = 'false' } = req.query;

    // Get all active categories
    const categories = await Category.find({ isActive: true })
      .sort({ order: 1, name: 1 });

    // Get tool counts for each category
    const categoryCounts = await Tool.aggregate([
      { $match: { isActive: true } },
      { $group: { _id: '$category', count: { $sum: 1 } } },
    ]);

    const countMap = {};
    categoryCounts.forEach(c => {
      countMap[c._id] = c.count;
    });

    // Combine categories with counts
    let result = categories.map(cat => ({
      id: cat.slug,
      name: cat.name,
      icon: cat.icon,
      color: cat.color,
      description: cat.description,
      count: countMap[cat.slug] || 0,
    }));

    // Filter out empty categories unless requested
    if (includeEmpty !== 'true') {
      result = result.filter(cat => cat.count > 0);
    }

    res.json({
      success: true,
      data: { categories: result },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get all categories (admin - includes inactive)
 * GET /api/admin/categories
 */
export const getAdminCategories = async (req, res, next) => {
  try {
    const categories = await Category.find()
      .sort({ order: 1, name: 1 });

    // Get tool counts for each category
    const categoryCounts = await Tool.aggregate([
      { $group: { _id: '$category', count: { $sum: 1 } } },
    ]);

    const countMap = {};
    categoryCounts.forEach(c => {
      countMap[c._id] = c.count;
    });

    const result = categories.map(cat => ({
      _id: cat._id,
      id: cat.slug,
      name: cat.name,
      slug: cat.slug,
      icon: cat.icon,
      color: cat.color,
      description: cat.description,
      order: cat.order,
      isActive: cat.isActive,
      count: countMap[cat.slug] || 0,
      createdAt: cat.createdAt,
      updatedAt: cat.updatedAt,
    }));

    res.json({
      success: true,
      data: { categories: result },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Create a new category
 * POST /api/admin/categories
 */
export const createCategory = async (req, res, next) => {
  try {
    const { name, description, icon, color, order } = req.body;

    // Check if category already exists
    const existing = await Category.findOne({ 
      name: { $regex: new RegExp(`^${name}$`, 'i') } 
    });
    if (existing) {
      throw new ApiError(400, 'Category with this name already exists');
    }

    const category = new Category({
      name,
      description,
      icon,
      color,
      order,
    });

    await category.save();

    res.status(201).json({
      success: true,
      message: 'Category created successfully',
      data: { category },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Update a category
 * PUT /api/admin/categories/:id
 */
export const updateCategory = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, description, icon, color, order, isActive } = req.body;

    const category = await Category.findById(id);
    if (!category) {
      throw new ApiError(404, 'Category not found');
    }

    // Check if name is being changed and already exists
    if (name && name !== category.name) {
      const existing = await Category.findOne({ 
        name: { $regex: new RegExp(`^${name}$`, 'i') },
        _id: { $ne: id }
      });
      if (existing) {
        throw new ApiError(400, 'Category with this name already exists');
      }
    }

    // Update fields
    if (name !== undefined) category.name = name;
    if (description !== undefined) category.description = description;
    if (icon !== undefined) category.icon = icon;
    if (color !== undefined) category.color = color;
    if (order !== undefined) category.order = order;
    if (isActive !== undefined) category.isActive = isActive;

    await category.save();

    res.json({
      success: true,
      message: 'Category updated successfully',
      data: { category },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Delete a category
 * DELETE /api/admin/categories/:id
 */
export const deleteCategory = async (req, res, next) => {
  try {
    const { id } = req.params;

    const category = await Category.findById(id);
    if (!category) {
      throw new ApiError(404, 'Category not found');
    }

    // Check if any tools are using this category
    const toolCount = await Tool.countDocuments({ category: category.slug });
    if (toolCount > 0) {
      throw new ApiError(400, `Cannot delete category. ${toolCount} tools are using this category. Please reassign them first.`);
    }

    await Category.findByIdAndDelete(id);

    res.json({
      success: true,
      message: 'Category deleted successfully',
    });
  } catch (error) {
    next(error);
  }
};
