import { Comment, Tool, User } from '../models/index.js';
import { ApiError } from '../middleware/errorHandler.js';

/**
 * Get comments for a tool
 * GET /api/tools/:slug/comments
 */
export const getComments = async (req, res, next) => {
  try {
    const { slug } = req.params;
    const { page = 1, limit = 10 } = req.query;
    
    const tool = await Tool.findOne({ slug, isActive: true });
    if (!tool) {
      throw new ApiError(404, 'Tool not found');
    }
    
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(50, Math.max(1, parseInt(limit, 10)));
    const skip = (pageNum - 1) * limitNum;
    
    // Get top-level comments only
    const [comments, totalCount] = await Promise.all([
      Comment.find({
        tool: tool._id,
        parentComment: null,
        isActive: true,
      })
        .sort('-createdAt')
        .skip(skip)
        .limit(limitNum)
        .populate('user', 'name avatar')
        .populate({
          path: 'replies',
          match: { isActive: true },
          populate: { path: 'user', select: 'name avatar' },
          options: { sort: { createdAt: 1 } },
        }),
      Comment.countDocuments({
        tool: tool._id,
        parentComment: null,
        isActive: true,
      }),
    ]);
    
    res.json({
      success: true,
      data: {
        comments,
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
 * Create a comment
 * POST /api/tools/:slug/comments
 */
export const createComment = async (req, res, next) => {
  try {
    const { slug } = req.params;
    const { content, rating, parentCommentId } = req.body;
    const userId = req.user.id;
    
    const tool = await Tool.findOne({ slug, isActive: true });
    if (!tool) {
      throw new ApiError(404, 'Tool not found');
    }
    
    // If it's a reply, verify parent comment exists
    if (parentCommentId) {
      const parentComment = await Comment.findOne({
        _id: parentCommentId,
        tool: tool._id,
        isActive: true,
      });
      if (!parentComment) {
        throw new ApiError(404, 'Parent comment not found');
      }
    }
    
    const comment = await Comment.create({
      content,
      rating: parentCommentId ? null : rating, // Only allow rating on top-level comments
      tool: tool._id,
      user: userId,
      parentComment: parentCommentId || null,
    });
    
    await comment.populate('user', 'name avatar');
    
    res.status(201).json({
      success: true,
      message: 'Comment added successfully',
      data: { comment },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Update a comment
 * PUT /api/comments/:id
 */
export const updateComment = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { content } = req.body;
    const userId = req.user.id;
    
    const comment = await Comment.findOne({ _id: id, isActive: true });
    if (!comment) {
      throw new ApiError(404, 'Comment not found');
    }
    
    // Check ownership
    if (comment.user.toString() !== userId && req.user.role !== 'admin') {
      throw new ApiError(403, 'Not authorized to edit this comment');
    }
    
    comment.content = content;
    comment.isEdited = true;
    await comment.save();
    
    await comment.populate('user', 'name avatar');
    
    res.json({
      success: true,
      message: 'Comment updated successfully',
      data: { comment },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Delete a comment
 * DELETE /api/comments/:id
 */
export const deleteComment = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    
    const comment = await Comment.findOne({ _id: id, isActive: true });
    if (!comment) {
      throw new ApiError(404, 'Comment not found');
    }
    
    // Check ownership
    if (comment.user.toString() !== userId && req.user.role !== 'admin') {
      throw new ApiError(403, 'Not authorized to delete this comment');
    }
    
    comment.isActive = false;
    await comment.save();
    
    // Also deactivate replies
    await Comment.updateMany(
      { parentComment: id },
      { isActive: false }
    );
    
    res.json({
      success: true,
      message: 'Comment deleted successfully',
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Like a comment
 * POST /api/comments/:id/like
 */
export const likeComment = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    
    const comment = await Comment.findOne({ _id: id, isActive: true });
    if (!comment) {
      throw new ApiError(404, 'Comment not found');
    }
    
    const hasLiked = comment.likedBy.includes(userId);
    
    if (hasLiked) {
      comment.likedBy.pull(userId);
      comment.likes = Math.max(0, comment.likes - 1);
    } else {
      comment.likedBy.push(userId);
      comment.likes += 1;
    }
    
    await comment.save();
    
    res.json({
      success: true,
      data: {
        liked: !hasLiked,
        likes: comment.likes,
      },
    });
  } catch (error) {
    next(error);
  }
};

