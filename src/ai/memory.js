/**
 * Conversation memory + context engineering.
 *
 * Keeps a bounded working window of recent turns and compacts everything
 * older into a rolling summary, so a 40-turn session costs roughly the same
 * prompt budget as a 6-turn one while still remembering what was decided.
 */

import Conversation from '../models/Conversation.js';
import User from '../models/User.js';
import UserProfile from '../models/UserProfile.js';
import config from '../config/index.js';
import { complete } from './llm.js';
import { upsertMemoryFact, searchMemoryFacts } from './vectorStore.js';
import { planAllows, planLimit, DEFAULT_PLAN_ID } from '../billing/plans.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('ai:memory');

/** Turns kept verbatim; anything older gets folded into `summary`. */
const WINDOW = config.ai.memoryTurns * 2;

/** Compact once the transcript grows meaningfully past the window. */
const COMPACT_AT = WINDOW + 6;

export async function loadConversation(userId, sessionId) {
  const key = { user: userId, sessionId: sessionId || 'default' };
  let convo = await Conversation.findOne(key).lean();

  if (!convo) {
    convo = {
      ...key,
      title: 'New chat',
      messages: [],
      summary: '',
      goal: '',
      brief: '',
      lastWorkflow: null,
      clarificationState: null,
      turnCount: 0,
    };
  }

  return convo;
}

/**
 * Build the message array sent to the model: relevant cross-session recall
 * (if any), the rolling summary (if any), then the live window of recent
 * turns.
 *
 * @param {object} convo
 * @param {Array<{sessionId:string, summary:string}>} [opts.recalled] from `recallRelatedSessions`
 */
export function buildContextMessages(convo, { recalled = [] } = {}) {
  const messages = [];

  if (recalled.length) {
    messages.push({
      role: 'system',
      content:
        `Relevant context from an earlier, different conversation with this same user ` +
        `(only use this if it's actually relevant to the current message):\n` +
        recalled.map(r => `- ${r.summary}`).join('\n'),
    });
  }

  if (convo.summary) {
    messages.push({
      role: 'system',
      content:
        `Earlier in this conversation (summary):\n${convo.summary}\n\n` +
        (convo.goal ? `The user's active goal is: "${convo.goal}".` : ''),
    });
  }

  const recent = (convo.messages || []).slice(-WINDOW);
  for (const m of recent) {
    messages.push({ role: m.role, content: m.content });
  }

  return messages;
}

/**
 * Persist a completed turn and compact the transcript when it outgrows
 * the working window.
 */
export async function appendTurn(userId, sessionId, {
  userMessage,
  assistantMessage,
  toolSlugs = [],
  goal,
  brief,
  workflow,
  workflowDiff,
  title,
}) {
  const key = { user: userId, sessionId: sessionId || 'default' };

  const push = [];
  if (userMessage) push.push({ role: 'user', content: userMessage.slice(0, 8000) });
  if (assistantMessage) {
    push.push({
      role: 'assistant',
      content: assistantMessage.slice(0, 8000),
      toolSlugs,
      // Pinned to the turn that produced it, so the transcript and the canvas
      // can never describe two different plans.
      ...(workflow ? { workflow, workflowDiff: workflowDiff || undefined } : {}),
    });
  }

  const update = {
    $push: { messages: { $each: push } },
    $inc: { turnCount: 1 },
    $set: { lastActivity: new Date() },
  };

  if (goal) update.$set.goal = goal;
  if (workflow !== undefined) update.$set.lastWorkflow = workflow;
  if (title) update.$set.title = title.slice(0, 120);

  const convo = await Conversation.findOneAndUpdate(key, update, {
    upsert: true,
    new: true,
    setDefaultsOnInsert: true,
  }).lean();

  // Written once, and only when empty. A later turn's routed goal must not
  // overwrite what the user approved at intake — that erasure is the whole
  // reason this field exists. `$setOnInsert` would not do: by the approval turn
  // the conversation already exists, created when the questions were asked.
  if (brief && !convo.brief) {
    await Conversation.updateOne(
      { ...key, $or: [{ brief: '' }, { brief: { $exists: false } }] },
      { $set: { brief: brief.slice(0, 2000) } }
    );
  }

  if (convo.messages.length > COMPACT_AT) {
    // Fire-and-forget: compaction must never add latency to the user's turn.
    compact(key, convo).catch(err => log.warn('Compaction failed', { error: err.message }));
  }

  return convo;
}

/** Fold aged-out turns into the rolling summary. */
async function compact(key, convo) {
  const overflow = convo.messages.slice(0, convo.messages.length - WINDOW);
  if (!overflow.length) return;

  const transcript = overflow
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 600)}`)
    .join('\n');

  let summary = convo.summary;

  try {
    const { content } = await complete({
      task: 'memory:compact',
      // Dense compression, not judgment — the cheapest tier tuned for
      // long-context summarisation, kept separate from routing/classification
      // so it can be swapped or billed independently of `fast`.
      role: 'utility',
      temperature: 0.2,
      maxTokens: 700,
      messages: [
        {
          role: 'system',
          content:
            'You compress conversation history for an AI-tool workflow assistant. ' +
            'Write at most 8 short bullet points capturing: what the user is building, ' +
            'constraints they stated (budget, skill level, platform, deadline), tools already ' +
            'chosen or rejected, and any decisions made. Facts only, no filler. ' +
            'Never drop a stated constraint (platform, budget, skill, rejected tools) to save space.',
        },
        {
          role: 'user',
          content:
            (convo.summary ? `Existing summary:\n${convo.summary}\n\n` : '') +
            `New turns to fold in:\n${transcript}`,
        },
      ],
    });
    summary = content.trim();
  } catch (err) {
    log.warn('Summary generation failed — truncating without summary', { error: err.message });
  }

  const finalSummary = summary.slice(0, 4000);

  await Conversation.updateOne(key, {
    $set: {
      summary: finalSummary,
      messages: convo.messages.slice(-WINDOW),
    },
  });

  // Cross-session memory facts are a Pro+ feature — skip writes on Hobby.
  const owner = await User.findById(key.user).select('subscription.plan').lean();
  const planId = owner?.subscription?.plan || DEFAULT_PLAN_ID;
  if (planAllows(planId, 'memoryRecall')) {
    upsertMemoryFact({ userId: key.user, sessionId: key.sessionId, summary: finalSummary })
      .catch(err => log.warn('Failed to upsert memory fact after compaction', { error: err.message }));
  }

  log.debug('Conversation compacted', { kept: WINDOW, folded: overflow.length });
}

/**
 * Replace the stored workflow without recording a conversational turn.
 *
 * Regenerating one stage's playbook changes the workflow but isn't a turn —
 * routing it through `appendTurn` would inflate `turnCount` and bring the
 * compaction window forward for something the user never said.
 */
export async function updateLastWorkflow(userId, sessionId, workflow) {
  await Conversation.updateOne(
    { user: userId, sessionId: sessionId || 'default' },
    { $set: { lastWorkflow: workflow, lastActivity: new Date() } }
  );
}

export async function clearConversation(userId, sessionId) {
  await Conversation.deleteOne({ user: userId, sessionId: sessionId || 'default' });
}

/**
 * Delete conversations older than the plan's sessionRetentionDays.
 * A limit of 0 means unlimited (no prune for that user).
 * @returns {Promise<number>} deleted count
 */
export async function pruneExpiredSessionsForUser(userId, planId) {
  const days = planLimit(planId, 'sessionRetentionDays');
  if (!days || days <= 0) return 0;
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const result = await Conversation.deleteMany({
    user: userId,
    lastActivity: { $lt: cutoff },
  });
  return result.deletedCount || 0;
}

/**
 * Nightly / hourly sweep across all users with finite retention.
 * @returns {Promise<number>} total deleted
 */
export async function pruneAllExpiredSessions() {
  const users = await User.find({
    'subscription.plan': { $exists: true },
  })
    .select('_id subscription.plan')
    .lean();

  let total = 0;
  for (const u of users) {
    const planId = u.subscription?.plan || DEFAULT_PLAN_ID;
    if (planLimit(planId, 'sessionRetentionDays') <= 0) continue;
    total += await pruneExpiredSessionsForUser(u._id, planId);
  }
  return total;
}

export async function listConversations(userId, limit = 30) {
  const user = await User.findById(userId).select('subscription.plan').lean();
  const planId = user?.subscription?.plan || DEFAULT_PLAN_ID;
  await pruneExpiredSessionsForUser(userId, planId).catch(err =>
    log.warn('Session prune on list failed', { error: err.message })
  );

  return Conversation.find({ user: userId })
    .select('sessionId title goal turnCount lastActivity updatedAt lastWorkflow')
    .sort({ lastActivity: -1 })
    .limit(limit)
    .lean()
    .then(rows => rows.map(r => ({
      sessionId: r.sessionId,
      title: r.title,
      goal: r.goal,
      turnCount: r.turnCount,
      lastActivity: r.lastActivity,
      updatedAt: r.updatedAt,
      hasWorkflow: Boolean(r.lastWorkflow),
      workflowTitle: r.lastWorkflow?.title || null,
    })));
}

// ─────────────────────────────────────────────────────────────
// Long-term memory: structured profile
// ─────────────────────────────────────────────────────────────

/** Read-only projection for prompt injection — never mutate the returned object. */
export async function loadProfile(userId) {
  const profile = await UserProfile.findOne({ user: userId }).lean();
  return profile || null;
}

/**
 * Merge newly-learned facts into a user's long-term profile. Safe to call
 * with an empty/no-op `facts` object — upserts so the first call creates it.
 *
 * @param {'inferred'|'user'} [source] see `UserProfile.applyFacts` — an
 *   inferred fact never overwrites a field the user pinned in Settings.
 */
export async function updateProfileFacts(userId, facts, source = 'inferred') {
  if (!facts || !Object.keys(facts).length) return;

  let profile = await UserProfile.findOne({ user: userId });
  if (!profile) profile = new UserProfile({ user: userId });

  profile.applyFacts(facts, source);
  await profile.save();
  return profile;
}

/**
 * Record that we asked intake questions about a domain. Scoped per domain so
 * a user who has been asked about "video" three times still gets a proper
 * intake the first time they ask about "web development".
 */
export async function recordIntakeAsk(userId, domain) {
  let profile = await UserProfile.findOne({ user: userId });
  if (!profile) profile = new UserProfile({ user: userId });

  profile.recordIntakeAsk(domain);
  await profile.save();
  return profile;
}

export async function saveClarificationState(userId, sessionId, state) {
  await Conversation.updateOne(
    { user: userId, sessionId: sessionId || 'default' },
    { $set: { clarificationState: state, lastActivity: new Date() } },
    { upsert: true }
  );
}

export async function clearClarificationState(userId, sessionId) {
  await Conversation.updateOne(
    { user: userId, sessionId: sessionId || 'default' },
    {
      $set: {
        clarificationState: {
          phase: null,
          questions: [],
          answersText: '',
          enrichedGoal: '',
          baseGoal: '',
          intakeOverrides: {},
          answers: {},
          alreadyKnow: [],
          stillNeed: [],
        },
      },
    }
  );
}

// ─────────────────────────────────────────────────────────────
// Long-term memory: semantic recall across sessions (Qdrant)
// ─────────────────────────────────────────────────────────────

/**
 * Surfaces relevant context from a *different* past session — the gist of it
 * aged out of that session's own rolling summary window a long time ago, so
 * this is the only way a brand-new session can know about it.
 * Always safe to call: returns [] if Qdrant isn't configured/reachable.
 */
export async function recallRelatedSessions({ userId, sessionId, goal, limit = 3 }) {
  if (!goal) return [];
  try {
    return await searchMemoryFacts(goal, userId, { limit, excludeSessionId: sessionId });
  } catch (err) {
    log.warn('Semantic recall failed', { error: err.message });
    return [];
  }
}

export default {
  loadConversation,
  buildContextMessages,
  appendTurn,
  updateLastWorkflow,
  clearConversation,
  listConversations,
  pruneExpiredSessionsForUser,
  pruneAllExpiredSessions,
  loadProfile,
  updateProfileFacts,
  recordIntakeAsk,
  saveClarificationState,
  clearClarificationState,
  recallRelatedSessions,
};
