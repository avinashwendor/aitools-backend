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
    },

    turnCount: { type: Number, default: 0 },

    lastActivity: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

conversationSchema.index({ user: 1, sessionId: 1 }, { unique: true });

// TTL index — Mongo reaps abandoned conversations automatically.
conversationSchema.index(
  { lastActivity: 1 },
  { expireAfterSeconds: 60 * 60 * 24 * 30 }
);

const Conversation = mongoose.model('Conversation', conversationSchema);

export default Conversation;
