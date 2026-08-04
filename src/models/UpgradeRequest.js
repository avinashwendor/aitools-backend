import mongoose from 'mongoose';

/**
 * Upgrade intent captured from the pricing page.
 *
 * With no payment gateway wired up, this is what a "Upgrade to Pro" click
 * actually produces: a queued request an admin reviews and fulfils by
 * assigning the plan. When a gateway is added later this model doesn't go
 * away — it becomes the pre-checkout record, which is where you look when
 * someone says they paid and the webhook says otherwise.
 */
const upgradeRequestSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    /** Plan the user asked for. */
    requestedPlan: {
      type: String,
      required: true,
    },

    /** What they were on when they asked — the upgrade path, for funnel analysis. */
    currentPlan: {
      type: String,
      required: true,
      default: 'free',
    },

    billingCycle: {
      type: String,
      enum: ['monthly', 'yearly'],
      default: 'monthly',
    },

    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'cancelled'],
      default: 'pending',
      index: true,
    },

    /**
     * Why they're upgrading. Populated automatically when the request comes
     * from an out-of-credits prompt, which is the highest-intent moment there
     * is and worth distinguishing from someone browsing the pricing page.
     */
    trigger: {
      type: String,
      enum: ['pricing_page', 'quota_exhausted', 'feature_locked', 'dashboard'],
      default: 'pricing_page',
    },

    /** Optional note from the user (team size, invoicing needs, questions). */
    note: {
      type: String,
      maxlength: 1000,
      default: '',
    },

    /** Contact details, so sales can act without another round trip. */
    contactEmail: { type: String, default: '' },
    company: { type: String, default: '', maxlength: 120 },

    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    reviewedAt: { type: Date, default: null },
    reviewNote: { type: String, maxlength: 1000, default: '' },
  },
  { timestamps: true }
);

// The admin queue: pending first, newest first.
upgradeRequestSchema.index({ status: 1, createdAt: -1 });

/**
 * One open request per user. A user clicking "Upgrade" four times should
 * produce one item in the admin queue, not four — the controller upserts
 * against this index rather than blindly inserting.
 */
upgradeRequestSchema.index(
  { user: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: 'pending' } }
);

const UpgradeRequest = mongoose.model('UpgradeRequest', upgradeRequestSchema);

export default UpgradeRequest;
