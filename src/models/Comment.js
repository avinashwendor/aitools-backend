import mongoose from 'mongoose';

const commentSchema = new mongoose.Schema(
  {
    content: {
      type: String,
      required: [true, 'Comment content is required'],
      trim: true,
      maxlength: [2000, 'Comment cannot exceed 2000 characters'],
    },
    tool: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tool',
      required: [true, 'Tool reference is required'],
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User reference is required'],
    },
    // Rating given with the comment (optional review)
    rating: {
      type: Number,
      min: 1,
      max: 5,
      default: null,
    },
    likes: {
      type: Number,
      default: 0,
      min: 0,
    },
    likedBy: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    }],
    // Parent comment for replies
    parentComment: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Comment',
      default: null,
    },
    isEdited: {
      type: Boolean,
      default: false,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Indexes
commentSchema.index({ tool: 1, createdAt: -1 });
commentSchema.index({ user: 1 });
commentSchema.index({ parentComment: 1 });

// Virtual for replies count
commentSchema.virtual('replies', {
  ref: 'Comment',
  localField: '_id',
  foreignField: 'parentComment',
});

// Update tool rating when a rating is given
commentSchema.post('save', async function () {
  if (this.rating) {
    await updateToolRating(this.tool);
  }
});

commentSchema.post('remove', async function () {
  if (this.rating) {
    await updateToolRating(this.tool);
  }
});

async function updateToolRating(toolId) {
  const Tool = mongoose.model('Tool');
  const Comment = mongoose.model('Comment');
  
  const result = await Comment.aggregate([
    { $match: { tool: toolId, rating: { $ne: null }, isActive: true } },
    {
      $group: {
        _id: '$tool',
        avgRating: { $avg: '$rating' },
        count: { $sum: 1 },
      },
    },
  ]);
  
  if (result.length > 0) {
    await Tool.findByIdAndUpdate(toolId, {
      rating: Math.round(result[0].avgRating * 10) / 10,
      reviewCount: result[0].count,
    });
  } else {
    await Tool.findByIdAndUpdate(toolId, {
      rating: 0,
      reviewCount: 0,
    });
  }
}

const Comment = mongoose.model('Comment', commentSchema);

export default Comment;

