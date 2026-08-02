import mongoose from 'mongoose';
import slugify from 'slugify';
import { bus, EVENTS } from '../utils/events.js';

const toolSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Tool name is required'],
      trim: true,
      maxlength: [100, 'Name cannot exceed 100 characters'],
    },
    slug: {
      type: String,
      unique: true,
      lowercase: true,
    },
    tagline: {
      type: String,
      required: [true, 'Tagline is required'],
      maxlength: [200, 'Tagline cannot exceed 200 characters'],
    },
    description: {
      type: String,
      required: [true, 'Description is required'],
      maxlength: [5000, 'Description cannot exceed 5000 characters'],
    },
    logo: {
      type: String,
      default: null,
    },
    screenshot: {
      type: String,
      default: null,
    },
    websiteUrl: {
      type: String,
      required: [true, 'Website URL is required'],
    },
    category: {
      type: String,
      required: [true, 'Category is required'],
      lowercase: true,
      trim: true,
    },
    pricing: {
      type: String,
      enum: ['free', 'freemium', 'paid', 'contact'],
      default: 'freemium',
    },
    pricingDetails: {
      type: String,
      default: '',
    },
    features: [{
      type: String,
      trim: true,
    }],
    tags: [{
      type: String,
      trim: true,
      lowercase: true,
    }],
    // Metrics
    views: {
      type: Number,
      default: 0,
      min: 0,
    },
    likes: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Rating
    rating: {
      type: Number,
      default: 0,
      min: 0,
      max: 5,
    },
    reviewCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Status
    isFeatured: {
      type: Boolean,
      default: false,
    },
    isVerified: {
      type: Boolean,
      default: false,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    // Creator reference
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    // Social links
    socialLinks: {
      twitter: { type: String, default: '' },
      github: { type: String, default: '' },
      discord: { type: String, default: '' },
    },
    // YouTube videos
    youtubeVideos: [{
      videoId: { type: String, required: true },
      title: { type: String, default: '' },
      thumbnail: { type: String, default: '' },
    }],
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Indexes for faster queries
toolSchema.index({ category: 1 });
toolSchema.index({ pricing: 1 });
toolSchema.index({ isFeatured: 1 });
toolSchema.index({ tags: 1 });
toolSchema.index({ views: -1 });
toolSchema.index({ likes: -1 });
toolSchema.index({ rating: -1 });
toolSchema.index({ createdAt: -1 });
toolSchema.index({ name: 'text', tagline: 'text', description: 'text', tags: 'text' });

// Generate slug before saving
toolSchema.pre('save', function (next) {
  if (this.isModified('name')) {
    this.slug = slugify(this.name, { lower: true, strict: true });
  }
  next();
});

// Announce writes so the AI retrieval index can refresh itself.
// View/like counter bumps are excluded — they don't change what a tool *is*.
const announce = () => bus.emit(EVENTS.TOOL_CHANGED);
toolSchema.post('save', announce);
toolSchema.post('insertMany', announce);
toolSchema.post('deleteOne', announce);
toolSchema.post('deleteMany', announce);
toolSchema.post('findOneAndDelete', announce);
toolSchema.post('findOneAndUpdate', function () {
  const update = this.getUpdate() || {};
  const touched = Object.keys(update.$set || update).filter(k => !k.startsWith('$'));
  const onlyCounters = touched.length > 0 && touched.every(k => ['views', 'likes'].includes(k));
  const counterOnlyInc = update.$inc && Object.keys(update.$inc).every(k => ['views', 'likes'].includes(k));
  if (onlyCounters || (counterOnlyInc && !touched.length)) return;
  announce();
});

// Virtual for formatted views/likes
toolSchema.virtual('formattedViews').get(function () {
  return formatNumber(this.views);
});

toolSchema.virtual('formattedLikes').get(function () {
  return formatNumber(this.likes);
});

function formatNumber(num) {
  if (num === undefined || num === null) {
    return '0';
  }
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + 'M';
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(1) + 'K';
  }
  return num.toString();
}

const Tool = mongoose.model('Tool', toolSchema);

export default Tool;

