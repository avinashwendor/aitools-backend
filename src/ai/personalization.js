/**
 * How a user's profile changes the output.
 *
 * Previously this logic didn't exist as a layer at all: the profile was
 * stringified into the planner prompt (see prompts.js `plannerProfileBlock`)
 * and nothing else. That left two holes big enough to make personalization
 * decorative:
 *
 *   1. The workflow cache was keyed on the goal alone, so the first user to
 *      ask "make a youtube video" fixed the answer for everyone who asked
 *      after them — including users whose profile said to avoid a tool in it.
 *   2. Retrieval never saw the profile, so a tool the user explicitly prefers
 *      could be ranked out of the candidate slate before the planner ever got
 *      a chance to honour the prompt instruction to prefer it.
 *
 * Everything here is deterministic — no model calls. A profile is a fact you
 * look up, not a fact you approximate.
 */

import crypto from 'crypto';
import { INTAKE_DECAY_DAYS } from '../models/UserProfile.js';

/** Profile fields that genuinely change the generated workflow. */
const OUTPUT_AFFECTING_LISTS = ['preferredTools', 'rejectedTools', 'toolsAlreadyUsing'];

/** Notes are free text and grow unbounded; only the freshest ones reach a prompt. */
const NOTES_IN_FINGERPRINT = 4;

const sortedList = value =>
  Array.isArray(value) ? [...new Set(value.map(String))].sort() : [];

/**
 * Stable short hash of the parts of a profile that change the output.
 *
 * Used as a cache-key component so two users only share a cached workflow when
 * the plan would genuinely have been identical for both. Deliberately narrow:
 * including volatile fields (`lastUpdated`, ask counters) would drop the hit
 * rate to zero without changing a single generated plan.
 *
 * Returns `'anon'` for an empty or absent profile, so the large population of
 * users we've learned nothing about keeps sharing one cache entry.
 */
export function profileFingerprint(profile) {
  if (!profile) return 'anon';

  const parts = [
    profile.skillLevel || '',
    profile.pricingPreference || '',
    profile.industry || '',
    ...OUTPUT_AFFECTING_LISTS.map(field => sortedList(profile[field]).join(',')),
    sortedList(profile.notes).slice(-NOTES_IN_FINGERPRINT).join('|'),
    // Bias changes the time estimates the planner is told to produce.
    profile.estimateBias ? Number(profile.estimateBias).toFixed(2) : '',
  ];

  if (parts.every(p => !p)) return 'anon';

  return crypto.createHash('sha256').update(parts.join('~')).digest('hex').slice(0, 12);
}

/**
 * Ranking signals for the retriever.
 *
 * Kept separate from the prompt block because they do different jobs: the
 * prompt tells the planner how to choose between candidates, these decide
 * which candidates it gets to see at all.
 *
 * @returns {{preferred: string[], rejected: string[], owned: string[]}}
 */
export function retrievalSignals(profile) {
  if (!profile) return { preferred: [], rejected: [], owned: [] };

  const preferred = sortedList(profile.preferredTools);
  const rejected = sortedList(profile.rejectedTools);
  const rejectedSet = new Set(rejected);

  return {
    // An explicit rejection outranks a stale positive signal — a tool the user
    // liked in March and rejected in June must not still be boosted.
    preferred: preferred.filter(slug => !rejectedSet.has(slug)),
    rejected,
    owned: sortedList(profile.toolsAlreadyUsing).filter(slug => !rejectedSet.has(slug)),
  };
}

// ─────────────────────────────────────────────────────────────
// Intake throttling
// ─────────────────────────────────────────────────────────────

/** Standin domain for goals the router couldn't categorise. */
export const GENERAL_DOMAIN = '_general';

/**
 * Have we already asked this user enough about this domain, recently enough
 * that asking again would be nagging?
 *
 * Pure function over a lean profile object — the previous global counter
 * silenced intake permanently after three asks, so a user who built three
 * video workflows in 2025 would never be asked anything about a web app in
 * 2026. Scoped per domain and decayed, the cap throttles repetition without
 * ever becoming permanent.
 */
export function hasExhaustedIntake(profile, domain, max) {
  if (!profile) return false;

  const key = domain || GENERAL_DOMAIN;
  const entry = (profile.intakeAsks || []).find(a => a.domain === key);
  if (!entry) return false;

  const ageDays = (Date.now() - new Date(entry.lastAskedAt).getTime()) / 86_400_000;
  if (ageDays > INTAKE_DECAY_DAYS) return false;

  return (entry.count || 0) >= max;
}

// ─────────────────────────────────────────────────────────────
// Intake answers → profile facts
// ─────────────────────────────────────────────────────────────

/**
 * The intake questions are multiple choice with known ids (see
 * `buildDefaultIntakeQuestions` in workflowEngine.js), so their answers are
 * structured data. Reading them directly beats sending the answers back
 * through an LLM extraction pass that can only guess at what the user already
 * told us explicitly.
 *
 * Unknown ids and free-text answers are ignored here — `updateProfileFromTurn`
 * still runs afterwards and can extract from those.
 */
const ANSWER_MAP = {
  budget: {
    fact: 'pricingPreference',
    override: 'pricing',
    values: {
      'free only': 'free',
      'freemium is ok': 'any',
      'freemium ok': 'any',
      'paid tools are fine': 'paid',
      'paid is fine': 'paid',
    },
  },
  skill: {
    fact: 'skillLevel',
    override: 'skill',
    values: {
      beginner: 'beginner',
      intermediate: 'intermediate',
      advanced: 'advanced',
    },
  },
};

/** Answers worth remembering as a standing preference rather than a typed field. */
const NOTE_QUESTIONS = {
  approach: answer => `Prefers this working style: ${answer}`,
  priority: answer => `Optimises for: ${answer}`,
  constraints: answer => answer,
};

const normalise = value => String(value ?? '').trim().toLowerCase();

/**
 * @param {Record<string, string>} answers  `{questionId: chosenOption}`
 * @returns {{facts: object, overrides: {pricing?: string, skill?: string}}}
 *   `facts` merges into UserProfile; `overrides` applies to the routed request
 *   for this turn, so the plan honours the answers immediately rather than
 *   only from the next workflow onward.
 */
export function factsFromIntakeAnswers(answers) {
  const facts = {};
  const overrides = {};
  const notes = [];

  if (!answers || typeof answers !== 'object') return { facts, overrides };

  for (const [id, rawAnswer] of Object.entries(answers)) {
    const answer = String(rawAnswer ?? '').trim();
    if (!answer) continue;

    const mapping = ANSWER_MAP[id];
    if (mapping) {
      const value = mapping.values[normalise(answer)];
      if (value) {
        facts[mapping.fact] = value;
        overrides[mapping.override] = value;
      }
      continue;
    }

    const toNote = NOTE_QUESTIONS[id];
    if (toNote) notes.push(toNote(answer).slice(0, 240));
  }

  // UserProfile.applyFacts takes one note per call, so collapse them into one
  // durable line rather than dropping all but the last.
  if (notes.length) facts.note = notes.join('; ').slice(0, 240);

  return { facts, overrides };
}

export default {
  profileFingerprint,
  retrievalSignals,
  hasExhaustedIntake,
  factsFromIntakeAnswers,
  GENERAL_DOMAIN,
};
