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

    /** Tools the user has positively rated in workflows — bias the planner toward these. */
    preferredTools: [{ type: String, maxlength: 60 }],

    /** Tools the user rejected or disliked — steer the planner away from these. */
    rejectedTools: [{ type: String, maxlength: 60 }],

    /** Freeform durable facts that don't fit a typed field, capped so this can't grow unbounded. */
    notes: [{ type: String, maxlength: 240 }],

    /**
     * Fields the user set themselves in Settings. A pinned field is never
     * overwritten by LLM extraction — otherwise correcting a wrong guess is
     * pointless, because the next turn's `updateProfileFromTurn` silently
     * puts the wrong value back.
     */
    pinned: {
      skillLevel: { type: Boolean, default: false },
      pricingPreference: { type: Boolean, default: false },
      industry: { type: Boolean, default: false },
    },

    /**
     * How many times we've asked clarifying questions, per routed domain.
     * Replaces a single global counter that permanently silenced intake after
     * three asks — including for a brand-new domain a year later.
     */
    intakeAsks: [
      {
        _id: false,
        domain: { type: String, maxlength: 60 },
        count: { type: Number, default: 0 },
        lastAskedAt: { type: Date, default: Date.now },
      },
    ],

    /** Superseded by `intakeAsks`; kept readable for one release. */
    clarifyingQuestionsAsked: { type: Number, default: 0 },

    /**
     * Median ratio of actual to estimated time across completed workflow
     * stages. Multiplies displayed estimates so the plan is honest for THIS
     * user rather than for an average one. Null until enough samples exist.
     */
    estimateBias: { type: Number, default: null, min: 0.25, max: 4 },

    /** Set when the user completes or skips first-run personalization setup. */
    onboardingDismissedAt: { type: Date, default: null },

    lastUpdated: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

const MAX_NOTES = 20;
const MAX_TOOLS = 30;

/**
 * Merge learned facts into the profile.
 *
 * @param {object} facts
 * @param {'inferred'|'user'} [source] `'inferred'` (the default) comes from an
 *   LLM extraction or a feedback signal and must not clobber a field the user
 *   pinned by editing it in Settings. `'user'` is an explicit edit and pins
 *   the typed fields it touches.
 */
userProfileSchema.methods.applyFacts = function applyFacts(facts = {}, source = 'inferred') {
  const isUserEdit = source === 'user';
  const canWrite = field => isUserEdit || !this.pinned?.[field];

  if (
    facts.skillLevel &&
    ['beginner', 'intermediate', 'advanced'].includes(facts.skillLevel) &&
    canWrite('skillLevel')
  ) {
    this.skillLevel = facts.skillLevel;
    if (isUserEdit) this.pinned.skillLevel = true;
  }
  if (
    facts.pricingPreference &&
    ['free', 'paid', 'any'].includes(facts.pricingPreference) &&
    canWrite('pricingPreference')
  ) {
    this.pricingPreference = facts.pricingPreference;
    if (isUserEdit) this.pinned.pricingPreference = true;
  }
  if (facts.industry && canWrite('industry')) {
    this.industry = String(facts.industry).slice(0, 80);
    if (isUserEdit) this.pinned.industry = true;
  }

  if (Array.isArray(facts.toolsAlreadyUsing)) {
    const merged = new Set([...this.toolsAlreadyUsing, ...facts.toolsAlreadyUsing.map(String)]);
    this.toolsAlreadyUsing = [...merged].slice(-MAX_TOOLS);
  }

  if (typeof facts.allowExternalTools === 'boolean') this.allowExternalTools = facts.allowExternalTools;

  // Preferring and rejecting the same tool would put "prefer X" and "never
  // suggest X" in one prompt, so the newer signal always evicts the older.
  if (Array.isArray(facts.preferredTools)) {
    const added = facts.preferredTools.map(String);
    const merged = new Set([...this.preferredTools, ...added]);
    this.preferredTools = [...merged].slice(-MAX_TOOLS);
    this.rejectedTools = this.rejectedTools.filter(slug => !added.includes(slug));
  }

  if (Array.isArray(facts.rejectedTools)) {
    const added = facts.rejectedTools.map(String);
    const merged = new Set([...this.rejectedTools, ...added]);
    this.rejectedTools = [...merged].slice(-MAX_TOOLS);
    this.preferredTools = this.preferredTools.filter(slug => !added.includes(slug));
  }

  if (facts.note) {
    this.notes = [...this.notes, String(facts.note).slice(0, 240)].slice(-MAX_NOTES);
  }

  this.lastUpdated = new Date();
};

/**
 * Ask counts older than this stop suppressing intake — goals change.
 * The read-side check lives in ai/personalization.js as a pure function,
 * because `loadProfile` returns a lean object with no methods on it.
 */
export const INTAKE_DECAY_DAYS = 90;

userProfileSchema.methods.recordIntakeAsk = function recordIntakeAsk(domain) {
  const key = domain || '_general';
  const entry = (this.intakeAsks || []).find(a => a.domain === key);

  if (!entry) {
    this.intakeAsks.push({ domain: key, count: 1, lastAskedAt: new Date() });
    return;
  }

  // A stale entry restarts rather than resuming, so a user who returns after
  // a year gets the full intake again instead of one question.
  const ageDays = (Date.now() - new Date(entry.lastAskedAt).getTime()) / 86_400_000;
  entry.count = ageDays > INTAKE_DECAY_DAYS ? 1 : entry.count + 1;
  entry.lastAskedAt = new Date();
};

const UserProfile = mongoose.model('UserProfile', userProfileSchema);

export default UserProfile;
