import mongoose from 'mongoose';

/**
 * Persisted chat memory.
 *
 * The previous implementation kept conversations in a module-level Map, which
 * meant every deploy or extra instance silently dropped the user's context.
 * This survives restarts, works behind a load balancer, and expires itself.
 */

const messageSchema = new mongoose.Schema(
  {
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, required: true, maxlength: 8000 },
    /** Slugs referenced by an assistant turn — cheap grounding for follow-ups. */
    toolSlugs: [{ type: String }],

    /**
     * The workflow this turn produced, as it was at that moment.
     *
     * Only `lastWorkflow` used to be kept, so a session that had been refined
     * held the v1 reply in its transcript and only the v2 graph on the canvas.
     * Reloading showed prose describing stages that no longer existed, and
     * there was nothing to diff against or roll back to — the diff was computed
     * on the way past and discarded.
     *
     * Stored per assistant turn rather than in a separate collection because
     * that is the granularity the transcript is read at, and a plan is a few KB
     * against a 16MB document limit.
     */
    workflow: { type: mongoose.Schema.Types.Mixed, default: undefined },
    /** What changed versus the previous version, for the "what moved" view. */
    workflowDiff: { type: mongoose.Schema.Types.Mixed, default: undefined },

    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const conversationSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    sessionId: { type: String, required: true },

    title: { type: String, default: 'New chat' },

    messages: { type: [messageSchema], default: [] },

    /**
     * Rolling summary of turns that have aged out of the live window.
     * Keeps long conversations coherent without unbounded prompt growth.
     */
    summary: { type: String, default: '' },

    /** The goal that produced the current workflow, used to ground refinements. */
    goal: { type: String, default: '' },

    /**
     * The enriched brief the user approved before the first plan: their goal
     * plus every intake answer, verbatim.
     *
     * Distinct from `goal`, which the router rewrites on every turn from the
     * last few messages. By the second refine the platforms, the feature list
     * and the audience the user spelled out at intake have been compressed out
     * of `goal` entirely, and the planner is left inferring them from the prior
     * plan's stage titles. This is written once, at approval, and never
     * overwritten — it is what the user actually asked for.
     */
    brief: { type: String, default: '' },

    /** Last workflow returned for this session, so "make it cheaper" has context. */
    lastWorkflow: { type: mongoose.Schema.Types.Mixed, default: null },

    /**
     * Intake state machine — ask clarifying questions before spending planner tokens,
     * then wait for explicit approval before generating the workflow.
     */
    clarificationState: {
      phase: { type: String, enum: ['asking', 'awaiting_approval', null], default: null },
      questions: { type: [mongoose.Schema.Types.Mixed], default: [] },
      answersText: { type: String, default: '' },
      enrichedGoal: { type: String, default: '' },
      baseGoal: { type: String, default: '' },
      /**
       * Routing overrides derived deterministically from the user's typed
       * intake answers (see ai/personalization.js). Carried across the
       * approval turn so the generated plan honours what they picked even if
       * the profile write failed.
       */
      intakeOverrides: { type: mongoose.Schema.Types.Mixed, default: {} },
      /** Raw `{questionId: answer}` map, so a reload can still show it back. */
      answers: { type: mongoose.Schema.Types.Mixed, default: {} },
      /** LLM briefing: what we already know vs still need before planning. */
      alreadyKnow: { type: [String], default: [] },
      stillNeed: { type: [String], default: [] },
      /**
       * The router's retrieval plan, carried across the approval turn.
       *
       * The router runs on the *intake* turn and produces goal-shaped search
       * queries and category domains. The approval turn that follows does the
       * actual planning, and used to rebuild its retrieval input from the
       * enriched goal — a string that is the goal with "User preferences:" and
       * the intake answers appended. Truncated to a query length, that reads
       * as "Launch a podcast\n\nUser preferences:\nWhat is your budget for…",
       * which retrieves against the wording of our own questions instead of
       * the user's goal, on the single most expensive call in the product.
       */
      searchQueries: { type: [String], default: [] },
      domains: { type: [String], default: [] },
    },

    turnCount: { type: Number, default: 0 },

    lastActivity: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

conversationSchema.index({ user: 1, sessionId: 1 }, { unique: true });

// Safety-net TTL (≈400 days). Plan-aware pruning in memory.js enforces
// Hobby (7d) / Pro (365d) / unlimited (Studio+) — this only catches abandoned accounts.
conversationSchema.index(
  { lastActivity: 1 },
  { expireAfterSeconds: 60 * 60 * 24 * 400 }
);

const Conversation = mongoose.model('Conversation', conversationSchema);

export default Conversation;
