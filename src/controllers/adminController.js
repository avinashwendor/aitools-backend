import { Tool, User, Comment, SuggestedTool } from '../models/index.js';
import { ApiError } from '../middleware/errorHandler.js';
import { invalidateCatalog } from '../ai/catalog.js';
import slugify from 'slugify';

/**
 * Get admin dashboard stats
 * GET /api/admin/stats
 */
export const getStats = async (req, res, next) => {
  try {
    const [
      totalTools,
      totalUsers,
      totalComments,
      totalViews,
      totalLikes,
      recentTools,
      categoryStats,
      pricingStats,
    ] = await Promise.all([
      Tool.countDocuments({ isActive: true }),
      User.countDocuments({ isActive: true }),
      Comment.countDocuments({ isActive: true }),
      Tool.aggregate([
        { $match: { isActive: true } },
        { $group: { _id: null, total: { $sum: '$views' } } },
      ]),
      Tool.aggregate([
        { $match: { isActive: true } },
        { $group: { _id: null, total: { $sum: '$likes' } } },
      ]),
      Tool.find({ isActive: true })
        .sort('-createdAt')
        .limit(5)
        .select('name slug logo category views likes createdAt'),
      Tool.aggregate([
        { $match: { isActive: true } },
        { $group: { _id: '$category', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      Tool.aggregate([
        { $match: { isActive: true } },
        { $group: { _id: '$pricing', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
    ]);
    
    res.json({
      success: true,
      data: {
        overview: {
          totalTools,
          totalUsers,
          totalComments,
          totalViews: totalViews[0]?.total || 0,
          totalLikes: totalLikes[0]?.total || 0,
        },
        recentTools,
        categoryStats: categoryStats.map(c => ({
          category: c._id,
          count: c.count,
        })),
        pricingStats: pricingStats.map(p => ({
          pricing: p._id,
          count: p.count,
        })),
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get single tool by ID for editing
 * GET /api/admin/tools/:id
 */
export const getToolById = async (req, res, next) => {
  try {
    const { id } = req.params;
    
    const tool = await Tool.findById(id).populate('createdBy', 'name email');
    
    if (!tool) {
      throw new ApiError(404, 'Tool not found');
    }
    
    res.json({
      success: true,
      data: { tool },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get all tools for admin (including inactive)
 * GET /api/admin/tools
 */
export const getAllTools = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, search, category, status } = req.query;
    
    const filter = {};
    
    if (category) {
      filter.category = category;
    }
    
    if (status === 'active') {
      filter.isActive = true;
    } else if (status === 'inactive') {
      filter.isActive = false;
    }
    
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { tagline: { $regex: search, $options: 'i' } },
      ];
    }
    
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
    const skip = (pageNum - 1) * limitNum;
    
    const [tools, totalCount] = await Promise.all([
      Tool.find(filter)
        .sort('-createdAt')
        .skip(skip)
        .limit(limitNum)
        .populate('createdBy', 'name email'),
      Tool.countDocuments(filter),
    ]);
    
    res.json({
      success: true,
      data: {
        tools,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total: totalCount,
          pages: Math.ceil(totalCount / limitNum),
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Create a new tool
 * POST /api/admin/tools
 */
export const createTool = async (req, res, next) => {
  try {
    const {
      name,
      tagline,
      description,
      logo,
      screenshot,
      websiteUrl,
      category,
      pricing,
      pricingDetails,
      features,
      tags,
      isFeatured,
      isVerified,
      socialLinks,
      youtubeVideos,
    } = req.body;
    
    // Generate unique slug
    let slug = slugify(name, { lower: true, strict: true });
    const existingTool = await Tool.findOne({ slug });
    if (existingTool) {
      slug = `${slug}-${Date.now()}`;
    }
    
    const tool = await Tool.create({
      name,
      slug,
      tagline,
      description,
      logo,
      screenshot,
      websiteUrl,
      category,
      pricing,
      pricingDetails,
      features: features || [],
      tags: tags || [],
      isFeatured: isFeatured || false,
      isVerified: isVerified || false,
      socialLinks: socialLinks || {},
      youtubeVideos: youtubeVideos || [],
      createdBy: req.user.id,
    });
    
    res.status(201).json({
      success: true,
      message: 'Tool created successfully',
      data: { tool },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Update a tool
 * PUT /api/admin/tools/:id
 */
export const updateTool = async (req, res, next) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    
    // Remove fields that shouldn't be updated directly
    delete updates._id;
    delete updates.slug;
    delete updates.createdBy;
    delete updates.createdAt;
    delete updates.updatedAt;
    
    // If name is being updated, update slug too
    if (updates.name) {
      let newSlug = slugify(updates.name, { lower: true, strict: true });
      const existingTool = await Tool.findOne({ slug: newSlug, _id: { $ne: id } });
      if (existingTool) {
        newSlug = `${newSlug}-${Date.now()}`;
      }
      updates.slug = newSlug;
    }
    
    const tool = await Tool.findByIdAndUpdate(
      id,
      updates,
      { new: true, runValidators: true }
    );
    
    if (!tool) {
      throw new ApiError(404, 'Tool not found');
    }
    
    res.json({
      success: true,
      message: 'Tool updated successfully',
      data: { tool },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Delete a tool (soft delete)
 * DELETE /api/admin/tools/:id
 */
export const deleteTool = async (req, res, next) => {
  try {
    const { id } = req.params;
    
    const tool = await Tool.findByIdAndUpdate(
      id,
      { isActive: false },
      { new: true }
    );
    
    if (!tool) {
      throw new ApiError(404, 'Tool not found');
    }
    
    res.json({
      success: true,
      message: 'Tool deactivated successfully',
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Permanently delete a tool
 * DELETE /api/admin/tools/:id/permanent
 */
export const permanentDeleteTool = async (req, res, next) => {
  try {
    const { id } = req.params;
    
    const tool = await Tool.findById(id);
    
    if (!tool) {
      throw new ApiError(404, 'Tool not found');
    }
    
    // Only allow permanent deletion of inactive tools
    if (tool.isActive) {
      throw new ApiError(400, 'Tool must be deactivated before permanent deletion');
    }
    
    // Delete all associated comments
    await Comment.deleteMany({ tool: id });
    
    // Delete the tool
    await Tool.findByIdAndDelete(id);
    
    res.json({
      success: true,
      message: 'Tool permanently deleted',
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Restore a tool (reactivate)
 * PUT /api/admin/tools/:id/restore
 */
export const restoreTool = async (req, res, next) => {
  try {
    const { id } = req.params;
    
    const tool = await Tool.findByIdAndUpdate(
      id,
      { isActive: true },
      { new: true }
    );
    
    if (!tool) {
      throw new ApiError(404, 'Tool not found');
    }
    
    res.json({
      success: true,
      message: 'Tool restored successfully',
      data: { tool },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Toggle tool featured status
 * PUT /api/admin/tools/:id/feature
 */
export const toggleFeatured = async (req, res, next) => {
  try {
    const { id } = req.params;
    
    const tool = await Tool.findById(id);
    if (!tool) {
      throw new ApiError(404, 'Tool not found');
    }
    
    tool.isFeatured = !tool.isFeatured;
    await tool.save();
    
    res.json({
      success: true,
      message: `Tool ${tool.isFeatured ? 'featured' : 'unfeatured'} successfully`,
      data: { isFeatured: tool.isFeatured },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get all users for admin
 * GET /api/admin/users
 */
export const getAllUsers = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, search, role } = req.query;
    
    const filter = {};
    
    if (role) {
      filter.role = role;
    }
    
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
      ];
    }
    
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
    const skip = (pageNum - 1) * limitNum;
    
    const [users, totalCount] = await Promise.all([
      User.find(filter)
        .sort('-createdAt')
        .skip(skip)
        .limit(limitNum)
        .select('-password'),
      User.countDocuments(filter),
    ]);
    
    res.json({
      success: true,
      data: {
        users,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total: totalCount,
          pages: Math.ceil(totalCount / limitNum),
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Update user role
 * PUT /api/admin/users/:id/role
 */
export const updateUserRole = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { role } = req.body;
    
    if (!['user', 'admin'].includes(role)) {
      throw new ApiError(400, 'Invalid role');
    }
    
    const user = await User.findByIdAndUpdate(
      id,
      { role },
      { new: true }
    ).select('-password');
    
    if (!user) {
      throw new ApiError(404, 'User not found');
    }
    
    res.json({
      success: true,
      message: 'User role updated successfully',
      data: { user },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get all unique tags from tools
 * GET /api/admin/tags
 */
export const getAllTags = async (req, res, next) => {
  try {
    const tags = await Tool.distinct('tags', { isActive: true });
    
    res.json({
      success: true,
      data: { tags: tags.filter(t => t).sort() },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Tools the assistant found via web search but aren't in our catalog yet —
 * queued here for review, never added automatically.
 * GET /api/admin/suggested-tools?status=pending
 */
export const getSuggestedTools = async (req, res, next) => {
  try {
    const { status = 'pending', page = 1, limit = 20 } = req.query;

    const filter = {};
    if (['pending', 'approved', 'rejected'].includes(status)) filter.status = status;

    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
    const skip = (pageNum - 1) * limitNum;

    const [suggestions, totalCount] = await Promise.all([
      SuggestedTool.find(filter)
        .sort('-createdAt')
        .skip(skip)
        .limit(limitNum)
        .populate('discoveredBy', 'name email')
        .populate('reviewedBy', 'name email'),
      SuggestedTool.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: {
        suggestions,
        pagination: { page: pageNum, limit: limitNum, total: totalCount, pages: Math.ceil(totalCount / limitNum) },
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Edit a suggestion's fields before approving/rejecting it.
 * PUT /api/admin/suggested-tools/:id
 */
export const updateSuggestedTool = async (req, res, next) => {
  try {
    const { id } = req.params;
    const updates = { ...req.body };
    delete updates._id;
    delete updates.status;
    delete updates.domain;
    delete updates.reviewedBy;
    delete updates.reviewedAt;
    delete updates.promotedTool;

    const suggestion = await SuggestedTool.findByIdAndUpdate(id, updates, { new: true, runValidators: true });
    if (!suggestion) throw new ApiError(404, 'Suggestion not found');

    res.json({ success: true, message: 'Suggestion updated', data: { suggestion } });
  } catch (error) {
    next(error);
  }
};

/**
 * Approve a suggestion — promotes it into the real, live Tool catalog.
 * POST /api/admin/suggested-tools/:id/approve
 * Body may include final-edit overrides (category/pricing/etc) applied at promotion time.
 */
export const approveSuggestedTool = async (req, res, next) => {
  try {
    const { id } = req.params;
    const suggestion = await SuggestedTool.findById(id);
    if (!suggestion) throw new ApiError(404, 'Suggestion not found');
    if (suggestion.status !== 'pending') throw new ApiError(400, 'Suggestion already reviewed');

    const overrides = req.body || {};
    const name = overrides.name || suggestion.name;
    const category = overrides.category || suggestion.suggestedCategory || 'other';
    const pricing = ['free', 'freemium', 'paid', 'contact'].includes(overrides.pricing)
      ? overrides.pricing
      : (['free', 'freemium', 'paid', 'contact'].includes(suggestion.suggestedPricing)
        ? suggestion.suggestedPricing
        : 'freemium');

    let slug = slugify(name, { lower: true, strict: true });
    if (await Tool.findOne({ slug })) slug = `${slug}-${Date.now()}`;

    const tool = await Tool.create({
      name,
      slug,
      tagline: overrides.tagline || suggestion.tagline || name,
      description: overrides.description || suggestion.description || suggestion.tagline || name,
      websiteUrl: overrides.websiteUrl || suggestion.websiteUrl,
      category,
      pricing,
      features: overrides.features || [],
      tags: overrides.tags || [],
      isVerified: false,
      createdBy: req.user.id,
    });

    suggestion.status = 'approved';
    suggestion.reviewedBy = req.user.id;
    suggestion.reviewedAt = new Date();
    suggestion.promotedTool = tool._id;
    await suggestion.save();

    invalidateCatalog();

    res.json({ success: true, message: 'Suggestion approved and added to the catalog', data: { tool, suggestion } });
  } catch (error) {
    next(error);
  }
};

/**
 * Reject a suggestion — kept (not deleted) so the same domain isn't re-suggested.
 * POST /api/admin/suggested-tools/:id/reject
 */
export const rejectSuggestedTool = async (req, res, next) => {
  try {
    const { id } = req.params;
    const suggestion = await SuggestedTool.findByIdAndUpdate(
      id,
      { status: 'rejected', reviewedBy: req.user.id, reviewedAt: new Date() },
      { new: true }
    );
    if (!suggestion) throw new ApiError(404, 'Suggestion not found');

    res.json({ success: true, message: 'Suggestion rejected', data: { suggestion } });
  } catch (error) {
    next(error);
  }
};

/**
 * Get categories with counts
 * GET /api/admin/categories
 */
export const getCategories = async (req, res, next) => {
  try {
    const categoryStats = await Tool.aggregate([
      { $match: { isActive: true } },
      { $group: { _id: '$category', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);
    
    const categories = [
      { id: 'writing', name: 'Writing', icon: '✍️' },
      { id: 'image', name: 'Image', icon: '🖼️' },
      { id: 'video', name: 'Video', icon: '🎬' },
      { id: 'audio', name: 'Audio', icon: '🎵' },
      { id: 'coding', name: 'Coding', icon: '💻' },
      { id: 'productivity', name: 'Productivity', icon: '⚡' },
      { id: 'marketing', name: 'Marketing', icon: '📈' },
      { id: 'research', name: 'Research', icon: '🔬' },
      { id: 'design', name: 'Design', icon: '🎨' },
      { id: 'business', name: 'Business', icon: '💼' },
      { id: 'education', name: 'Education', icon: '📚' },
      { id: 'other', name: 'Other', icon: '🔧' },
    ].map(cat => {
      const stat = categoryStats.find(s => s._id === cat.id);
      return { ...cat, count: stat?.count || 0 };
    });
    
    res.json({
      success: true,
      data: { categories },
    });
  } catch (error) {
    next(error);
  }
};

