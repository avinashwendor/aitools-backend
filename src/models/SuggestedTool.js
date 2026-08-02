import mongoose from 'mongoose';

/**
 * A tool the assistant found via web search that isn't in our catalog yet.
 *
 * Never added to the live `Tool` collection automatically — surfaced to
 * admins for review/edit/approval first, so the public catalog stays
 * curated instead of silently filling with unverified web results. Approval
 * promotes this into a real `Tool` document; rejection just marks it closed
 * (kept for dedup — no point re-suggesting something an admin already
 * declined).
 */
const suggestedToolSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    /** Lowercased, protocol/www-stripped hostname — the real de-dup key. */
    domain: { type: String, required: true },
    websiteUrl: { type: String, required: true },
    tagline: { type: String, default: '', maxlength: 200 },
    description: { type: String, default: '', maxlength: 1000 },
    suggestedCategory: { type: String, default: '' },
    suggestedPricing: { type: String, enum: ['free', 'freemium', 'paid', 'contact', 'unknown'], default: 'unknown' },

    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },

    /** What the user was trying to build when this tool surfaced. */
    sourceQuery: { type: String, default: '', maxlength: 300 },
    sourceUrl: { type: String, default: '' },
    discoveredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    /** Set once approved and promoted — links back to the real catalog entry. */
    promotedTool: { type: mongoose.Schema.Types.ObjectId, ref: 'Tool', default: null },
  },
  { timestamps: true }
);

suggestedToolSchema.index({ domain: 1 }, { unique: true });

const SuggestedTool = mongoose.model('SuggestedTool', suggestedToolSchema);

export default SuggestedTool;
