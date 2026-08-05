import { Tool, User } from '../models/index.js';
import { ApiError } from '../middleware/errorHandler.js';
import config from '../config/index.js';
import { searchCatalogByMeaning } from '../ai/toolSearch.js';

/**
 * Get all tools with filtering, sorting, and pagination
 * GET /api/tools
 */
export const getTools = async (req, res, next) => {
  try {
    const {
      page = 1,
      limit = config.defaultPageSize,
      category,
      pricing,
      search,
      sort = '-createdAt',
      featured,
      tags,
    } = req.query;
    
    // Build filter query
    const filter = { isActive: true };
    
    if (category) {
      filter.category = category;
    }
    
    if (pricing) {
      filter.pricing = pricing;
    }
    
    if (featured === 'true') {
      filter.isFeatured = true;
    }
    
    if (tags) {
      filter.tags = { $in: tags.split(',').map(t => t.trim().toLowerCase()) };
    }
    
    if (search) {
      // Use regex for partial matching - this allows "chat" to find "ChatGPT"
      // Escape special regex characters to prevent injection
      const escapedSearch = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const searchRegex = { $regex: escapedSearch, $options: 'i' };
      
      filter.$or = [
        { name: searchRegex },
        { tagline: searchRegex },
        { description: searchRegex },
        { tags: searchRegex },
      ];
    }
    
    // Parse pagination
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(config.maxPageSize, Math.max(1, parseInt(limit, 10)));
    const skip = (pageNum - 1) * limitNum;
    
    // Parse sort - prioritize relevance by name match when searching
    const sortObj = parseSortString(sort);
    
    // Execute query
    const [tools, totalCount] = await Promise.all([
      Tool.find(filter)
        .sort(sortObj)
        .skip(skip)
        .limit(limitNum)
        .populate('createdBy', 'name avatar'),
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
          hasMore: pageNum * limitNum < totalCount,
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Natural-language search over the catalog.
 * POST /api/tools/ai-search  { query, limit?, pricing?, category? }
 *
 * Deliberately not metered: it costs one embedding call and no LLM turn, and
 * a discovery surface that asks visitors to spend credits before they've found
 * anything isn't discovery. The rate limit on the route is what protects it.
 */
export const aiSearchTools = async (req, res, next) => {
  try {
    const { query, limit, pricing, category } = req.body || {};
    const text = String(query || '').trim();

    if (text.length < 3) {
      throw new ApiError(400, 'Ask in a few more words — three characters is not a question.');
    }
    if (text.length > 400) {
      throw new ApiError(400, 'Keep the question under 400 characters.');
    }

    const parsedLimit = Number.parseInt(limit, 10);
    const resultLimit = Math.min(48, Math.max(1, Number.isNaN(parsedLimit) ? 24 : parsedLimit));

    const answer = await searchCatalogByMeaning(text, {
      limit: resultLimit,
      pricing,
      category,
    });

    res.json({
      success: true,
      data: {
        query: text,
        tools: answer.results,
        intent: answer.intent,
        mode: answer.mode,
        vectorSearchAvailable: answer.vectorSearchAvailable,
        corpusSize: answer.corpusSize,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get featured tools
 * GET /api/tools/featured
 */
export const getFeaturedTools = async (req, res, next) => {
  try {
    const { limit = 8 } = req.query;
    
    const tools = await Tool.find({ isActive: true, isFeatured: true })
      .sort('-views')
      .limit(parseInt(limit, 10));
    
    res.json({
      success: true,
      data: { tools },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get single tool by slug
 * GET /api/tools/:slug
 */
export const getToolBySlug = async (req, res, next) => {
  try {
    const { slug } = req.params;
    
    const tool = await Tool.findOne({ slug, isActive: true })
      .populate('createdBy', 'name avatar');
    
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
 * Increment tool views
 * POST /api/tools/:slug/view
 */
export const incrementViews = async (req, res, next) => {
  try {
    const { slug } = req.params;
    
    const tool = await Tool.findOneAndUpdate(
      { slug, isActive: true },
      { $inc: { views: 1 } },
      { new: true }
    );
    
    if (!tool) {
      throw new ApiError(404, 'Tool not found');
    }
    
    res.json({
      success: true,
      data: { views: tool.views },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Like/Unlike a tool
 * POST /api/tools/:slug/like
 */
export const toggleLike = async (req, res, next) => {
  try {
    const { slug } = req.params;
    const userId = req.user.id;
    
    const tool = await Tool.findOne({ slug, isActive: true });
    if (!tool) {
      throw new ApiError(404, 'Tool not found');
    }
    
    const user = await User.findById(userId);
    const hasLiked = user.likedTools.includes(tool._id);
    
    if (hasLiked) {
      // Unlike
      await User.findByIdAndUpdate(userId, {
        $pull: { likedTools: tool._id },
      });
      tool.likes = Math.max(0, tool.likes - 1);
    } else {
      // Like
      await User.findByIdAndUpdate(userId, {
        $addToSet: { likedTools: tool._id },
      });
      tool.likes += 1;
    }
    
    await tool.save();
    
    res.json({
      success: true,
      data: {
        liked: !hasLiked,
        likes: tool.likes,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Save/Unsave a tool
 * POST /api/tools/:slug/save
 */
export const toggleSave = async (req, res, next) => {
  try {
    const { slug } = req.params;
    const userId = req.user.id;
    
    const tool = await Tool.findOne({ slug, isActive: true });
    if (!tool) {
      throw new ApiError(404, 'Tool not found');
    }
    
    const user = await User.findById(userId);
    const hasSaved = user.savedTools.includes(tool._id);
    
    if (hasSaved) {
      await User.findByIdAndUpdate(userId, {
        $pull: { savedTools: tool._id },
      });
    } else {
      await User.findByIdAndUpdate(userId, {
        $addToSet: { savedTools: tool._id },
      });
    }
    
    res.json({
      success: true,
      data: { saved: !hasSaved },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get tool categories with counts
 * GET /api/tools/categories
 */
export const getCategories = async (req, res, next) => {
  try {
    const categories = await Tool.aggregate([
      { $match: { isActive: true } },
      { $group: { _id: '$category', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);
    
    res.json({
      success: true,
      data: {
        categories: categories.map(c => ({
          name: c._id,
          count: c.count,
        })),
      },
    });
  } catch (error) {
    next(error);
  }
};

// Helper function to parse sort string
function parseSortString(sort) {
  const sortFields = sort.split(',');
  const sortObj = {};
  
  for (const field of sortFields) {
    if (field.startsWith('-')) {
      sortObj[field.slice(1)] = -1;
    } else {
      sortObj[field] = 1;
    }
  }
  
  return sortObj;
}

