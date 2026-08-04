import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { getPlan, DEFAULT_PLAN_ID } from '../billing/plans.js';
import { addOneMonth, periodKeyFor } from '../billing/period.js';

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      minlength: [2, 'Name must be at least 2 characters'],
      maxlength: [50, 'Name cannot exceed 50 characters'],
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email'],
    },
    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: [8, 'Password must be at least 8 characters'],
      select: false,
    },
    role: {
      type: String,
      enum: ['user', 'admin'],
      default: 'user',
    },
    avatar: {
      type: String,
      default: null,
    },
    bio: {
      type: String,
      maxlength: [500, 'Bio cannot exceed 500 characters'],
      default: '',
    },
    savedTools: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tool',
    }],
    likedTools: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tool',
    }],
    isActive: {
      type: Boolean,
      default: true,
    },
    lastLogin: {
      type: Date,
      default: null,
    },

    /**
     * Subscription state, embedded rather than in its own collection.
     *
     * `authenticate` already loads the full user document on every request, so
     * embedding makes the plan and the remaining balance available to every
     * entitlement check for free. A separate collection would add a lookup to
     * the hot path of every metered endpoint and buy nothing, because the
     * history that would justify it lives in `UsageLedger` already.
     */
    subscription: {
      plan: {
        type: String,
        default: 'free',
        index: true,
      },
      status: {
        type: String,
        enum: ['active', 'past_due', 'cancelled', 'trialing'],
        default: 'active',
      },
      billingCycle: {
        type: String,
        enum: ['monthly', 'yearly'],
        default: 'monthly',
      },
      /** Start of the current allowance window. Credits reset when it rolls. */
      periodStart: { type: Date, default: Date.now },
      periodEnd: { type: Date, default: null },
      /**
       * "YYYY-MM" of `periodStart`. Compared against the current period on
       * every metered request to decide whether the allowance has rolled over
       * — cheaper and less clock-sensitive than re-deriving it from dates.
       */
      periodKey: { type: String, default: '' },
      /** Set when a plan is downgraded/ended at the period boundary. */
      cancelAtPeriodEnd: { type: Boolean, default: false },
      /** Admin who last changed the plan, since there's no gateway to blame. */
      assignedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null,
      },
      assignedAt: { type: Date, default: null },
      note: { type: String, maxlength: 500, default: '' },
    },

    /**
     * The credit allowance for the current period.
     *
     * `used` is incremented atomically under a balance condition (see
     * `billing/credits.js`) so two concurrent requests can't both spend the
     * last credit. Deriving the balance by summing the ledger instead would be
     * correct but needs an aggregation per request, and gives no way to make
     * the spend-and-check a single atomic operation.
     */
    credits: {
      /** Granted by the plan at the start of each period. */
      included: { type: Number, default: 0, min: 0 },
      /** Manually granted top-ups. Survive period rollover until spent. */
      bonus: { type: Number, default: 0, min: 0 },
      /** Spent this period. Reset to 0 on rollover. */
      used: { type: Number, default: 0 },
      /** Lifetime total, never reset — the number the admin table sorts on. */
      lifetimeUsed: { type: Number, default: 0, min: 0 },
      /**
       * The part of `used` that went past the allowance on on-demand terms.
       *
       * A subset of `used`, not a sibling of it — so the balance arithmetic
       * everywhere else stays "allowance minus used" and doesn't have to know
       * this exists. It is here so the amount owed can be recomputed from the
       * account at any time rather than trusted from a running total.
       */
      onDemandUsed: { type: Number, default: 0, min: 0 },
    },

    /**
     * Usage-based billing beyond the plan allowance.
     *
     * Off until the account turns it on. That is the whole point: a workflow on
     * a cron shouldn't start failing at 6am because an allowance ran out, but
     * nobody should ever discover they agreed to unbounded spend by reading an
     * invoice. See ON_DEMAND in `billing/plans.js`.
     *
     * There is no payment gateway. `accruedPaise` is an amount *owed*, settled
     * out of band; nothing in this codebase moves money.
     */
    onDemand: {
      enabled: { type: Boolean, default: false },
      /**
       * The user's own ceiling, in credits per period. 0 means "the plan's
       * limit is my limit". Always the tighter of the two applies.
       */
      capCredits: { type: Number, default: 0, min: 0 },
      /** Owed for the current period, in paise. Reset on rollover. */
      accruedPaise: { type: Number, default: 0, min: 0 },
      /** Never reset — what this account has run up in total. */
      lifetimePaise: { type: Number, default: 0, min: 0 },
      enabledAt: { type: Date, default: null },
    },

    /** Reminder preferences — used by Resend digests and Google/n8n runners. */
    reminders: {
      emailDigest: { type: Boolean, default: true },
      staleNudge: { type: Boolean, default: true },
      weeklySummary: { type: Boolean, default: true },
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Index for faster queries
userSchema.index({ role: 1 });

/**
 * Give every new account its plan's allowance and an open billing period.
 *
 * Done here rather than in the signup controller so that accounts created by
 * the seeder, by tests, or by any future import path all start in a valid
 * billing state. A user with `included: 0` isn't "on the free plan" — they're
 * a user who can't do anything and whose first request 402s for no reason.
 */
userSchema.pre('save', function (next) {
  if (!this.isNew) return next();

  const plan = getPlan(this.subscription?.plan || DEFAULT_PLAN_ID);
  const start = this.subscription?.periodStart || new Date();

  this.subscription.plan = plan.id;
  this.subscription.periodStart = start;
  this.subscription.periodEnd = addOneMonth(start);
  this.subscription.periodKey = periodKeyFor(start);

  if (!this.credits.included) this.credits.included = plan.credits;

  next();
});

// Hash password before saving
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  
  const salt = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// Compare password method
userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

// Remove password from JSON output
userSchema.methods.toJSON = function () {
  const user = this.toObject();
  delete user.password;
  return user;
};

const User = mongoose.model('User', userSchema);

export default User;

