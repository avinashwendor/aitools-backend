import mongoose from 'mongoose';

/**
 * Per-response feedback (like/dislike + optional reason).
 * Drives lightweight preference learning on UserProfile — not full RLHF training,
 * but enough to steer the next plan toward what this user actually wants.
 */
const messageFeedbackSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    sessionId: { type: String, required: true, maxlength: 120 },
    rating: { type: String, enum: ['like', 'dislike'], required: true },
    reason: { type: String, default: '', maxlength: 500 },
    intent: { type: String, default: '' },
    workflowId: { type: String, default: '' },
    toolSlugs: [{ type: String }],
    messageExcerpt: { type: String, default: '', maxlength: 400 },
  },
  { timestamps: true }
);

messageFeedbackSchema.index({ user: 1, createdAt: -1 });
messageFeedbackSchema.index({ user: 1, sessionId: 1 });

const MessageFeedback = mongoose.model('MessageFeedback', messageFeedbackSchema);

export default MessageFeedback;
