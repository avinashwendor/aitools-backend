import mongoose from 'mongoose';

/**
 * One architect session: the model working out how to build a workflow.
 *
 * This is separate from `AgentRun` because it is a different kind of thing. A
 * run executes a graph that already exists; a build *produces* the graph, and
 * what matters about it is the reasoning — which APIs it looked at, which docs
 * it read, why it chose the endpoint it chose, and what it still needs from the
 * user. None of that has anywhere to live on a run.
 *
 * The timeline is stored as an append-only event list rather than as prose,
 * because it is rendered as a live feed while the build is happening and as a
 * transcript afterwards, and those want the same data. Writing it as the
 * architect goes is also what lets a browser that reconnects mid-build catch up
 * rather than watch the rest of a story it missed the start of.
 */

const eventSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    /**
     * One of: thought, search, read, catalog, plan, requirement, graph, test,
     * note, error. Deliberately open-ended — the renderer falls back to a
     * generic row for anything it doesn't recognise, so adding an event kind on
     * the server never breaks a browser running yesterday's bundle.
     */
    type: { type: String, required: true, maxlength: 40 },
    title: { type: String, default: '', maxlength: 300 },
    detail: { type: String, default: '', maxlength: 4000 },
    url: { type: String, default: '', maxlength: 1000 },
    ok: { type: Boolean, default: true },
    meta: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { _id: false }
);

const agentBuildSchema = new mongoose.Schema(
  {
    workflow: { type: mongoose.Schema.Types.ObjectId, ref: 'AgentWorkflow', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    status: {
      type: String,
      enum: ['queued', 'running', 'succeeded', 'failed', 'canceled', 'awaiting_clarification'],
      default: 'queued',
      index: true,
    },

    /** What the user asked for, verbatim. */
    goal: { type: String, default: '', maxlength: 4000 },

    /**
     * Structured intake questions when status is `awaiting_clarification`.
     * Same shape as chat ClarifyingQuestions: { id, question, type, options? }.
     */
    clarifyingQuestions: {
      type: [
        new mongoose.Schema(
          {
            id: { type: String, required: true, maxlength: 40 },
            question: { type: String, required: true, maxlength: 240 },
            type: { type: String, enum: ['choice', 'text'], default: 'choice' },
            options: { type: [String], default: undefined },
          },
          { _id: false }
        ),
      ],
      default: [],
    },

    /**
     * Set when the user answered an intake round — the next session may build
     * without calling ask_clarifying again for the same unknowns.
     */
    clarificationSatisfied: { type: Boolean, default: false },

    /**
     * Why this build ran. `build` is the first pass, `edit` is a follow-up
     * request, `repair` is the architect fixing a run that failed — they share
     * every mechanism and differ only in the prompt they open with.
     */
    intent: { type: String, enum: ['build', 'edit', 'repair'], default: 'build', index: true },

    /** Prior turns, so a follow-up knows what was already decided. */
    messages: {
      type: [
        new mongoose.Schema(
          {
            role: { type: String, enum: ['user', 'assistant'], required: true },
            content: { type: String, default: '', maxlength: 8000 },
            at: { type: Date, default: Date.now },
          },
          { _id: false }
        ),
      ],
      default: [],
    },

    timeline: { type: [eventSchema], default: [] },

    summary: { type: String, default: '', maxlength: 4000 },
    error: { type: String, default: null },

    /** Model calls the architect made — the thing its price is derived from. */
    steps: { type: Number, default: 0 },
    credits: { type: Number, default: 0 },
    cost: {
      llmPaise: { type: Number, default: 0 },
      searchPaise: { type: Number, default: 0 },
      totalPaise: { type: Number, default: 0 },
    },
    tokens: {
      prompt: { type: Number, default: 0 },
      completion: { type: Number, default: 0 },
    },
    ledgerId: { type: mongoose.Schema.Types.ObjectId, default: null },

    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

agentBuildSchema.index({ workflow: 1, createdAt: -1 });
agentBuildSchema.index({ user: 1, createdAt: -1 });

/** Builds are debugging and provenance material, not records of account. */
agentBuildSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });

agentBuildSchema.methods.toJSONSafe = function toJSONSafe() {
  return {
    id: String(this._id),
    workflowId: String(this.workflow),
    status: this.status,
    intent: this.intent,
    goal: this.goal,
    messages: this.messages,
    timeline: this.timeline,
    summary: this.summary,
    clarifyingQuestions: this.clarifyingQuestions || [],
    clarificationSatisfied: Boolean(this.clarificationSatisfied),
    error: this.error,
    steps: this.steps,
    credits: this.credits,
    startedAt: this.startedAt,
    finishedAt: this.finishedAt,
    createdAt: this.createdAt,
  };
};

const AgentBuild = mongoose.model('AgentBuild', agentBuildSchema);

export default AgentBuild;
