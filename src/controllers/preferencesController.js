/**
 * The learned profile, as something the user can actually see and correct.
 *
 * The profile steers every workflow (retrieval ranking, the planner prompt,
 * and the workflow cache key — see ai/personalization.js), but until now it
 * was written only by LLM extraction and never shown. A wrong guess had no
 * correction path, which made the personalization both less accurate and
 * harder to trust than it needed to be.
 *
 * Edits made here are `source: 'user'`, which pins the typed fields so the
 * next extraction pass can't quietly undo them.
 */

import UserProfile from '../models/UserProfile.js';
import { loadProfile } from '../ai/memory.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('chat:preferences');

const SKILL_LEVELS = ['beginner', 'intermediate', 'advanced'];
const PRICING = ['free', 'paid', 'any'];

/** Lists the user manages directly — sent whole, so removal is just a shorter array. */
const EDITABLE_LISTS = ['toolsAlreadyUsing', 'preferredTools', 'rejectedTools', 'notes'];

const MAX_LIST_LENGTH = 30;

function serialize(profile) {
  return {
    allowExternalTools: profile?.allowExternalTools ?? false,
    skillLevel: profile?.skillLevel || null,
    pricingPreference: profile?.pricingPreference || null,
    industry: profile?.industry || null,
    toolsAlreadyUsing: profile?.toolsAlreadyUsing || [],
    preferredTools: profile?.preferredTools || [],
    rejectedTools: profile?.rejectedTools || [],
    notes: profile?.notes || [],
    // Lets the UI show which values the user set versus which we inferred.
    pinned: {
      skillLevel: profile?.pinned?.skillLevel ?? false,
      pricingPreference: profile?.pinned?.pricingPreference ?? false,
      industry: profile?.pinned?.industry ?? false,
    },
    estimateBias: profile?.estimateBias ?? null,
    onboardingDismissedAt: profile?.onboardingDismissedAt || null,
    /** True when we've learned nothing yet — drives the first-run setup card. */
    isEmpty: !(
      profile?.skillLevel ||
      profile?.pricingPreference ||
      profile?.industry ||
      profile?.toolsAlreadyUsing?.length
    ),
  };
}

/** GET /api/chat/preferences */
export const getPreferences = async (req, res) => {
  try {
    const profile = await loadProfile(req.user._id);
    res.json({ success: true, data: serialize(profile) });
  } catch (err) {
    log.error('Failed to load preferences', { error: err.message });
    res.status(500).json({ success: false, message: 'Could not load preferences.' });
  }
};

/**
 * PUT /api/chat/preferences
 *
 * Lists are replaced wholesale rather than patched: the UI removes a chip and
 * sends what's left, which keeps "delete this fact" from needing its own
 * endpoint and its own set of edge cases.
 */
export const updatePreferences = async (req, res) => {
  try {
    const body = req.body || {};

    let profile = await UserProfile.findOne({ user: req.user._id });
    if (!profile) profile = new UserProfile({ user: req.user._id });

    const facts = {};
    if (SKILL_LEVELS.includes(body.skillLevel)) facts.skillLevel = body.skillLevel;
    if (PRICING.includes(body.pricingPreference)) facts.pricingPreference = body.pricingPreference;
    if (typeof body.industry === 'string') facts.industry = body.industry.trim().slice(0, 80);
    if (typeof body.allowExternalTools === 'boolean') {
      facts.allowExternalTools = body.allowExternalTools;
    }

    // `applyFacts` only ever merges into lists, so a replacement has to be
    // assigned directly — otherwise removing a chip would be a no-op.
    for (const field of EDITABLE_LISTS) {
      if (!Array.isArray(body[field])) continue;
      profile[field] = [...new Set(body[field].map(v => String(v).slice(0, 240)))]
        .filter(Boolean)
        .slice(0, MAX_LIST_LENGTH);
    }

    // A tool can't be both preferred and avoided; the avoid list wins, since
    // it's the one the user is actively complaining about.
    if (Array.isArray(body.rejectedTools)) {
      const rejected = new Set(profile.rejectedTools);
      profile.preferredTools = profile.preferredTools.filter(s => !rejected.has(s));
    }

    if (Object.keys(facts).length) profile.applyFacts(facts, 'user');

    if (body.dismissOnboarding === true) profile.onboardingDismissedAt = new Date();

    await profile.save();
    res.json({ success: true, data: serialize(profile) });
  } catch (err) {
    log.error('Failed to update preferences', { error: err.message });
    res.status(500).json({ success: false, message: 'Could not save preferences.' });
  }
};

/**
 * DELETE /api/chat/preferences — forget everything we've learned.
 *
 * Unpins as well as clears: a reset that left the fields pinned would mean we
 * could never learn anything about this user again.
 */
export const resetPreferences = async (req, res) => {
  try {
    const profile = await UserProfile.findOne({ user: req.user._id });
    if (!profile) return res.json({ success: true, data: serialize(null) });

    profile.skillLevel = null;
    profile.pricingPreference = null;
    profile.industry = null;
    profile.toolsAlreadyUsing = [];
    profile.preferredTools = [];
    profile.rejectedTools = [];
    profile.notes = [];
    profile.pinned = { skillLevel: false, pricingPreference: false, industry: false };
    profile.estimateBias = null;
    profile.intakeAsks = [];
    profile.clarifyingQuestionsAsked = 0;

    await profile.save();
    log.info('Profile reset by user', { userId: String(req.user._id) });

    res.json({ success: true, data: serialize(profile) });
  } catch (err) {
    log.error('Failed to reset preferences', { error: err.message });
    res.status(500).json({ success: false, message: 'Could not reset preferences.' });
  }
};

export default { getPreferences, updatePreferences, resetPreferences };
