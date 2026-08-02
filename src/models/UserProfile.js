import mongoose from 'mongoose';

/**
 * Long-term, cross-session memory about a user — durable facts the router
 * should already know rather than re-ask every time a workflow is requested.
 *
 * Deliberately structured fields, not embeddings: "budget: free-only" is a
 * fact you look up, not a fact you approximate by similarity. (Fuzzier,
 * semantic cross-session recall lives separately in Qdrant's `memory_facts`
 * collection — see ai/vectorStore.js — for things that don't fit a field.)
 *
 * One document per user, upserted incrementally as facts are learned —
 * never wiped, only added to or corrected.
 */
const userProfileSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },

    skillLevel: { type: String, enum: ['beginner', 'intermediate', 'advanced', null], default: null },
    pricingPreference: { type: String, enum: ['free', 'paid', 'any', null], default: null },
    industry: { type: String, default: null, maxlength: 80 },

    /** Tools the user has told us they already use — steer the planner away from re-suggesting them as "new." */
    toolsAlreadyUsing: [{ type: String, maxlength: 60 }],

    /** Preference for whether web-search-discovered tools outside our catalog may be suggested. */
    allowExternalTools: { type: Boolean, default: false },

    /** Freeform durable facts that don't fit a typed field, capped so this can't grow unbounded. */
    notes: [{ type: String, maxlength: 240 }],

    /** How many times we've asked a clarifying question — used to taper off over time. */
    clarifyingQuestionsAsked: { type: Number, default: 0 },

    lastUpdated: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

const MAX_NOTES = 20;
const MAX_TOOLS = 30;

userProfileSchema.methods.applyFacts = function applyFacts(facts = {}) {
  if (facts.skillLevel && ['beginner', 'intermediate', 'advanced'].includes(facts.skillLevel)) {
    this.skillLevel = facts.skillLevel;
  }
  if (facts.pricingPreference && ['free', 'paid', 'any'].includes(facts.pricingPreference)) {
    this.pricingPreference = facts.pricingPreference;
  }
  if (facts.industry) this.industry = String(facts.industry).slice(0, 80);

  if (Array.isArray(facts.toolsAlreadyUsing)) {
    const merged = new Set([...this.toolsAlreadyUsing, ...facts.toolsAlreadyUsing.map(String)]);
    this.toolsAlreadyUsing = [...merged].slice(-MAX_TOOLS);
  }

  if (typeof facts.allowExternalTools === 'boolean') this.allowExternalTools = facts.allowExternalTools;

  if (facts.note) {
    this.notes = [...this.notes, String(facts.note).slice(0, 240)].slice(-MAX_NOTES);
  }

  this.lastUpdated = new Date();
};

const UserProfile = mongoose.model('UserProfile', userProfileSchema);

export default UserProfile;
